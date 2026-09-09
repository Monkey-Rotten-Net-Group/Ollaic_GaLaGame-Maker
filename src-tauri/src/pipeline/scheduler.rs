//! Pipeline Orchestrator (V2 section 3.1). Schedules Flow Steps in dependency
//! order, persists after each transition, emits events through `EventSink`,
//! and updates the StoryPlan as steps produce output. The Tauri adapter
//! (commands.rs) wraps this testable core.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use tokio::sync::{Mutex, Notify};

use crate::agents::{AgentContext, AgentError, AgentOutput, AgentRegistry};
use crate::asset_queue::{
    AssetGenerator, AssetKind, AssetTask, AssetTaskStatus, GeneratedArtifact,
};
use crate::pipeline::dsl::{FlowRecipe, StepKind};
use crate::pipeline::events::{EventSink, PipelineEvent};
use crate::pipeline::state::{Clock, RunState, RunStatus, StepRunHistory, StepStatus};
use crate::pipeline::store;
use crate::project_transaction::ProjectFileTransaction;
use crate::story_plan::types::PipelineRunSummary;
use crate::story_plan::{self, StoryPlan};

/// Shared, lockable handle to a running (or paused) run. The scheduler and
/// the pause/resume/retry/skip commands all reach the run through this.
pub struct RunHandle {
    pub state: Arc<Mutex<RunState>>,
    notify: Arc<Notify>,
    cancel_notify: Arc<Notify>,
    pause_after_step: AtomicBool,
    cancelled: Arc<AtomicBool>,
    asset_binding_gate: Arc<Mutex<()>>,
}

impl RunHandle {
    pub async fn stop(
        &self,
        project_path: &Path,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let _binding_guard = self.asset_binding_gate.lock().await;
        let mut state = self.state.lock().await;
        if state.status.is_terminal() {
            return Ok(());
        }
        let previous = state.clone();
        let stopped_at = clock.now_ms();
        for step in &mut state.steps {
            if step.status == StepStatus::Running {
                step.status = StepStatus::Pending;
                step.started_at = None;
                step.finished_at = None;
                if let Some(attempt) = step.history.last_mut() {
                    attempt.error = Some("cancelled before completion".to_string());
                    attempt.finished_at = Some(stopped_at);
                    attempt.duration_ms = Some(stopped_at.saturating_sub(attempt.started_at));
                }
            }
        }
        state.status = RunStatus::Cancelled;
        state.updated_at = stopped_at;
        let run_id = state.run_id.clone();
        if let Err(error) = store::save_run_state(project_path, &state) {
            *state = previous;
            return Err(PipelineError::Store(error));
        }
        drop(state);
        self.pause_after_step.store(false, Ordering::SeqCst);
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_one();
        self.cancel_notify.notify_waiters();
        sink.emit(PipelineEvent::RunStopped { run_id });
        Ok(())
    }

    pub fn state(&self) -> &Arc<Mutex<RunState>> {
        &self.state
    }
}

enum Action {
    /// Run the step with this id, kind, and resolved prompt.
    Run {
        id: String,
        kind: StepKind,
        prompt: String,
    },
    /// Nothing left to do this iteration.
    Idle,
}

/// The testable orchestrator core.
pub struct Pipeline {
    agents: AgentRegistry,
    figure_matting_model: Result<std::path::PathBuf, String>,
    step_timeout: Duration,
}

const DEFAULT_PROVIDER_STEP_TIMEOUT: Duration = Duration::from_secs(180);

struct ConfiguredAssetGenerator {
    local_fallback: bool,
    cancelled: Arc<AtomicBool>,
    figure_matting_model: Result<std::path::PathBuf, String>,
}

impl AssetGenerator for ConfiguredAssetGenerator {
    fn preflight(&self, task: &AssetTask) -> Result<(), String> {
        if self.local_fallback {
            return Ok(());
        }
        let (config, capability) = match task.kind {
            AssetKind::Background | AssetKind::Figure => {
                (crate::ai::config::load_image_config()?, "图片")
            }
            AssetKind::Tts => (crate::ai::config::load_tts_config()?, "音频"),
            AssetKind::Bgm | AssetKind::Sfx => (crate::ai::config::load_music_config()?, "音乐"),
        };
        crate::ai::commands::validate_provider_config_basics(&config, capability)?;
        configured_model(&config.model)?;
        if matches!(task.kind, AssetKind::Bgm | AssetKind::Sfx)
            && config.provider.trim() == "custom"
            && config.base_url.trim().is_empty()
        {
            return Err("自定义音乐端点未填写 Base URL".to_string());
        }
        Ok(())
    }

    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(crate::asset_queue::scheduler::ASSET_QUEUE_CANCELLED.to_string());
            }
            // Tests must not hit the network: generation is deterministic
            // placeholder output. Production still tries the provider and falls
            // back to a placeholder only on error (or when local fallback was
            // explicitly authorized).
            if cfg!(test) {
                return Ok(local_placeholder(task.kind));
            }
            let result = generate_configured_asset(task, &self.figure_matting_model).await;
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(crate::asset_queue::scheduler::ASSET_QUEUE_CANCELLED.to_string());
            }
            match result {
                Ok(artifact) => Ok(artifact),
                Err(_) if self.local_fallback => Ok(local_placeholder(task.kind)),
                Err(error) => Err(error),
            }
        })
    }
}

async fn generate_configured_asset(
    task: &AssetTask,
    figure_matting_model: &Result<std::path::PathBuf, String>,
) -> Result<GeneratedArtifact, String> {
    let media = match task.kind {
        AssetKind::Background | AssetKind::Figure => {
            let config = crate::ai::config::load_image_config()?;
            crate::ai::commands::generate_image_media(
                None,
                task.prompt.clone(),
                configured_model(&config.model)?,
                None,
            )
            .await?
        }
        AssetKind::Tts => {
            let config = crate::ai::config::load_tts_config()?;
            crate::ai::commands::generate_tts_media(
                task.text.clone().unwrap_or_default(),
                task.prompt.clone(),
                configured_model(&config.model)?,
                "mp3".to_string(),
            )
            .await?
        }
        AssetKind::Bgm | AssetKind::Sfx => {
            let config = crate::ai::config::load_music_config()?;
            crate::ai::commands::generate_music_media(
                task.prompt.clone(),
                configured_model(&config.model)?,
                "mp3".to_string(),
            )
            .await?
        }
    };
    let encoded = media
        .base64_data
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(media.base64_data.as_str());
    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("failed to decode generated media: {error}"))?;
    let mut extension = media.extension;
    if task.kind == AssetKind::Figure {
        let model_path = figure_matting_model.clone()?;
        bytes = tokio::task::spawn_blocking(move || {
            matte_figure_bytes(bytes, |source| {
                crate::matting::commands::matte_image(&model_path, source)
            })
        })
        .await
        .map_err(|error| format!("figure matting task failed: {error}"))??;
        extension = "png".to_string();
    }
    Ok(GeneratedArtifact {
        extension,
        bytes,
        used_local_fallback: false,
    })
}

fn configured_model(value: &str) -> Result<String, String> {
    value
        .split(',')
        .map(str::trim)
        .find(|model| !model.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "asset provider has no configured model".to_string())
}

pub(crate) fn project_has_story_content(project_path: &Path) -> Result<bool, String> {
    if story_plan::load_plan(project_path)
        .map_err(|error| error.to_string())?
        .is_some_and(|plan| {
            !plan.synopsis.trim().is_empty()
                || !plan.memory.worldbook.trim().is_empty()
                || !plan.memory.glossary.is_empty()
                || !plan.chapters.is_empty()
                || !plan.characters.is_empty()
                || !plan.scene_plans.is_empty()
                || !plan.scene_drafts.is_empty()
                || !plan.asset_plan.is_empty()
                || !plan.scenes.is_empty()
        })
    {
        return Ok(true);
    }

    let characters_path = project_path.join("game/config/characters.json");
    if characters_path.is_file()
        && !crate::characters::commands::list_characters(
            project_path.to_string_lossy().into_owned(),
        )?
        .is_empty()
    {
        return Ok(true);
    }

    let scene_dir = project_path.join("game/scene");
    let entries = match std::fs::read_dir(&scene_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("failed to read {}: {error}", scene_dir.display())),
    };
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("txt") {
            continue;
        }
        let source = std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        if crate::webgal::parser::parse_script(&source)
            .iter()
            .any(|node| node.cmd_type != crate::webgal::types::CommandType::Comment)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn matte_figure_bytes(
    bytes: Vec<u8>,
    matte: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    matte(&bytes)
}

