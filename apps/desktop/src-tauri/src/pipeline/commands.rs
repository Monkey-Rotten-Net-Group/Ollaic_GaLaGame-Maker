//! Tauri IPC adapters for the V2 Pipeline. Thin shims over the testable
//! `Pipeline` core: they translate IPC into core calls and pipe events to
//! the `pipeline:{run_id}` Tauri channel (ADR 0055). The hard logic lives in
//! `scheduler.rs` and is tested there; these commands are not unit-tested,
//! matching the codebase convention (e.g. `ai::commands`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tauri::Emitter;

use crate::pipeline::dsl::{scene_recipe, selected_recipe, setup_recipe, FlowScope};
use crate::pipeline::events::{EventSink, PipelineEvent};
use crate::pipeline::project_state::record_run_summary;
use crate::pipeline::recovery::{
    cleanup_rollback_snapshots, queue_rollback_snapshot_cleanup, rollback_snapshot_ids,
};
use crate::pipeline::registry::{ManagedRun, RunRegistry};
use crate::pipeline::run_control::RunHandle;
use crate::pipeline::scheduler::{Pipeline, RunCreation};
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
        Orchestrator {
            pipeline: Arc::new(Pipeline::with_default_agents_and_matting(
                crate::matting::commands::resolve_model_path(app),
            )),
            runs: RunRegistry::new(),
        }
    }

    /// Compute the deadline the next new Flow should use, by reading the
    /// live Provider capability from disk. Capability is NOT cached at app
    /// startup, so changing provider/model/custom `flow_step_deadline_ms`
    /// after one Flow is in flight still affects the next new Flow, while
    /// the in-flight Run keeps its creation-time snapshot.
    pub fn flow_step_timeout_for_new_run(&self) -> Option<std::time::Duration> {
        let capability = crate::ai::provider_capability::capability_for_config(
            &crate::ai::config::load_config(),
        )
        .ok()?;
        Some(capability.flow_step_timeout())
    }

    /// Validate that the live Provider capability can resolve to a bounded
    /// Step deadline. A parse failure (unknown provider, zero/excessive
    /// deadline, malformed custom declaration) must NOT silently degrade
    /// into an unbounded run; the caller must reject the Flow start so the
    /// user fixes the config rather than starting a run with no timeout.
    pub fn validate_flow_step_capability(&self) -> Result<(), String> {
        crate::ai::provider_capability::capability_for_config(&crate::ai::config::load_config())
            .map(|_| ())
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
    handle: Arc<RunHandle>,
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
    handle: Arc<RunHandle>,
    driving: Arc<AtomicBool>,
    project_path: PathBuf,
    app: tauri::AppHandle,
) {
    driving.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(drive(pipeline, handle, driving, project_path, app));
}

