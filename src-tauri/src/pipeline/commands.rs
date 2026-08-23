//! Tauri IPC adapters for the V2 Pipeline. Thin shims over the testable
//! `Pipeline` core: they translate IPC into core calls and pipe events to
//! the `pipeline:{run_id}` Tauri channel (ADR 0055). The hard logic lives in
//! `scheduler.rs` and is tested there; these commands are not unit-tested,
//! matching the codebase convention (e.g. `ai::commands`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tauri::Emitter;

use crate::pipeline::dsl::default_recipe;
use crate::pipeline::events::{EventSink, PipelineEvent};
use crate::pipeline::registry::{ManagedRun, RunRegistry};
use crate::pipeline::scheduler::{
    cleanup_rollback_snapshots, queue_rollback_snapshot_cleanup, rollback_snapshot_ids, Pipeline,
};
use crate::pipeline::state::{Clock, RunState, RunStatus, StepStatus, SystemClock};
use crate::pipeline::store;
use crate::story_plan::{self, StoryPlan};

/// Emits pipeline events to the per-run Tauri channel `pipeline:{run_id}`.
pub struct TauriEventSink {
    app: tauri::AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: PipelineEvent) {
        let channel = format!("pipeline:{}", event.run_id());
        let _ = self.app.emit(&channel, event);
    }
}

fn make_sink(app: &tauri::AppHandle) -> TauriEventSink {
    TauriEventSink { app: app.clone() }
}

/// Tauri-managed state: the pipeline plus its active runs.
pub struct Orchestrator {
    pipeline: Arc<Pipeline>,
    runs: RunRegistry,
}

impl Orchestrator {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let flow_step_timeout = crate::ai::config::load_config()
            .and_then(|config| crate::ai::provider_capability::capability_for_config(&config))
            .map(|capability| std::time::Duration::from_millis(capability.flow_step_deadline_ms))
            .unwrap_or_else(|_| std::time::Duration::from_secs(180));
        Orchestrator {
            pipeline: Arc::new(
                Pipeline::with_default_agents_and_matting(
                    crate::matting::commands::resolve_model_path(app),
                )
                .with_step_timeout(flow_step_timeout),
            ),
            runs: RunRegistry::new(),
        }
    }
}

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

fn new_run_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let n = RUN_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("run_{}_{}", now, n)
}

/// Drive a run to completion (or pause). Clears `driving` when done.
async fn drive(
    pipeline: Arc<Pipeline>,
    handle: Arc<crate::pipeline::scheduler::RunHandle>,
    driving: Arc<AtomicBool>,
    project_path: PathBuf,
    app: tauri::AppHandle,
) {
    let sink = make_sink(&app);
    pipeline
        .execute(&project_path, handle, &sink, &SystemClock)
        .await;
    driving.store(false, Ordering::SeqCst);
}

fn spawn_driver(
    pipeline: Arc<Pipeline>,
    handle: Arc<crate::pipeline::scheduler::RunHandle>,
    driving: Arc<AtomicBool>,
    project_path: PathBuf,
    app: tauri::AppHandle,
) {
    driving.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(drive(pipeline, handle, driving, project_path, app));
}

#[tauri::command]
pub async fn pipeline_start(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    project_path: String,
    prompt: String,
    allow_local_fallback: Option<bool>,
) -> Result<String, String> {
    if !crate::ai::commands::has_agent_chat_config() && allow_local_fallback != Some(true) {
        return Err("未配置可用的对话模型。请先配置 AI，或明确允许本地内容降级。".to_string());
    }
    let project_path = PathBuf::from(project_path);
    if super::scheduler::project_has_story_content(&project_path)? {
        return Err(
            "项目已有故事内容；请使用 AI 聊天的可审阅 patch 工作流修改，Agent Flow 仅用于新建故事。"
                .to_string(),
        );
    }
    let run_id = new_run_id();
    let recipe = default_recipe();
    let sink = make_sink(&app);
    let handle = orchestrator
        .pipeline
        .create_run_with_options(
            &project_path,
            &run_id,
            &prompt,
            &recipe,
            allow_local_fallback == Some(true),
            &SystemClock,
            &sink,
        )
        .map_err(|e| e.to_string())?;
    handle
        .pause(&project_path, &sink, &SystemClock)
        .await
        .map_err(|e| e.to_string())?;
    let driving = Arc::new(AtomicBool::new(false));
    orchestrator
        .runs
        .insert(
            run_id.clone(),
            ManagedRun {
                handle: handle.clone(),
                project_path: project_path.clone(),
                driving: driving.clone(),
            },
        )
        .await;
    Ok(run_id)
}

async fn with_run<F, R>(orchestrator: &Orchestrator, run_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&ManagedRun) -> Result<R, String>,
{
    let entry = orchestrator
        .runs
        .get(run_id)
        .await
        .ok_or_else(|| format!("run not found: {}", run_id))?;
    f(&entry)
}