#[cfg(test)]
mod figure_postprocess_tests {
    use super::matte_figure_bytes;

    #[test]
    fn generated_figure_uses_matting_output() {
        let output = matte_figure_bytes(b"opaque source".to_vec(), |source| {
            assert_eq!(source, b"opaque source");
            Ok(b"transparent png".to_vec())
        })
        .unwrap();
        assert_eq!(output, b"transparent png");
        assert_eq!(
            matte_figure_bytes(b"opaque source".to_vec(), |_| Err("matting failed".into()))
                .unwrap_err(),
            "matting failed"
        );
    }
}

fn local_placeholder(kind: AssetKind) -> GeneratedArtifact {
    if kind == AssetKind::Figure {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([0, 0, 0, 0]),
        ))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("embedded transparent placeholder is encodable");
        return GeneratedArtifact {
            extension: "png".to_string(),
            bytes: bytes.into_inner(),
            used_local_fallback: true,
        };
    }
    if kind == AssetKind::Background {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XfP7WQAAAABJRU5ErkJggg==")
            .expect("embedded placeholder png is valid");
        return GeneratedArtifact {
            extension: "png".to_string(),
            bytes,
            used_local_fallback: true,
        };
    }
    let mut bytes = b"RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\0\0\0\0".to_vec();
    bytes.truncate(44);
    GeneratedArtifact {
        extension: "wav".to_string(),
        bytes,
        used_local_fallback: true,
    }
}

impl Pipeline {
    pub fn new(agents: AgentRegistry) -> Self {
        Pipeline {
            agents,
            figure_matting_model: Err("figure matting model is not configured".to_string()),
            step_timeout: DEFAULT_PROVIDER_STEP_TIMEOUT,
        }
    }

    pub fn with_default_agents() -> Self {
        Self::new(AgentRegistry::with_defaults())
    }

    pub fn with_default_agents_and_matting(
        figure_matting_model: Result<std::path::PathBuf, String>,
    ) -> Self {
        Self {
            agents: AgentRegistry::with_defaults(),
            figure_matting_model,
            step_timeout: DEFAULT_PROVIDER_STEP_TIMEOUT,
        }
    }

    /// Cap each step's agent run with a timeout; on expiry the step fails and
    /// the run terminates as `RunStatus::Timeout` instead of hanging forever.
    pub fn with_step_timeout(mut self, timeout: Duration) -> Self {
        self.step_timeout = timeout;
        self
    }

    #[cfg(test)]
    pub(crate) fn step_timeout(&self) -> Duration {
        self.step_timeout
    }

    /// Create + persist a run, emit `RunStarted`, return a handle set to
    /// `Running`. Ensures a StoryPlan exists. Does NOT execute.
    pub fn create_run(
        &self,
        project_path: &Path,
        run_id: &str,
        prompt: &str,
        recipe: &FlowRecipe,
        clock: &dyn Clock,
        sink: &dyn EventSink,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        self.create_run_with_options(project_path, run_id, prompt, recipe, false, clock, sink)
    }

    pub fn create_run_with_options(
        &self,
        project_path: &Path,
        run_id: &str,
        prompt: &str,
        recipe: &FlowRecipe,
        allow_local_fallback: bool,
        clock: &dyn Clock,
        sink: &dyn EventSink,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        recipe.validate().map_err(PipelineError::RecipeInvalid)?;
        // Validate or create the IR before writing any run state. An invalid
        // plan must not leave an orphan run that later bypasses validation.
        let previous_plan = story_plan::load_plan(project_path).map_err(PipelineError::Plan)?;
        match previous_plan.clone() {
            Some(mut next) => {
                next.prompt = prompt.to_string();
                story_plan::save_plan(project_path, &next).map_err(PipelineError::Plan)?;
            }
            None => {
                let plan = StoryPlan::new(prompt);
                story_plan::save_plan(project_path, &plan).map_err(PipelineError::Plan)?;
            }
        }
        let mut state = RunState::new(run_id, project_path, prompt, recipe, clock.now_ms());
        state.status = RunStatus::Running;
        state.allow_local_fallback = allow_local_fallback;
        if let Err(error) = store::save_run_state(project_path, &state) {
            if let Some(previous) = previous_plan {
                story_plan::save_plan(project_path, &previous).map_err(PipelineError::Plan)?;
            } else {
                story_plan::remove_plan(project_path).map_err(PipelineError::Plan)?;
            }
            return Err(PipelineError::Store(error));
        }

        sink.emit(PipelineEvent::RunStarted {
            run_id: run_id.to_string(),
        });
        Ok(Arc::new(RunHandle {
            state: Arc::new(Mutex::new(state)),
            notify: Arc::new(Notify::new()),
            cancel_notify: Arc::new(Notify::new()),
            pause_after_step: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            asset_binding_gate: Arc::new(Mutex::new(())),
        }))
    }

    /// Resume a run from its persisted state (after a crash or app restart).
    /// Loads the run, marks it `Running`, emits `RunResumed`. The caller then
    /// calls `execute`. Already-succeeded steps are not re-run.
    pub fn resume_run(
        &self,
        project_path: &Path,
        run_id: &str,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        if story_plan::load_plan(project_path)
            .map_err(PipelineError::Plan)?
            .is_none()
        {
            return Err(PipelineError::PlanMissing);
        }
        let mut state = store::load_run_state(project_path, run_id)
            .map_err(PipelineError::Store)?
            .ok_or(PipelineError::RunNotFound(run_id.to_string()))?;
        if state.status.is_terminal() {
            return Err(PipelineError::InvalidRunTransition(
                run_id.to_string(),
                "terminal runs cannot be resumed".to_string(),
            ));
        }
        restore_interrupted_outputs(project_path, &state)?;
        // Crash recovery: a step left `Running` when the process died did not
        // complete, so reset it to `Pending` to be re-run. `Succeeded` steps
        // are never re-run.
        for step in &mut state.steps {
            if step.status == StepStatus::Running {
                let interrupted_at = clock.now_ms();
                if let Some(attempt) = step.history.last_mut() {
                    attempt.error = Some("interrupted before completion".to_string());
                    attempt.finished_at = Some(interrupted_at);
                    attempt.duration_ms = Some(interrupted_at.saturating_sub(attempt.started_at));
                }
                step.status = StepStatus::Pending;
                step.started_at = None;
                step.output = None;
            }
        }
        state.status = RunStatus::Running;
        state.updated_at = clock.now_ms();
        store::save_run_state(project_path, &state).map_err(PipelineError::Store)?;
        sink.emit(PipelineEvent::RunResumed {
            run_id: run_id.to_string(),
        });
        Ok(Arc::new(RunHandle {
            state: Arc::new(Mutex::new(state)),
            notify: Arc::new(Notify::new()),
            cancel_notify: Arc::new(Notify::new()),
            pause_after_step: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            asset_binding_gate: Arc::new(Mutex::new(())),
        }))
    }

    /// Attach a persisted run without driving it. Non-terminal snapshots are
    /// normalized to a paused, resumable state because no live driver exists.
    pub fn attach_run(
        &self,
        project_path: &Path,
        run_id: &str,
        clock: &dyn Clock,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        if story_plan::load_plan(project_path)
            .map_err(PipelineError::Plan)?
            .is_none()
        {
            return Err(PipelineError::PlanMissing);
        }
        let mut state = store::load_run_state(project_path, run_id)
            .map_err(PipelineError::Store)?
            .ok_or(PipelineError::RunNotFound(run_id.to_string()))?;
        let mut changed = false;
        if !state.status.is_terminal() {
            restore_interrupted_outputs(project_path, &state)?;
            let interrupted_at = clock.now_ms();
            for step in &mut state.steps {
                if step.status == StepStatus::Running {
                    if let Some(attempt) = step.history.last_mut() {
                        attempt.error = Some("interrupted before completion".to_string());
                        attempt.finished_at = Some(interrupted_at);
                        attempt.duration_ms =
                            Some(interrupted_at.saturating_sub(attempt.started_at));
                    }
                    step.status = StepStatus::Pending;
                    step.started_at = None;
                    step.output = None;
                    changed = true;
                }
            }
            if state.status == RunStatus::Running {
                state.status = RunStatus::Paused;
                changed = true;
            }
            if changed {
                state.updated_at = interrupted_at;
                store::save_run_state(project_path, &state).map_err(PipelineError::Store)?;
            }
        }
        Ok(Arc::new(RunHandle {
            state: Arc::new(Mutex::new(state)),
            notify: Arc::new(Notify::new()),
            cancel_notify: Arc::new(Notify::new()),
            pause_after_step: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            asset_binding_gate: Arc::new(Mutex::new(())),
        }))
    }