#[tauri::command]
pub fn pipeline_get_capabilities(orchestrator: tauri::State<'_, Orchestrator>) -> FlowCapabilities {
    FlowCapabilities {
        chat_error: if crate::ai::commands::has_agent_chat_config() {
            orchestrator.validate_flow_step_capability().err()
        } else {
            Some("未配置可用的对话模型，请在 AI 设置中填写模型和接口信息".into())
        },
        asset_error: orchestrator.pipeline.asset_capability_error(),
        reference_image_warning: {
            let config = crate::ai::config::load_image_config();
            (!crate::ai::provider_capability::supports_reference_image(&config.provider, &config.model))
                .then(|| "当前图片模型不支持参考图垫图，角色不同表情可能出现长相漂移；建议切换至 Gemini、Seedream 或 SD WebUI。".into())
        },
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowCapabilities {
    chat_error: Option<String>,
    asset_error: Option<String>,
    reference_image_warning: Option<String>,
}

#[tauri::command]
pub async fn pipeline_start(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    project_path: String,
    prompt: String,
    allow_local_fallback: Option<bool>,
    selected_step_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let recipe = selected_recipe(selected_step_ids.as_deref())?;
    if !crate::ai::commands::has_agent_chat_config() && allow_local_fallback != Some(true) {
        return Err("未配置可用的对话模型。请先配置 AI，或明确允许本地内容降级。".to_string());
    }
    // Parse failure (unknown provider, zero/excessive deadline, malformed
    // custom declaration) must not silently downgrade into an unbounded Run.
    orchestrator.validate_flow_step_capability()?;
    let project_path = PathBuf::from(project_path);
    let run_id = new_run_id();
    let sink = make_sink(&app);
    // Read the live Provider capability on every new Flow so a settings edit
    // (provider/model/custom `flow_step_deadline_ms`) takes effect immediately
    // for the next run. The in-flight run keeps its own creation-time snapshot
    // so mid-flight changes cannot shift semantics on a live step.
    let step_timeout = orchestrator.flow_step_timeout_for_new_run();
    let entry = orchestrator
        .runs
        .insert_active_with(&run_id, &project_path, || {
            let handle = orchestrator
                .pipeline
                .create_new_story_run_with_timeout(RunCreation {
                    project_path: &project_path,
                    run_id: &run_id,
                    prompt: &prompt,
                    recipe: &recipe,
                    allow_local_fallback: allow_local_fallback == Some(true),
                    step_timeout,
                    clock: &SystemClock,
                    sink: &sink,
                })
                .map_err(|error| error.to_string())?;
            Ok(ManagedRun {
                handle,
                project_path: project_path.clone(),
                driving: Arc::new(AtomicBool::new(false)),
            })
        })
        .await?;
    entry
        .handle
        .pause(&project_path, &sink, &SystemClock)
        .await
        .map_err(|e| e.to_string())?;
    Ok(run_id)
}

#[tauri::command]
pub async fn pipeline_run_setup(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    project_path: String,
    prompt: String,
    allow_local_fallback: Option<bool>,
) -> Result<String, String> {
    start_scoped_run(
        &orchestrator,
        &app,
        project_path,
        Some(prompt),
        FlowScope::Setup,
        allow_local_fallback == Some(true),
    )
    .await
}

#[tauri::command]
pub async fn pipeline_run_scene(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    project_path: String,
    scene_id: String,
    allow_local_fallback: Option<bool>,
) -> Result<String, String> {
    start_scoped_run(
        &orchestrator,
        &app,
        project_path,
        None,
        FlowScope::Scene { scene_id },
        allow_local_fallback == Some(true),
    )
    .await
}

async fn start_scoped_run(
    orchestrator: &Orchestrator,
    app: &tauri::AppHandle,
    project_path: String,
    prompt: Option<String>,
    scope: FlowScope,
    allow_local_fallback: bool,
) -> Result<String, String> {
    if !allow_local_fallback && !crate::ai::commands::has_agent_chat_config() {
        return Err("未配置可用的对话模型，请配置 AI 或允许本地内容降级。".into());
    }
    orchestrator.validate_flow_step_capability()?;
    let project = PathBuf::from(project_path);
    let prompt = match prompt {
        Some(prompt) if !prompt.trim().is_empty() => prompt,
        Some(_) => return Err("请输入制作需求".into()),
        None => {
            story_plan::load_plan(&project)
                .map_err(|error| error.to_string())?
                .ok_or("StoryPlan is missing")?
                .prompt
        }
    };
    let recipe = match scope {
        FlowScope::Setup => setup_recipe(),
        FlowScope::Scene { scene_id } => scene_recipe(scene_id),
        FlowScope::Project => return Err("expected setup or scene scope".into()),
    };
    let run_id = new_run_id();
    let sink = make_sink(app);
    let entry = orchestrator
        .runs
        .insert_active_with(&run_id, &project, || {
            let handle = orchestrator
                .pipeline
                .create_scoped_run_with_timeout(RunCreation {
                    project_path: &project,
                    run_id: &run_id,
                    prompt: &prompt,
                    recipe: &recipe,
                    allow_local_fallback,
                    step_timeout: orchestrator.flow_step_timeout_for_new_run(),
                    clock: &SystemClock,
                    sink: &sink,
                })
                .map_err(|error| error.to_string())?;
            Ok(ManagedRun {
                handle,
                project_path: project.clone(),
                driving: Arc::new(AtomicBool::new(false)),
            })
        })
        .await?;
    spawn_driver(
        orchestrator.pipeline.clone(),
        entry.handle.clone(),
        entry.driving.clone(),
        project,
        app.clone(),
    );
    Ok(run_id)
}

#[tauri::command]
pub fn pipeline_approve_scene(project_path: String, scene_id: String) -> Result<StoryPlan, String> {
    super::scene_review::approve_scene(Path::new(&project_path), &scene_id)
}

#[tauri::command]
pub fn pipeline_unlock_scene(project_path: String, scene_id: String) -> Result<StoryPlan, String> {
    super::scene_review::unlock_scene(Path::new(&project_path), &scene_id)
}

async fn attach_run_if_needed(
    orchestrator: &Orchestrator,
    project_path: &Path,
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
                project_path: project_path.to_path_buf(),
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
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    let entry = orchestrator.runs.resolve(&run_id, &requested_path).await?;
    let (handle, project_path) = (entry.handle.clone(), entry.project_path.clone());
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
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    let entry = orchestrator.runs.resolve(&run_id, &requested_path).await?;
    let (handle, project_path, driving) = (
        entry.handle.clone(),
        entry.project_path.clone(),
        entry.driving.clone(),
    );
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
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    let entry = orchestrator.runs.resolve(&run_id, &requested_path).await?;
    let (handle, project_path) = (entry.handle.clone(), entry.project_path.clone());
    handle
        .stop(&project_path, &make_sink(&app), &SystemClock)
        .await
        .map_err(|error| error.to_string())?;
    record_run_summary(&project_path, &run_id, &SystemClock).map_err(|error| error.to_string())
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
    let entry = orchestrator.runs.resolve(&run_id, &requested_path).await?;
    let (handle, project_path, driving) = (
        entry.handle.clone(),
        entry.project_path.clone(),
        entry.driving.clone(),
    );
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
    let sink = make_sink(&app);
    let entry = orchestrator
        .runs
        .with_project_activation(&run_id, &requested_path, |entry| async move {
            entry
                .handle
                .retry_step(&entry.project_path, &step_id, &sink, &SystemClock)
                .await
                .map_err(|error| error.to_string())?;
            Ok(entry)
        })
        .await?;
    let (handle, project_path, driving) = (
        entry.handle.clone(),
        entry.project_path.clone(),
        entry.driving.clone(),
    );
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
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    let sink = make_sink(&app);
    let entry = orchestrator
        .runs
        .with_project_activation(&run_id, &requested_path, |entry| async move {
            entry
                .handle
                .skip_step(&entry.project_path, &step_id, &sink, &SystemClock)
                .await
                .map_err(|error| error.to_string())?;
            Ok(entry)
        })
        .await?;
    let (handle, project_path, driving) = (
        entry.handle.clone(),
        entry.project_path.clone(),
        entry.driving.clone(),
    );
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
    project_path: String,
) -> Result<(), String> {
    let requested_path = PathBuf::from(project_path);
    let entry = orchestrator.runs.resolve(&run_id, &requested_path).await?;
    let (handle, project_path) = (entry.handle.clone(), entry.project_path.clone());
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
    let entry = orchestrator.runs.resolve(&run_id, &requested_path).await?;
    let (handle, project_path) = (entry.handle.clone(), entry.project_path.clone());
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
    if let Some(entry) = orchestrator
        .runs
        .resolve_if_present(&run_id, &requested_path)
        .await?
    {
        return entry
            .handle
            .set_pinned(&entry.project_path, pinned, &SystemClock)
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
    if let Some(entry) = orchestrator
        .runs
        .resolve_if_present(&run_id, &requested_path)
        .await?
    {
        return entry
            .handle
            .clear_history(&entry.project_path, &SystemClock)
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
    if let Some(entry) = orchestrator
        .runs
        .resolve_if_present(&run_id, &requested_path)
        .await?
    {
        let state = entry.handle.state().lock().await;
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
    project_path: String,
) -> Result<Option<RunState>, String> {
    let requested_path = PathBuf::from(project_path);
    let entry = orchestrator.runs.resolve(&run_id, &requested_path).await?;
    let state = entry.handle.state().lock().await.clone();
    Ok(Some(state))
}

#[tauri::command]
pub async fn pipeline_resume_run(
    orchestrator: tauri::State<'_, Orchestrator>,
    app: tauri::AppHandle,
    project_path: String,
    run_id: String,
) -> Result<(), String> {
    let project_path = PathBuf::from(project_path);
    let sink = make_sink(&app);
    // The registry owns the atomic crash-recovery boundary so two resumes,
    // or a resume racing a new start, cannot publish divergent live handles.
    let entry = orchestrator
        .runs
        .insert_active_with(&run_id, &project_path, || {
            let handle = orchestrator
                .pipeline
                .resume_run(&project_path, &run_id, &sink, &SystemClock)
                .map_err(|error| error.to_string())?;
            Ok(ManagedRun {
                handle,
                project_path: project_path.clone(),
                driving: Arc::new(AtomicBool::new(false)),
            })
        })
        .await?;
    spawn_driver(
        orchestrator.pipeline.clone(),
        entry.handle,
        entry.driving,
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