async fn attach_run_if_needed(
    orchestrator: &Orchestrator,
    project_path: &PathBuf,
    run_id: &str,
) -> Result<(), String> {
    orchestrator
        .runs
        .attach_if_needed(run_id, project_path, || {
            let handle = orchestrator
                .pipeline
                .attach_run(project_path, run_id, &SystemClock)
                .map_err(|error| error.to_string())?;
            Ok(ManagedRun {
                handle,
                project_path: project_path.clone(),
                driving: Arc::new(AtomicBool::new(false)),
            })
        })
        .await
}

#[tauri::command]
pub async fn pipeline_pause(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    run_id: String,
) -> Result<(), String> {
    let (handle, project_path) = with_run(&orchestrator, &run_id, |e| {
        Ok((e.handle.clone(), e.project_path.clone()))
    })
    .await?;
    handle
        .pause(&project_path, &make_sink(&app), &SystemClock)
        .await
        .map_err(|e| e.to_string())
}

/// Unpause a run that is live in memory. After an app restart (no live
/// driver), the frontend must instead call `pipeline_resume_run` to reload
/// the persisted run and start a fresh driver.
#[tauri::command]
pub async fn pipeline_resume(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    run_id: String,
) -> Result<(), String> {
    let (handle, project_path, driving) = with_run(&orchestrator, &run_id, |e| {
        Ok((e.handle.clone(), e.project_path.clone(), e.driving.clone()))
    })
    .await?;
    handle
        .resume(&project_path, &make_sink(&app), &SystemClock)
        .await
        .map_err(|e| e.to_string())?;
    if driving
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        spawn_driver(
            orchestrator.pipeline.clone(),
            handle,
            driving,
            project_path,
            app,
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn pipeline_stop(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    run_id: String,
) -> Result<(), String> {
    let (handle, project_path) = with_run(&orchestrator, &run_id, |entry| {
        Ok((entry.handle.clone(), entry.project_path.clone()))
    })
    .await?;
    handle
        .stop(&project_path, &make_sink(&app), &SystemClock)
        .await
        .map_err(|error| error.to_string())?;
    orchestrator
        .pipeline
        .record_run_summary(&project_path, &run_id, &SystemClock)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pipeline_step_once(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    run_id: String,
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    attach_run_if_needed(&orchestrator, &requested_path, &run_id).await?;
    let (handle, project_path, driving) = with_run(&orchestrator, &run_id, |entry| {
        Ok((
            entry.handle.clone(),
            entry.project_path.clone(),
            entry.driving.clone(),
        ))
    })
    .await?;
    handle
        .step_once(&project_path, &make_sink(&app), &SystemClock)
        .await
        .map_err(|error| error.to_string())?;
    if driving
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        spawn_driver(
            orchestrator.pipeline.clone(),
            handle,
            driving,
            project_path,
            app,
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn pipeline_retry_step(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    run_id: String,
    step_id: String,
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    attach_run_if_needed(&orchestrator, &requested_path, &run_id).await?;
    let (handle, project_path, driving) = {
        let entry = orchestrator
            .runs
            .get(&run_id)
            .await
            .ok_or_else(|| format!("run not found: {}", run_id))?;
        (
            entry.handle.clone(),
            entry.project_path.clone(),
            entry.driving.clone(),
        )
    };
    handle
        .retry_step(&project_path, &step_id, &make_sink(&app), &SystemClock)
        .await
        .map_err(|e| e.to_string())?;
    // Atomically claim the driver role. If a driver is already running
    // (incl. paused-and-waiting), it picks up the retried step via the notify
    // sent by retry_step. Otherwise the run was terminal and we start one.
    if driving
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        spawn_driver(
            orchestrator.pipeline.clone(),
            handle,
            driving,
            project_path,
            app,
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn pipeline_skip_step(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    run_id: String,
    step_id: String,
) -> Result<(), String> {
    let (handle, project_path, driving) = {
        let entry = orchestrator
            .runs
            .get(&run_id)
            .await
            .ok_or_else(|| format!("run not found: {}", run_id))?;
        (
            entry.handle.clone(),
            entry.project_path.clone(),
            entry.driving.clone(),
        )
    };
    handle
        .skip_step(&project_path, &step_id, &make_sink(&app), &SystemClock)
        .await
        .map_err(|e| e.to_string())?;
    if driving
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        spawn_driver(
            orchestrator.pipeline.clone(),
            handle,
            driving,
            project_path,
            app,
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn pipeline_update_dependencies(
    orchestrator: tauri::State<'_, Orchestrator>,
    run_id: String,
    step_id: String,
    depends_on: Vec<String>,
) -> Result<(), String> {
    let (handle, project_path) = with_run(&orchestrator, &run_id, |entry| {
        Ok((entry.handle.clone(), entry.project_path.clone()))
    })
    .await?;
    handle
        .update_dependencies(&project_path, &step_id, depends_on, &SystemClock)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pipeline_update_step_prompt(
    orchestrator: tauri::State<'_, Orchestrator>,
    run_id: String,
    step_id: String,
    prompt: String,
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    attach_run_if_needed(&orchestrator, &requested_path, &run_id).await?;
    let (handle, project_path) = with_run(&orchestrator, &run_id, |entry| {
        Ok((entry.handle.clone(), entry.project_path.clone()))
    })
    .await?;
    handle
        .update_step_prompt(&project_path, &step_id, prompt, &SystemClock)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pipeline_set_run_pinned(
    orchestrator: tauri::State<'_, Orchestrator>,
    run_id: String,
    pinned: bool,
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    if let Some((handle, project_path)) = orchestrator
        .runs
        .get(&run_id)
        .await
        .map(|entry| (entry.handle.clone(), entry.project_path.clone()))
    {
        return handle
            .set_pinned(&project_path, pinned, &SystemClock)
            .await
            .map_err(|error| error.to_string());
    }
    let mut state = store::load_run_state(&requested_path, &run_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("run not found: {}", run_id))?;
    state.pinned = pinned;
    state.updated_at = SystemClock.now_ms();
    store::save_run_state(&requested_path, &state).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pipeline_clear_run_history(
    orchestrator: tauri::State<'_, Orchestrator>,
    run_id: String,
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    if let Some((handle, project_path)) = orchestrator
        .runs
        .get(&run_id)
        .await
        .map(|entry| (entry.handle.clone(), entry.project_path.clone()))
    {
        return handle
            .clear_history(&project_path, &SystemClock)
            .await
            .map_err(|error| error.to_string());
    }
    let mut state = store::load_run_state(&requested_path, &run_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("run not found: {}", run_id))?;
    if state.status == RunStatus::Running
        || state
            .steps
            .iter()
            .any(|step| step.status == StepStatus::Running)
    {
        return Err("pause and finish the active step before clearing history".to_string());
    }
    let snapshots = rollback_snapshot_ids(&state);
    queue_rollback_snapshot_cleanup(&mut state, snapshots);
    for step in &mut state.steps {
        step.history.clear();
    }
    state.updated_at = SystemClock.now_ms();
    store::save_run_state(&requested_path, &state).map_err(|error| error.to_string())?;
    cleanup_rollback_snapshots(&requested_path, &mut state).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pipeline_export_run_history(
    orchestrator: tauri::State<'_, Orchestrator>,
    run_id: String,
    project_path: String,
) -> Result<String, String> {
    let requested_path = PathBuf::from(project_path);
    if let Some(handle) = orchestrator
        .runs
        .get(&run_id)
        .await
        .map(|entry| entry.handle.clone())
    {
        let state = handle.state().lock().await;
        return serde_json::to_string_pretty(&*state).map_err(|error| error.to_string());
    }
    let state = store::load_run_state(&requested_path, &run_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("run not found: {}", run_id))?;
    serde_json::to_string_pretty(&state).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pipeline_get_state(
    orchestrator: tauri::State<'_, Orchestrator>,
    run_id: String,
) -> Result<Option<RunState>, String> {
    let handle = with_run(&orchestrator, &run_id, |e| Ok(e.handle.clone())).await?;
    let state = handle.state().lock().await.clone();
    Ok(Some(state))
}

#[tauri::command]
pub async fn pipeline_resume_run(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    project_path: String,
    run_id: String,
) -> Result<(), String> {
    // Crash-recovery entry point: load a persisted run from disk and drive
    // it. Refuse if the run is already in memory (use pipeline_resume to
    // unpause a live run) - otherwise two drivers would race on the same
    // logical run with divergent in-memory state copies.
    if orchestrator.runs.contains(&run_id).await {
        return Err(format!(
            "run {} is already in memory; use pipeline_resume to unpause it",
            run_id
        ));
    }
    let project_path = PathBuf::from(project_path);
    let sink = make_sink(&app);
    let handle = orchestrator
        .pipeline
        .resume_run(&project_path, &run_id, &sink, &SystemClock)
        .map_err(|e| e.to_string())?;
    let driving = Arc::new(AtomicBool::new(false));
    orchestrator
        .runs
        .insert(
            run_id.clone(),
            ManagedRun {
                handle: handle.clone(),
                project_path: project_path.clone(),
                driving: driving.clone(),
            },
        )
        .await;
    spawn_driver(
        orchestrator.pipeline.clone(),
        handle,
        driving,
        project_path,
        app,
    );
    Ok(())
}

#[tauri::command]
pub async fn pipeline_get_plan(project_path: String) -> Result<Option<StoryPlan>, String> {
    story_plan::load_plan(&PathBuf::from(project_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pipeline_list_runs(project_path: String) -> Result<Vec<RunState>, String> {
    crate::pipeline::store::list_run_states(&PathBuf::from(project_path)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_ids_are_unique() {
        let a = new_run_id();
        let b = new_run_id();
        assert_ne!(a, b);
        assert!(a.starts_with("run_"));
    }
}