    /// Drive the run: pick ready steps in dependency order, run their agent,
    /// update state + plan, persist after each transition, emit events.
    /// Returns when the run is `Completed`, `Failed`, or `Paused`.
    pub async fn execute(
        &self,
        project_path: &Path,
        handle: Arc<RunHandle>,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) {
        loop {
            // Wait here while paused, until resume() notifies.
            {
                let state = handle.state.lock().await;
                if state.status.is_terminal() {
                    return;
                }
                if state.status == RunStatus::Paused {
                    drop(state);
                    handle.notify.notified().await;
                    continue;
                }
            }

            let action = self.next_action(project_path, &handle, sink, clock).await;
            match action {
                // `Idle` means either terminal (the run completed/failed) or a
                // transient pause observed between the top-of-loop check and
                // the lock. Either way, loop: the top check returns on terminal
                // and waits on pause.
                Action::Idle => continue,
                Action::Run { id, kind, prompt } => {
                    self.run_step(project_path, &handle, sink, clock, id, kind, prompt)
                        .await;
                    if handle.pause_after_step.swap(false, Ordering::SeqCst) {
                        let should_pause = {
                            let state = handle.state.lock().await;
                            !state.status.is_terminal() && !state.is_complete()
                        };
                        if should_pause {
                            if let Err(error) = handle.pause(project_path, sink, clock).await {
                                let mut state = handle.state.lock().await;
                                state.status = RunStatus::Failed;
                                state.updated_at = clock.now_ms();
                                let run_id = state.run_id.clone();
                                let _ = store::save_run_state(project_path, &state);
                                drop(state);
                                sink.emit(PipelineEvent::RunFailed {
                                    run_id,
                                    error: format!(
                                        "failed to persist single-step pause: {}",
                                        error
                                    ),
                                });
                                return;
                            }
                        }
                    }
                }
            }
        }
    }

    async fn next_action(
        &self,
        project_path: &Path,
        handle: &Arc<RunHandle>,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Action {
        let mut state = handle.state.lock().await;
        if state.status.is_terminal() || state.status == RunStatus::Paused {
            return Action::Idle;
        }
        match state.next_ready_step_id() {
            Some(id) => {
                let run_id = state.run_id.clone();
                let retain_all_history = state.pinned;
                let (kind, prompt, removed_snapshots) = {
                    let step = state.find_step_mut(&id).expect("ready step exists");
                    let prompt = step.def.prompt.clone();
                    let started_at = clock.now_ms();
                    step.status = StepStatus::Running;
                    step.attempt += 1;
                    step.started_at = Some(started_at);
                    step.finished_at = None;
                    let removed_snapshots = step.record_attempt(
                        StepRunHistory {
                            attempt: step.attempt,
                            input_snapshot: prompt.clone(),
                            output: None,
                            error: None,
                            started_at,
                            finished_at: None,
                            duration_ms: None,
                            diff: None,
                            cost: None,
                            prompt_tokens: None,
                            completion_tokens: None,
                            warnings: Vec::new(),
                            downgrade: None,
                            rollback_snapshot: None,
                        },
                        retain_all_history,
                    );
                    (step.def.kind, prompt, removed_snapshots)
                };
                queue_rollback_snapshot_cleanup(&mut state, removed_snapshots);
                state.updated_at = clock.now_ms();
                if let Err(err) = store::save_run_state(project_path, &state) {
                    let error = format!("failed to persist step transition: {}", err);
                    if let Some(step) = state.find_step_mut(&id) {
                        let finished_at = clock.now_ms();
                        step.status = StepStatus::Failed;
                        step.error = Some(error.clone());
                        step.finished_at = Some(finished_at);
                        if let Some(attempt) = step.history.last_mut() {
                            attempt.error = Some(error.clone());
                            attempt.finished_at = Some(finished_at);
                            attempt.duration_ms =
                                Some(finished_at.saturating_sub(attempt.started_at));
                        }
                    }
                    state.status = RunStatus::Failed;
                    let run_id = state.run_id.clone();
                    drop(state);
                    sink.emit(PipelineEvent::RunFailed { run_id, error });
                    return Action::Idle;
                }
                if let Err(error) = cleanup_rollback_snapshots(project_path, &mut state) {
                    if let Some(attempt) = state
                        .find_step_mut(&id)
                        .and_then(|step| step.history.last_mut())
                    {
                        attempt.warnings.push(error.to_string());
                    }
                    let _ = store::save_run_state(project_path, &state);
                }
                drop(state);
                sink.emit(PipelineEvent::StepStarted {
                    run_id: run_id.clone(),
                    step_id: id.clone(),
                    kind: kind.as_str().to_string(),
                });
                Action::Run { id, kind, prompt }
            }
            None => {
                if state.is_complete() {
                    state.status = RunStatus::Completed;
                    state.updated_at = clock.now_ms();
                    let run_id = state.run_id.clone();
                    if let Err(err) = store::save_run_state(project_path, &state) {
                        state.status = RunStatus::Failed;
                        let run_id = state.run_id.clone();
                        drop(state);
                        sink.emit(PipelineEvent::RunFailed {
                            run_id,
                            error: format!("failed to persist run completion: {}", err),
                        });
                        return Action::Idle;
                    }
                    drop(state);
                    sink.emit(PipelineEvent::RunCompleted {
                        run_id: run_id.clone(),
                    });
                    let _ = self.record_run_summary(project_path, &run_id, clock);
                    Action::Idle
                } else {
                    let error = "flow blocked: a dependency failed or is missing".to_string();
                    state.status = RunStatus::Failed;
                    state.updated_at = clock.now_ms();
                    let run_id = state.run_id.clone();
                    let _ = store::save_run_state(project_path, &state);
                    drop(state);
                    sink.emit(PipelineEvent::RunFailed {
                        run_id,
                        error: error.clone(),
                    });
                    Action::Idle
                }
            }
        }
    }

    async fn run_step(
        &self,
        project_path: &Path,
        handle: &Arc<RunHandle>,
        sink: &dyn EventSink,
        clock: &dyn Clock,
        id: String,
        kind: StepKind,
        prompt: String,
    ) {
        // Load the plan to build the agent context.
        let mut plan = match story_plan::load_plan(project_path) {
            Ok(Some(plan)) => plan,
            Ok(None) => {
                self.fail_step(
                    project_path,
                    handle,
                    sink,
                    clock,
                    id,
                    "StoryPlan is missing".to_string(),
                )
                .await;
                return;
            }
            Err(error) => {
                self.fail_step(
                    project_path,
                    handle,
                    sink,
                    clock,
                    id,
                    format!("failed to load StoryPlan: {}", error),
                )
                .await;
                return;
            }
        };
        let characters_path = project_path.join("game/config/characters.json");
        if characters_path.is_file() {
            match crate::characters::commands::list_characters(
                project_path.to_string_lossy().to_string(),
            ) {
                Ok(characters) => {
                    apply_canonical_characters(&mut plan, characters, kind == StepKind::Character);
                }
                Err(error) => {
                    self.fail_step(
                        project_path,
                        handle,
                        sink,
                        clock,
                        id,
                        format!("failed to load canonical characters: {}", error),
                    )
                    .await;
                    return;
                }
            }
        }

        let (production_brief, allow_local_fallback) = {
            let state = handle.state.lock().await;
            (
                state.prompt.clone(),
                state.allow_local_fallback || cfg!(test),
            )
        };
        let input_snapshot = serde_json::json!({
            "productionBrief": &production_brief,
            "stepInstruction": &prompt,
            "synopsis": &plan.synopsis,
            "storyPlanRef": ".ollaic/plan.json",
            "worldbookChars": plan.memory.worldbook.chars().count(),
            "glossaryTerms": plan.memory.glossary.keys().collect::<Vec<_>>(),
            "chapters": plan.chapters.iter().map(|chapter| &chapter.id).collect::<Vec<_>>(),
            "characters": plan.characters.iter().map(|character| &character.id).collect::<Vec<_>>(),
            "scenePlans": plan.scene_plans.iter().map(|scene| &scene.id).collect::<Vec<_>>(),
            "sceneDraftCount": plan.scene_drafts.len(),
            "assetTaskCount": plan.asset_plan.len(),
        })
        .to_string();
        let snapshot_result = {
            let mut state = handle.state.lock().await;
            if let Some(attempt) = state
                .find_step_mut(&id)
                .and_then(|step| step.history.last_mut())
            {
                attempt.input_snapshot = input_snapshot;
            }
            state.updated_at = clock.now_ms();
            store::save_run_state(project_path, &state)
        };
        if let Err(error) = snapshot_result {
            self.fail_step(
                project_path,
                handle,
                sink,
                clock,
                id,
                format!("failed to persist step input snapshot: {}", error),
            )
            .await;
            return;
        }

        let ctx = AgentContext {
            prompt: &production_brief,
            instruction: &prompt,
            synopsis: &plan.synopsis,
            chapters: &plan.chapters,
            worldbook: &plan.memory.worldbook,
            glossary: &plan.memory.glossary,
            characters: &plan.characters,
            scene_plans: &plan.scene_plans,
            branches: &plan.branches,
            scene_drafts: &plan.scene_drafts,
            asset_plan: &plan.asset_plan,
            allow_local_fallback,
        };
        let agent_key = {
            let state = handle.state.lock().await;
            state.find_step(&id).and_then(|step| step.def.agent.clone())
        };
        let mut asset_output_transaction = None;
        let result = if agent_key.as_deref() == Some("assetQueue") {
            let run_id = handle.state.lock().await.run_id.clone();
            let generator = Arc::new(ConfiguredAssetGenerator {
                local_fallback: allow_local_fallback,
                cancelled: handle.cancelled.clone(),
                figure_matting_model: self.figure_matting_model.clone(),
            });
            match crate::asset_queue::run_queue_cancellable_transactional(
                project_path,
                &run_id,
                &plan,
                generator,
                handle.cancelled.clone(),
                handle.asset_binding_gate.clone(),
            )
            .await
            {
                Ok(run) => {
                    let queue = run.queue;
                    asset_output_transaction = Some(run.transaction);
                    let failed = queue
                        .tasks
                        .iter()
                        .filter(|task| task.status == AssetTaskStatus::Failed)
                        .count();
                    if failed == 0 {
                        let downgraded = queue.tasks.iter().any(|task| {
                            task.status == AssetTaskStatus::Succeeded && task.used_local_fallback
                        });
                        let pending_configuration = queue
                            .tasks
                            .iter()
                            .filter(|task| {
                                task.status == AssetTaskStatus::Pending
                                    && task.error.as_deref().is_some_and(|error| {
                                        error.starts_with("pending configuration:")
                                    })
                            })
                            .count();
                        let mut warnings = downgraded
                            .then(|| "部分媒体供应商不可用，已生成本地占位素材".to_string())
                            .into_iter()
                            .collect::<Vec<_>>();
                        if pending_configuration > 0 {
                            warnings
                                .push(format!("{pending_configuration} 个媒体任务等待供应商配置"));
                        }
                        Ok(AgentOutput {
                            asset_queue: serde_json::to_value(queue).ok(),
                            warnings,
                            downgrade: downgraded
                                .then(|| "local-placeholder-assets".to_string())
                                .or_else(|| {
                                    (pending_configuration > 0)
                                        .then(|| "media-capability-pending".to_string())
                                }),
                            ..AgentOutput::default()
                        })
                    } else {
                        Err(AgentError(format!(
                            "asset queue finished with {failed} failed task(s)"
                        )))
                    }
                }
                Err(error) => Err(AgentError(error)),
            }
        } else {
            match self.agents.get(kind, agent_key.as_deref()) {
                Some(agent) => {
                    let timeout_sleep = tokio::time::sleep(self.step_timeout);
                    tokio::select! {
                        result = agent.run(&ctx) => result,
                        _ = timeout_sleep => {
                            self.fail_step_timeout(project_path, handle, sink, clock, id, self.step_timeout)
                                .await;
                            return;
                        }
                        _ = handle.cancel_notify.notified() => {
                            // stop() aborted the run: drop the in-flight agent
                            // future and return without applying anything.
                            return;
                        }
                    }
                }
                None => Err(AgentError(format!(
                    "no agent registered for step kind '{}'",
                    kind.as_str()
                ))),
            }
        };
        match result {
            Ok(out) => {
                // Crash-safety order: apply output to the plan and persist it
                // BEFORE marking the step Succeeded. If the process dies between
                // these two writes, the step is left Running and reset to Pending
                // on resume, then re-run. Every output replaces its owned IR
                // partition, so replaying an LLM attempt is idempotent at the
                // project boundary.
                let mut state = handle.state.lock().await;
                if state.status == RunStatus::Cancelled
                    || state.find_step(&id).map(|step| step.status) != Some(StepStatus::Running)
                {
                    if let Some(transaction) = asset_output_transaction.as_mut() {
                        let _ = transaction.rollback();
                    }
                    return;
                }
                // Keep stop() outside the two durable writes: cancellation
                // takes effect either before output or after a full commit.
                let previous_plan = plan.clone();
                apply_output(&mut plan, &out);
                if let Err(error) = story_plan::validate(&plan) {
                    let asset_rollback = asset_output_transaction
                        .as_mut()
                        .map(ProjectFileTransaction::rollback)
                        .unwrap_or(Ok(()));
                    drop(state);
                    self.fail_step(
                        project_path,
                        handle,
                        sink,
                        clock,
                        id,
                        format!(
                            "Agent output produced an invalid StoryPlan: {}{}",
                            error,
                            rollback_suffix(asset_rollback)
                        ),
                    )
                    .await;
                    return;
                }
                if let Some(snapshot_id) =
                    match create_rollback_snapshot(project_path, &state.run_id, &id, &out) {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            let asset_rollback = asset_output_transaction
                                .as_mut()
                                .map(ProjectFileTransaction::rollback)
                                .unwrap_or(Ok(()));
                            drop(state);
                            self.fail_step(
                                project_path,
                                handle,
                                sink,
                                clock,
                                id,
                                format!("{}{}", error.0, rollback_suffix(asset_rollback)),
                            )
                            .await;
                            return;
                        }
                    }
                {
                    if let Some(attempt) = state
                        .find_step_mut(&id)
                        .and_then(|step| step.history.last_mut())
                    {
                        attempt.rollback_snapshot = Some(snapshot_id.clone());
                    }
                    state.updated_at = clock.now_ms();
                    if let Err(error) = store::save_run_state(project_path, &state) {
                        let _ = crate::webgal::project::delete_project_snapshot(
                            project_path.to_string_lossy().to_string(),
                            snapshot_id,
                        );
                        let asset_rollback = asset_output_transaction
                            .as_mut()
                            .map(ProjectFileTransaction::rollback)
                            .unwrap_or(Ok(()));
                        drop(state);
                        self.fail_step(
                            project_path,
                            handle,
                            sink,
                            clock,
                            id,
                            format!(
                                "failed to persist rollback snapshot: {}{}",
                                error,
                                rollback_suffix(asset_rollback)
                            ),
                        )
                        .await;
                        return;
                    }
                }
                let mut output_transaction =
                    match OutputTransaction::apply(project_path, &out, &plan) {
                        Ok(transaction) => transaction,
                        Err(error) => {
                            let asset_rollback = asset_output_transaction
                                .as_mut()
                                .map(ProjectFileTransaction::rollback)
                                .unwrap_or(Ok(()));
                            drop(state);
                            self.fail_step(
                                project_path,
                                handle,
                                sink,
                                clock,
                                id,
                                format!("{}{}", error.0, rollback_suffix(asset_rollback)),
                            )
                            .await;
                            return;
                        }
                    };
                if let Err(error) = story_plan::save_plan(project_path, &plan) {
                    let rollback = output_transaction.rollback();
                    let asset_rollback = asset_output_transaction
                        .as_mut()
                        .map(ProjectFileTransaction::rollback)
                        .unwrap_or(Ok(()));
                    drop(state);
                    self.fail_step(
                        project_path,
                        handle,
                        sink,
                        clock,
                        id,
                        format!(
                            "failed to save StoryPlan: {}{}{}",
                            error,
                            rollback_suffix(rollback),
                            rollback_suffix(asset_rollback)
                        ),
                    )
                    .await;
                    return;
                }
                if let Some(transaction) = asset_output_transaction.as_mut() {
                    if let Err(error) = transaction.prepare_commit() {
                        let rollback = output_transaction.rollback();
                        let asset_rollback = transaction.rollback();
                        let plan_rollback = story_plan::save_plan(project_path, &previous_plan)
                            .map_err(|error| error.to_string());
                        drop(state);
                        self.fail_step(
                            project_path,
                            handle,
                            sink,
                            clock,
                            id,
                            format!(
                                "failed to prepare asset transaction: {}{}{}{}",
                                error,
                                rollback_suffix(rollback),
                                rollback_suffix(asset_rollback),
                                rollback_suffix(plan_rollback)
                            ),
                        )
                        .await;
                        return;
                    }
                }
                {
                    let step = state.find_step_mut(&id).expect("step exists");
                    let finished_at = clock.now_ms();
                    let output = serialize_output(&out);
                    step.status = StepStatus::Succeeded;
                    step.finished_at = Some(finished_at);
                    step.output = Some(output.clone());
                    if let Some(attempt) = step.history.last_mut() {
                        attempt.output = Some(output);
                        attempt.finished_at = Some(finished_at);
                        attempt.duration_ms = Some(finished_at.saturating_sub(attempt.started_at));
                        attempt.diff = Some(describe_output(&out));
                        attempt.prompt_tokens = out.prompt_tokens;
                        attempt.completion_tokens = out.completion_tokens;
                        attempt.warnings = out.warnings.clone();
                        attempt.downgrade = out.downgrade.clone();
                    }
                }
                state.updated_at = clock.now_ms();
                let run_id = state.run_id.clone();
                let output_ref = state.find_step(&id).expect("step exists").output.clone();
                if let Err(err) = store::save_run_state(project_path, &state) {
                    let rollback = output_transaction.rollback();
                    let asset_rollback = asset_output_transaction
                        .as_mut()
                        .map(ProjectFileTransaction::rollback)
                        .unwrap_or(Ok(()));
                    let plan_rollback = story_plan::save_plan(project_path, &previous_plan)
                        .map_err(|error| error.to_string());
                    let error = format!(
                        "failed to persist step success: {}{}{}{}",
                        err,
                        rollback_suffix(rollback),
                        rollback_suffix(asset_rollback),
                        rollback_suffix(plan_rollback)
                    );
                    if let Some(step) = state.find_step_mut(&id) {
                        step.status = StepStatus::Failed;
                        step.error = Some(error.clone());
                        if let Some(attempt) = step.history.last_mut() {
                            attempt.error = Some(error.clone());
                        }
                    }
                    state.status = RunStatus::Failed;
                    let run_id = state.run_id.clone();
                    drop(state);
                    sink.emit(PipelineEvent::StepFailed {
                        run_id: run_id.clone(),
                        step_id: id,
                        error: error.clone(),
                    });
                    sink.emit(PipelineEvent::RunFailed { run_id, error });
                    return;
                }
                output_transaction.commit();
                if let Some(transaction) = asset_output_transaction.take() {
                    transaction.commit();
                }
                drop(state);
                sink.emit(PipelineEvent::StepSucceeded {
                    run_id,
                    step_id: id,
                    output: output_ref,
                });
            }
            Err(err) => {
                let asset_rollback = asset_output_transaction
                    .as_mut()
                    .map(ProjectFileTransaction::rollback)
                    .unwrap_or(Ok(()));
                self.fail_step(
                    project_path,
                    handle,
                    sink,
                    clock,
                    id,
                    format!("{}{}", err.0, rollback_suffix(asset_rollback)),
                )
                .await
            }
        }
    }

    async fn fail_step(
        &self,
        project_path: &Path,
        handle: &Arc<RunHandle>,
        sink: &dyn EventSink,
        clock: &dyn Clock,
        step_id: String,
        error: String,
    ) {
        self.fail_step_with_status(project_path, handle, sink, clock, step_id, error, RunStatus::Failed)
            .await;
    }

    async fn fail_step_timeout(
        &self,
        project_path: &Path,
        handle: &Arc<RunHandle>,
        sink: &dyn EventSink,
        clock: &dyn Clock,
        step_id: String,
        timeout: Duration,
    ) {
        let error = format!("step timed out after {:?}", timeout);
        self.fail_step_with_status(project_path, handle, sink, clock, step_id, error, RunStatus::Timeout)
            .await;
    }

    async fn fail_step_with_status(
        &self,
        project_path: &Path,
        handle: &Arc<RunHandle>,
        sink: &dyn EventSink,
        clock: &dyn Clock,
        step_id: String,
        error: String,
        status: RunStatus,
    ) {
        let mut state = handle.state.lock().await;
        if state.status == RunStatus::Cancelled
            || state.find_step(&step_id).map(|step| step.status) != Some(StepStatus::Running)
        {
            return;
        }
        let finished_at = clock.now_ms();
        if let Some(step) = state.find_step_mut(&step_id) {
            step.status = StepStatus::Failed;
            step.error = Some(error.clone());
            step.finished_at = Some(finished_at);
            if let Some(attempt) = step.history.last_mut() {
                attempt.error = Some(error.clone());
                attempt.finished_at = Some(finished_at);
                attempt.duration_ms = Some(finished_at.saturating_sub(attempt.started_at));
            }
        }
        state.status = status;
        state.updated_at = finished_at;
        let run_id = state.run_id.clone();
        let _ = store::save_run_state(project_path, &state);
        drop(state);
        sink.emit(PipelineEvent::StepFailed {
            run_id: run_id.clone(),
            step_id,
            error: error.clone(),
        });
        sink.emit(PipelineEvent::RunFailed {
            run_id: run_id.clone(),
            error,
        });
        let _ = self.record_run_summary(project_path, &run_id, clock);
    }

    pub(crate) fn record_run_summary(
        &self,
        project_path: &Path,
        run_id: &str,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let state = store::load_run_state(project_path, run_id)
            .map_err(PipelineError::Store)?
            .ok_or_else(|| PipelineError::RunNotFound(run_id.to_string()))?;
        let mut plan = story_plan::load_plan(project_path)
            .map_err(PipelineError::Plan)?
            .unwrap_or_else(|| StoryPlan::new(""));
        let summary = PipelineRunSummary {
            run_id: run_id.to_string(),
            status: format!("{:?}", state.status).to_lowercase(),
            started_at: state.started_at,
            updated_at: clock.now_ms(),
        };
        plan.pipeline_runs.retain(|r| r.run_id != summary.run_id);
        plan.pipeline_runs.push(summary);
        story_plan::save_plan(project_path, &plan).map_err(PipelineError::Plan)
    }
}

/// Apply an agent's output to the in-memory StoryPlan.
fn apply_output(plan: &mut StoryPlan, out: &AgentOutput) {
    if let Some(synopsis) = &out.synopsis {
        plan.synopsis = synopsis.clone();
        plan.memory = Default::default();
        clear_after_memory(plan);
    }
    if let Some(worldbook) = &out.worldbook {
        plan.memory.worldbook = worldbook.clone();
        plan.memory.glossary = out.glossary.clone().unwrap_or_default();
        clear_after_memory(plan);
    } else if let Some(glossary) = &out.glossary {
        plan.memory.glossary = glossary.clone();
    }
    if let Some(chapters) = &out.chapters {
        plan.chapters = chapters.clone();
        plan.scene_plans = out.scene_plans.clone().unwrap_or_default();
        plan.branches = out.branches.clone().unwrap_or_default();
        plan.characters.clear();
        plan.scene_drafts.clear();
        plan.asset_plan.clear();
        plan.scenes.clear();
    }
    if let Some(characters) = &out.characters {
        reconcile_scene_casts(&mut plan.scene_plans, characters);
        plan.characters = characters.clone();
        plan.scene_drafts.clear();
        plan.asset_plan.clear();
        plan.scenes.clear();
    }
    if let Some(drafts) = &out.scene_drafts {
        merge_scene_casts_from_drafts(&mut plan.scene_plans, drafts);
        plan.scene_drafts = drafts.clone();
        plan.asset_plan.clear();
        plan.scenes.clear();
    }
    if let Some(asset_plan) = &out.asset_plan {
        plan.asset_plan = asset_plan.clone();
        plan_figure_sprites(&mut plan.characters, asset_plan);
        plan.scenes.clear();
    }
    if let Some(scenes) = &out.scenes {
        plan.scenes = scenes.iter().map(|scene| scene.name.clone()).collect();
    }
}

fn plan_figure_sprites(
    characters: &mut [crate::characters::types::Character],
    asset_plan: &[crate::story_plan::AssetTaskPlan],
) {
    for task in asset_plan.iter().filter(|task| task.kind == "figure") {
        let (Some(character_ref), Some(emotion)) =
            (task.character_ref.as_deref(), task.emotion.as_deref())
        else {
            continue;
        };
        let Some(character) = characters
            .iter_mut()
            .find(|character| character.id == character_ref || character.name == character_ref)
        else {
            continue;
        };
        if let Some(sprite) = character
            .sprites
            .iter_mut()
            .find(|sprite| sprite.emotion.eq_ignore_ascii_case(emotion))
        {
            if sprite.prompt.as_deref().is_none_or(str::is_empty) {
                sprite.prompt = Some(task.prompt.clone());
            }
        } else {
            character
                .sprites
                .push(crate::characters::types::CharacterSprite {
                    emotion: emotion.to_string(),
                    file: String::new(),
                    prompt: Some(task.prompt.clone()),
                });
        }
    }
}

fn apply_canonical_characters(
    plan: &mut StoryPlan,
    characters: Vec<crate::characters::types::Character>,
    preserve_scene_cast: bool,
) {
    if !preserve_scene_cast {
        let ids: HashSet<&str> = characters
            .iter()
            .map(|character| character.id.as_str())
            .collect();
        for scene in &mut plan.scene_plans {
            scene.character_ids.retain(|id| ids.contains(id.as_str()));
        }
    }
    plan.characters = characters;
}

fn reconcile_scene_casts(
    scenes: &mut [crate::story_plan::ScenePlan],
    characters: &[crate::characters::types::Character],
) {
    for scene in scenes {
        let mut seen = HashSet::new();
        scene.character_ids = scene
            .character_ids
            .iter()
            .filter_map(|reference| {
                characters
                    .iter()
                    .find(|character| {
                        matches_character_reference(reference, &character.id)
                            || matches_character_reference(reference, &character.name)
                            || character
                                .aliases
                                .iter()
                                .any(|alias| matches_character_reference(reference, alias))
                    })
                    .map(|character| character.id.clone())
            })
            .filter(|character| seen.insert(character.clone()))
            .collect();
    }
}

fn matches_character_reference(reference: &str, candidate: &str) -> bool {
    reference == candidate || reference.eq_ignore_ascii_case(candidate)
}

fn merge_scene_casts_from_drafts(
    scenes: &mut [crate::story_plan::ScenePlan],
    drafts: &[crate::story_plan::SceneDraft],
) {
    for scene in scenes {
        let Some(draft) = drafts.iter().find(|draft| draft.scene_id == scene.id) else {
            continue;
        };
        for character_id in draft
            .beats
            .iter()
            .flat_map(|beat| &beat.figure_cues)
            .map(|cue| &cue.character_id)
        {
            if !scene.character_ids.contains(character_id) {
                scene.character_ids.push(character_id.clone());
            }
        }
    }
}

#[cfg(test)]
mod character_cast_tests {
    use super::*;

    #[test]
    fn character_output_reconciles_provisional_scene_cast_names() {
        let mut plan = StoryPlan::new("test");
        plan.scene_plans = vec![crate::story_plan::ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: String::new(),
            character_ids: vec!["艾拉".into(), "洛因".into()],
        }];
        let characters = serde_json::from_value(serde_json::json!([
            {"id":"ailla","name":"艾拉"},
            {"id":"luoyin","name":"洛因"}
        ]))
        .unwrap();

        apply_output(
            &mut plan,
            &AgentOutput {
                characters: Some(characters),
                ..AgentOutput::default()
            },
        );

        assert_eq!(plan.scene_plans[0].character_ids, vec!["ailla", "luoyin"]);
    }

    #[test]
    fn character_output_reconciles_provisional_id_case() {
        let mut plan = StoryPlan::new("test");
        plan.scene_plans = vec![crate::story_plan::ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: String::new(),
            character_ids: vec!["Erin".into(), "Xiaoqi".into()],
        }];
        let characters = serde_json::from_value(serde_json::json!([
            {"id":"erin","name":"艾琳"},
            {"id":"xiaoqi","name":"小七"}
        ]))
        .unwrap();

        apply_output(
            &mut plan,
            &AgentOutput {
                characters: Some(characters),
                ..AgentOutput::default()
            },
        );

        assert_eq!(plan.scene_plans[0].character_ids, vec!["erin", "xiaoqi"]);
    }

    #[test]
    fn unresolved_provisional_cast_uses_empty_cast_recovery() {
        let mut scenes = vec![crate::story_plan::ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: String::new(),
            character_ids: vec!["Erin".into()],
        }];
        let characters: Vec<crate::characters::types::Character> =
            serde_json::from_value(serde_json::json!([
                {"id":"aila","name":"艾拉"}
            ]))
            .unwrap();

        reconcile_scene_casts(&mut scenes, &characters);

        assert!(scenes[0].character_ids.is_empty());
    }

    #[test]
    fn character_step_keeps_provisional_cast_when_old_config_is_loaded() {
        let mut plan = StoryPlan::new("test");
        plan.scene_plans = vec![crate::story_plan::ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: String::new(),
            character_ids: vec!["艾拉".into(), "洛因".into()],
        }];
        let old_characters = serde_json::from_value(serde_json::json!([
            {"id":"old","name":"旧角色"}
        ]))
        .unwrap();

        apply_canonical_characters(&mut plan, old_characters, true);

        assert_eq!(plan.scene_plans[0].character_ids, vec!["艾拉", "洛因"]);
    }

    #[test]
    fn dialogist_output_merges_staged_character_into_scene_cast() {
        let mut plan = StoryPlan::new("test");
        plan.scene_plans = vec![crate::story_plan::ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: String::new(),
            character_ids: vec!["erin".into()],
        }];
        let draft = serde_json::from_value(serde_json::json!({
            "sceneId": "opening",
            "beats": [{
                "text": "艾拉走入画面。",
                "figureCues": [{
                    "action": "show", "characterId": "viper",
                    "position": "left", "emotion": "default"
                }]
            }]
        }))
        .unwrap();

        apply_output(
            &mut plan,
            &AgentOutput {
                scene_drafts: Some(vec![draft]),
                ..AgentOutput::default()
            },
        );

        assert_eq!(plan.scene_plans[0].character_ids, vec!["erin", "viper"]);
    }

    #[test]
    fn asset_plan_persists_missing_character_sprite_slots() {
        let project = std::env::temp_dir().join("ollaic_planned_sprite_slot");
        let _ = std::fs::remove_dir_all(&project);
        let mut plan = StoryPlan::new("test");
        plan.characters = serde_json::from_value(serde_json::json!([{
            "id": "alice", "name": "Alice", "sprites": []
        }]))
        .unwrap();
        let output = AgentOutput {
            asset_plan: Some(vec![crate::story_plan::AssetTaskPlan {
                id: "figure_alice_happy".into(),
                kind: "figure".into(),
                target_stem: "alice_happy".into(),
                prompt: "happy Alice".into(),
                scene_ref: None,
                character_ref: Some("alice".into()),
                emotion: Some("happy".into()),
                status: "pending".into(),
            }]),
            ..AgentOutput::default()
        };

        apply_output(&mut plan, &output);
        OutputTransaction::apply(&project, &output, &plan)
            .unwrap()
            .commit();

        assert_eq!(plan.characters[0].sprites[0].emotion, "happy");
        assert_eq!(plan.characters[0].sprites[0].file, "");
        assert_eq!(
            plan.characters[0].sprites[0].prompt.as_deref(),
            Some("happy Alice")
        );
        let persisted =
            crate::characters::commands::list_characters(project.to_string_lossy().into_owned())
                .unwrap();
        assert_eq!(persisted[0].sprites[0], plan.characters[0].sprites[0]);
        let _ = std::fs::remove_dir_all(project);
    }
}

fn clear_after_memory(plan: &mut StoryPlan) {
    plan.chapters.clear();
    plan.characters.clear();
    plan.scene_plans.clear();
    plan.branches = Default::default();
    plan.scene_drafts.clear();
    plan.asset_plan.clear();
    plan.scenes.clear();
}

struct OutputTransaction {
    backups: Vec<(std::path::PathBuf, Option<Vec<u8>>)>,
}

impl OutputTransaction {
    fn apply(project_path: &Path, out: &AgentOutput, plan: &StoryPlan) -> Result<Self, AgentError> {
        let mut writes: Vec<(std::path::PathBuf, Vec<u8>)> = Vec::new();
        if out.characters.is_some() || out.asset_plan.is_some() {
            let document = crate::characters::types::CharactersDocument {
                version: 1,
                characters: plan.characters.clone(),
            };
            let bytes = serde_json::to_vec_pretty(&document)
                .map_err(|error| AgentError(format!("failed to serialize characters: {error}")))?;
            writes.push((project_path.join("game/config/characters.json"), bytes));
        }
        if let Some(scenes) = &out.scenes {
            writes.extend(scenes.iter().map(|scene| {
                (
                    project_path.join("game/scene").join(&scene.name),
                    scene.content.as_bytes().to_vec(),
                )
            }));
        }

        let mut transaction = Self {
            backups: Vec::new(),
        };
        for (path, bytes) in writes {
            let previous = match std::fs::read(&path) {
                Ok(content) => Some(content),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    let rollback = transaction.rollback();
                    return Err(AgentError(format!(
                        "failed to snapshot output '{}': {}{}",
                        path.display(),
                        error,
                        rollback_suffix(rollback)
                    )));
                }
            };
            transaction.backups.push((path.clone(), previous));
            if let Some(parent) = path.parent() {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    let rollback = transaction.rollback();
                    return Err(AgentError(format!(
                        "failed to create output directory '{}': {}{}",
                        parent.display(),
                        error,
                        rollback_suffix(rollback)
                    )));
                }
            }
            if let Err(error) = crate::json_store::write_crash_safe(&path, &bytes) {
                let rollback = transaction.rollback();
                return Err(AgentError(format!(
                    "failed to write output '{}': {}{}",
                    path.display(),
                    error,
                    rollback_suffix(rollback)
                )));
            }
        }
        Ok(transaction)
    }

    fn rollback(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, previous) in self.backups.iter().rev() {
            let result = match previous {
                Some(content) => crate::json_store::write_crash_safe(path, content)
                    .map_err(|error| error.to_string()),
                None if path.exists() => {
                    std::fs::remove_file(path).map_err(|error| error.to_string())
                }
                None => Ok(()),
            };
            if let Err(error) = result {
                errors.push(format!("{}: {}", path.display(), error));
            }
        }
        self.backups.clear();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join(", "))
        }
    }

    fn commit(mut self) {
        self.backups.clear();
    }
}

fn rollback_suffix(result: Result<(), String>) -> String {
    result
        .err()
        .map(|error| format!("; rollback failed: {error}"))
        .unwrap_or_default()
}

fn create_rollback_snapshot(
    project_path: &Path,
    run_id: &str,
    step_id: &str,
    out: &AgentOutput,
) -> Result<Option<String>, AgentError> {
    if out.characters.is_none() && out.asset_plan.is_none() && out.scenes.is_none() {
        return Ok(None);
    }
    std::fs::create_dir_all(project_path.join("game"))
        .map_err(|error| AgentError(format!("failed to prepare project snapshot: {error}")))?;
    crate::webgal::project::create_project_snapshot(
        project_path.to_string_lossy().to_string(),
        Some(format!("Agent {} {}", run_id, step_id)),
        Some("auto".to_string()),
        Some("Automatic rollback point before an Agent Flow writes playable files".to_string()),
    )
    .map(|snapshot| Some(snapshot.id))
    .map_err(|error| AgentError(format!("failed to create rollback snapshot: {error}")))
}

fn restore_interrupted_outputs(project_path: &Path, state: &RunState) -> Result<(), PipelineError> {
    for snapshot_id in state
        .steps
        .iter()
        .filter(|step| step.status == StepStatus::Running)
        .filter_map(|step| step.history.last()?.rollback_snapshot.as_deref())
    {
        crate::webgal::project::restore_project_snapshot(
            project_path.to_string_lossy().to_string(),
            snapshot_id.to_string(),
        )
        .map_err(|error| {
            PipelineError::Recovery(format!(
                "failed to restore rollback snapshot {}: {}",
                snapshot_id, error
            ))
        })?;
    }
    Ok(())
}

fn serialize_output(out: &AgentOutput) -> String {
    let value = serde_json::json!({
        "synopsis": out.synopsis,
        "worldbook": out.worldbook.as_deref().map(|text| text.chars().take(500).collect::<String>()),
        "glossary": out.glossary,
        "chapters": out.chapters,
        "characters": out.characters.as_ref().map(|characters| characters.iter().map(|character| serde_json::json!({
            "id": character.id,
            "name": character.name,
        })).collect::<Vec<_>>()),
        "scenePlans": out.scene_plans,
        "branches": out.branches,
        "sceneDrafts": out.scene_drafts.as_ref().map(|drafts| drafts.iter().map(|draft| serde_json::json!({
            "sceneId": draft.scene_id,
            "title": draft.title,
            "beatCount": draft.beats.len(),
            "excerpt": draft.beats.first().map(|beat| &beat.text),
        })).collect::<Vec<_>>()),
        "assetPlan": out.asset_plan,
        "assetQueue": out.asset_queue,
        "scenes": out.scenes.as_ref().map(|scenes| scenes.iter().map(|scene| serde_json::json!({
            "name": scene.name,
            "contentRef": format!("game/scene/{}", scene.name),
        })).collect::<Vec<_>>()),
        "model": out.model,
        "promptTokens": out.prompt_tokens,
        "completionTokens": out.completion_tokens,
        "warnings": out.warnings,
        "downgrade": out.downgrade,
    });
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

fn describe_output(out: &AgentOutput) -> String {
    let mut changed = Vec::new();
    if out.synopsis.is_some() {
        changed.push("synopsis".to_string());
    }
    if out.worldbook.is_some() {
        changed.push("memory".to_string());
    }
    if let Some(chapters) = &out.chapters {
        changed.push(format!("chapters:{}", chapters.len()));
    }
    if let Some(characters) = &out.characters {
        changed.push(format!("characters:{}", characters.len()));
    }
    if let Some(drafts) = &out.scene_drafts {
        changed.push(format!("sceneDrafts:{}", drafts.len()));
    }
    if let Some(assets) = &out.asset_plan {
        changed.push(format!("assetPlan:{}", assets.len()));
    }
    if let Some(queue) = &out.asset_queue {
        let succeeded = queue["tasks"]
            .as_array()
            .map(|tasks| {
                tasks
                    .iter()
                    .filter(|task| task["status"] == "succeeded")
                    .count()
            })
            .unwrap_or(0);
        changed.push(format!("assetQueue:{} succeeded", succeeded));
    }
    if let Some(scenes) = &out.scenes {
        changed.push(format!("sceneFiles:{}", scenes.len()));
    }
    format!("StoryPlan updated: {}", changed.join(", "))
}

impl RunHandle {
    pub async fn pause(
        &self,
        project_path: &Path,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let mut state = self.state.lock().await;
        if state.status != RunStatus::Running {
            return Ok(());
        }
        let previous_updated_at = state.updated_at;
        state.status = RunStatus::Paused;
        state.updated_at = clock.now_ms();
        let run_id = state.run_id.clone();
        if let Err(error) = store::save_run_state(project_path, &state) {
            state.status = RunStatus::Running;
            state.updated_at = previous_updated_at;
            return Err(PipelineError::Store(error));
        }
        drop(state);
        sink.emit(PipelineEvent::RunPaused { run_id });
        Ok(())
    }

    pub async fn resume(
        &self,
        project_path: &Path,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        {
            let mut state = self.state.lock().await;
            if state.status != RunStatus::Paused {
                return Ok(());
            }
            state.status = RunStatus::Running;
            state.updated_at = clock.now_ms();
            let run_id = state.run_id.clone();
            store::save_run_state(project_path, &state).map_err(PipelineError::Store)?;
            drop(state);
            sink.emit(PipelineEvent::RunResumed { run_id });
        }
        self.notify.notify_one();
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub async fn step_once(
        &self,
        project_path: &Path,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let mut state = self.state.lock().await;
        if state.status != RunStatus::Paused {
            return Err(PipelineError::InvalidRunTransition(
                state.run_id.clone(),
                "single-step requires a paused run".to_string(),
            ));
        }
        let previous_updated_at = state.updated_at;
        state.status = RunStatus::Running;
        state.updated_at = clock.now_ms();
        let run_id = state.run_id.clone();
        self.pause_after_step.store(true, Ordering::SeqCst);
        if let Err(error) = store::save_run_state(project_path, &state) {
            state.status = RunStatus::Paused;
            state.updated_at = previous_updated_at;
            self.pause_after_step.store(false, Ordering::SeqCst);
            return Err(PipelineError::Store(error));
        }
        drop(state);
        sink.emit(PipelineEvent::RunResumed { run_id });
        self.notify.notify_one();
        Ok(())
    }

    /// Reset a step and everything downstream so the scheduler re-runs a
    /// coherent suffix of the DAG without repeating completed upstream work.
    pub async fn retry_step(
        &self,
        project_path: &Path,
        step_id: &str,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let resumed;
        let run_id;
        {
            let mut state = self.state.lock().await;
            let target = state
                .find_step(step_id)
                .ok_or_else(|| PipelineError::StepNotFound(step_id.to_string()))?;
            if target.status == StepStatus::Running {
                return Err(PipelineError::InvalidStepTransition(
                    step_id.to_string(),
                    "cannot retry a running step".to_string(),
                ));
            }
            let mut reset = HashSet::from([step_id.to_string()]);
            loop {
                let before = reset.len();
                for step in &state.steps {
                    if step.def.depends_on.iter().any(|dep| reset.contains(dep)) {
                        reset.insert(step.def.id.clone());
                    }
                }
                if reset.len() == before {
                    break;
                }
            }
            for step in &mut state.steps {
                if reset.contains(&step.def.id) {
                    step.status = StepStatus::Pending;
                    step.error = None;
                    step.output = None;
                    step.started_at = None;
                    step.finished_at = None;
                }
            }
            resumed = state.status != RunStatus::Running;
            if resumed {
                state.status = RunStatus::Running;
            }
            state.updated_at = clock.now_ms();
            run_id = state.run_id.clone();
            store::save_run_state(project_path, &state).map_err(PipelineError::Store)?;
        }
        if resumed {
            sink.emit(PipelineEvent::RunResumed { run_id });
        }
        self.cancelled.store(false, Ordering::SeqCst);
        self.notify.notify_one();
        Ok(())
    }

    /// Mark a step `Skipped`; downstream steps whose only dep is this one
    /// become ready. A skipped optional step keeps the flow moving.
    pub async fn skip_step(
        &self,
        project_path: &Path,
        step_id: &str,
        sink: &dyn EventSink,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let run_id;
        {
            let mut state = self.state.lock().await;
            let step = state
                .find_step_mut(step_id)
                .ok_or_else(|| PipelineError::StepNotFound(step_id.to_string()))?;
            if step.status != StepStatus::Pending {
                return Err(PipelineError::InvalidStepTransition(
                    step_id.to_string(),
                    "only pending steps can be skipped".to_string(),
                ));
            }
            step.status = StepStatus::Skipped;
            step.error = None;
            step.finished_at = Some(clock.now_ms());
            if state.status == RunStatus::Failed {
                state.status = RunStatus::Running;
            }
            state.updated_at = clock.now_ms();
            run_id = state.run_id.clone();
            store::save_run_state(project_path, &state).map_err(PipelineError::Store)?;
        }
        sink.emit(PipelineEvent::StepSkipped {
            run_id,
            step_id: step_id.to_string(),
        });
        self.notify.notify_one();
        Ok(())
    }

    pub async fn update_dependencies(
        &self,
        project_path: &Path,
        step_id: &str,
        depends_on: Vec<String>,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let mut state = self.state.lock().await;
        let step = state
            .find_step(step_id)
            .ok_or_else(|| PipelineError::StepNotFound(step_id.to_string()))?;
        if step.status != StepStatus::Pending {
            return Err(PipelineError::InvalidStepTransition(
                step_id.to_string(),
                "only pending step dependencies can be edited".to_string(),
            ));
        }
        let mut recipe = FlowRecipe {
            steps: state.steps.iter().map(|step| step.def.clone()).collect(),
        };
        recipe
            .steps
            .iter_mut()
            .find(|step| step.id == step_id)
            .expect("step was checked above")
            .depends_on = depends_on;
        recipe.validate().map_err(PipelineError::RecipeInvalid)?;
        state.find_step_mut(step_id).expect("step exists").def = recipe
            .steps
            .into_iter()
            .find(|step| step.id == step_id)
            .expect("validated recipe contains step");
        state.updated_at = clock.now_ms();
        store::save_run_state(project_path, &state).map_err(PipelineError::Store)
    }

    pub async fn update_step_prompt(
        &self,
        project_path: &Path,
        step_id: &str,
        prompt: String,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let mut state = self.state.lock().await;
        let step = state
            .find_step_mut(step_id)
            .ok_or_else(|| PipelineError::StepNotFound(step_id.to_string()))?;
        if step.status == StepStatus::Running {
            return Err(PipelineError::InvalidStepTransition(
                step_id.to_string(),
                "cannot edit the prompt of a running step".to_string(),
            ));
        }
        let previous_prompt = step.def.prompt.clone();
        step.def.prompt = prompt;
        let previous_updated_at = state.updated_at;
        state.updated_at = clock.now_ms();
        if let Err(error) = store::save_run_state(project_path, &state) {
            state
                .find_step_mut(step_id)
                .expect("step exists")
                .def
                .prompt = previous_prompt;
            state.updated_at = previous_updated_at;
            return Err(PipelineError::Store(error));
        }
        Ok(())
    }

    pub async fn set_pinned(
        &self,
        project_path: &Path,
        pinned: bool,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let mut state = self.state.lock().await;
        let previous = state.clone();
        state.pinned = pinned;
        state.updated_at = clock.now_ms();
        if let Err(error) = store::save_run_state(project_path, &state) {
            *state = previous;
            return Err(PipelineError::Store(error));
        }
        Ok(())
    }

    pub async fn clear_history(
        &self,
        project_path: &Path,
        clock: &dyn Clock,
    ) -> Result<(), PipelineError> {
        let mut state = self.state.lock().await;
        if state.status == RunStatus::Running
            || state
                .steps
                .iter()
                .any(|step| step.status == StepStatus::Running)
        {
            return Err(PipelineError::InvalidRunTransition(
                state.run_id.clone(),
                "pause the run before clearing history".to_string(),
            ));
        }
        let previous = state.clone();
        let snapshots = rollback_snapshot_ids(&state);
        queue_rollback_snapshot_cleanup(&mut state, snapshots);
        for step in &mut state.steps {
            step.history.clear();
        }
        state.updated_at = clock.now_ms();
        if let Err(error) = store::save_run_state(project_path, &state) {
            *state = previous;
            return Err(PipelineError::Store(error));
        }
        cleanup_rollback_snapshots(project_path, &mut state)
    }
}

pub(crate) fn rollback_snapshot_ids(state: &RunState) -> Vec<String> {
    state
        .steps
        .iter()
        .flat_map(|step| &step.history)
        .filter_map(|attempt| attempt.rollback_snapshot.clone())
        .collect()
}

pub(crate) fn queue_rollback_snapshot_cleanup(
    state: &mut RunState,
    snapshot_ids: impl IntoIterator<Item = String>,
) {
    for snapshot_id in snapshot_ids {
        if !state.pending_snapshot_cleanup.contains(&snapshot_id) {
            state.pending_snapshot_cleanup.push(snapshot_id);
        }
    }
}

pub(crate) fn cleanup_rollback_snapshots(
    project_path: &Path,
    state: &mut RunState,
) -> Result<(), PipelineError> {
    let pending = state.pending_snapshot_cleanup.clone();
    let project_path = project_path.to_string_lossy().to_string();
    let mut failed = Vec::new();
    let mut errors = Vec::new();
    for snapshot_id in &pending {
        if let Err(error) = crate::webgal::project::delete_project_snapshot(
            project_path.clone(),
            snapshot_id.clone(),
        ) {
            if !error.starts_with("Snapshot not found:") {
                failed.push(snapshot_id.clone());
                errors.push(format!("{}: {}", snapshot_id, error));
            }
        }
    }
    state.pending_snapshot_cleanup = failed;
    if state.pending_snapshot_cleanup != pending {
        if let Err(error) = store::save_run_state(Path::new(&project_path), state) {
            state.pending_snapshot_cleanup = pending;
            return Err(PipelineError::Store(error));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(PipelineError::Cleanup(errors.join(", ")))
    }
}

#[derive(Debug)]
pub enum PipelineError {
    RecipeInvalid(crate::pipeline::dsl::RecipeError),
    Store(crate::pipeline::store::RunStoreError),
    Plan(crate::story_plan::PlanError),
    PlanMissing,
    RunNotFound(String),
    StepNotFound(String),
    InvalidStepTransition(String, String),
    InvalidRunTransition(String, String),
    Recovery(String),
    Cleanup(String),
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PipelineError::RecipeInvalid(e) => write!(f, "invalid recipe: {}", e),
            PipelineError::Store(e) => write!(f, "run store error: {}", e),
            PipelineError::Plan(e) => write!(f, "story plan error: {}", e),
            PipelineError::PlanMissing => write!(f, "StoryPlan is missing"),
            PipelineError::RunNotFound(id) => write!(f, "run not found: {}", id),
            PipelineError::StepNotFound(id) => write!(f, "step not found: {}", id),
            PipelineError::InvalidStepTransition(id, reason) => {
                write!(f, "invalid transition for step '{}': {}", id, reason)
            }
            PipelineError::InvalidRunTransition(id, reason) => {
                write!(f, "invalid transition for run '{}': {}", id, reason)
            }
            PipelineError::Recovery(error) => write!(f, "pipeline recovery error: {}", error),
            PipelineError::Cleanup(error) => write!(f, "snapshot cleanup deferred: {}", error),
        }
    }
}

impl std::error::Error for PipelineError {}
