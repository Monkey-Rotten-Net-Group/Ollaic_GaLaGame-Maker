//! Pipeline Orchestrator (V2 section 3.1). Schedules Flow Steps in dependency
//! order, persists after each transition, emits events through `EventSink`,
//! and updates the StoryPlan as steps produce output. The Tauri adapter
//! (commands.rs) wraps this testable core.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};

#[cfg(test)]
use crate::agents::router::NoChatGateway;
use crate::agents::router::{ChatGateway, ConfiguredChatGateway};
use crate::agents::{AgentContext, AgentRegistry};
#[cfg(test)]
use crate::pipeline::asset_executor::PlaceholderAssetGeneratorFactory;
use crate::pipeline::asset_executor::{AssetGeneratorFactory, ConfiguredAssetGeneratorFactory};
use crate::pipeline::dsl::{FlowRecipe, StepExecutor, StepKind};
use crate::pipeline::events::{EventSink, PipelineEvent};
use crate::pipeline::output_commit::{
    apply_canonical_characters, apply_output, commit_step_output, restore_interrupted_outputs,
    validate_output_contract,
};
use crate::pipeline::project_state::{project_has_story_content_locked, record_run_summary};
use crate::pipeline::recovery::PipelineError;
use crate::pipeline::run_control::RunHandle;
use crate::pipeline::run_driver::{mark_run_persistence_failed, next_action, Action};
use crate::pipeline::state::{Clock, RunState, RunStatus, StepStatus};
use crate::pipeline::step_executor::{execute as execute_step, ExecutorContext};
use crate::pipeline::store;
use crate::story_plan::{self, StoryPlan};

/// Production deadline for one Flow Step. Individual tests may override it,
/// but every production constructor enables this cap by default.
pub(crate) const DEFAULT_STEP_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy)]
pub(crate) struct RunCreation<'a> {
    pub(crate) project_path: &'a Path,
    pub(crate) run_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) recipe: &'a FlowRecipe,
    pub(crate) allow_local_fallback: bool,
    pub(crate) step_timeout: Option<Duration>,
    pub(crate) clock: &'a dyn Clock,
    pub(crate) sink: &'a dyn EventSink,
}

#[derive(Clone, Copy)]
struct StepExecution<'a> {
    project_path: &'a Path,
    handle: &'a RunHandle,
    sink: &'a dyn EventSink,
    clock: &'a dyn Clock,
}

/// The testable orchestrator core.
pub struct Pipeline {
    agents: AgentRegistry,
    chat: Arc<dyn ChatGateway>,
    asset_generators: Arc<dyn AssetGeneratorFactory>,
    step_timeout: Option<Duration>,
    #[cfg(test)]
    hanging_asset_queue_started: Option<Arc<tokio::sync::Semaphore>>,
    #[cfg(test)]
    cancel_wait_registration_hook:
        Option<(Arc<tokio::sync::Semaphore>, Arc<tokio::sync::Semaphore>)>,
}

impl Pipeline {
    #[cfg(test)]
    pub fn new(agents: AgentRegistry) -> Self {
        Self::with_dependencies(
            agents,
            Arc::new(NoChatGateway),
            Arc::new(PlaceholderAssetGeneratorFactory),
        )
    }

    #[cfg(test)]
    pub fn with_default_agents() -> Self {
        Self::new(AgentRegistry::with_defaults())
    }

    pub fn with_default_agents_and_matting(
        figure_matting_model: Result<std::path::PathBuf, String>,
    ) -> Self {
        Self::with_agents_and_matting(AgentRegistry::with_defaults(), figure_matting_model)
    }

    pub(crate) fn with_agents_and_matting(
        agents: AgentRegistry,
        figure_matting_model: Result<std::path::PathBuf, String>,
    ) -> Self {
        Self::with_dependencies(
            agents,
            Arc::new(ConfiguredChatGateway),
            Arc::new(ConfiguredAssetGeneratorFactory::new(figure_matting_model)),
        )
    }

    fn with_dependencies(
        agents: AgentRegistry,
        chat: Arc<dyn ChatGateway>,
        asset_generators: Arc<dyn AssetGeneratorFactory>,
    ) -> Self {
        Self {
            agents,
            chat,
            asset_generators,
            step_timeout: Some(DEFAULT_STEP_TIMEOUT),
            #[cfg(test)]
            hanging_asset_queue_started: None,
            #[cfg(test)]
            cancel_wait_registration_hook: None,
        }
    }

    /// Cap each step's agent run with a timeout; on expiry the step fails and
    /// the run terminates as `RunStatus::Timeout` instead of hanging forever.
    #[cfg(test)]
    pub fn with_step_timeout(mut self, timeout: Duration) -> Self {
        self.step_timeout = Some(timeout);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_hanging_asset_queue_for_test(
        mut self,
        started: Arc<tokio::sync::Semaphore>,
    ) -> Self {
        self.hanging_asset_queue_started = Some(started);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_cancel_wait_registration_hook_for_test(
        mut self,
        entered: Arc<tokio::sync::Semaphore>,
        release: Arc<tokio::sync::Semaphore>,
    ) -> Self {
        self.cancel_wait_registration_hook = Some((entered, release));
        self
    }

    #[cfg(test)]
    pub(crate) fn with_asset_generators_for_test(
        mut self,
        asset_generators: Arc<dyn AssetGeneratorFactory>,
    ) -> Self {
        self.asset_generators = asset_generators;
        self
    }

    /// Create + persist a run, emit `RunStarted`, return a handle set to
    /// `Running`. Ensures a StoryPlan exists. Does NOT execute.
    #[cfg(test)]
    pub fn create_run(
        &self,
        project_path: &Path,
        run_id: &str,
        prompt: &str,
        recipe: &FlowRecipe,
        clock: &dyn Clock,
        sink: &dyn EventSink,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        // Unit tests inject NoChatGateway and explicitly authorize the local
        // deterministic agents through persisted Run state.
        self.create_run_with_options(RunCreation {
            project_path,
            run_id,
            prompt,
            recipe,
            allow_local_fallback: true,
            step_timeout: self.step_timeout,
            clock,
            sink,
        })
    }

    #[cfg(test)]
    pub fn create_run_with_options(
        &self,
        creation: RunCreation<'_>,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        self.create_run_with_timeout(creation)
    }

    /// Creates a run from a complete creation-time snapshot, including the
    /// resolved per-step deadline and local-fallback authorization.
    #[cfg(test)]
    pub fn create_run_with_timeout(
        &self,
        creation: RunCreation<'_>,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        crate::project_lock::with_project_lock(creation.project_path, || {
            self.create_run_with_timeout_locked(creation)
        })
    }

    pub(crate) fn create_new_story_run_with_timeout(
        &self,
        creation: RunCreation<'_>,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        crate::project_lock::with_project_lock(creation.project_path, || {
            if let Some(active) = store::list_run_states(creation.project_path)
                .map_err(PipelineError::Store)?
                .into_iter()
                .find(|run| !run.status.is_terminal())
            {
                return Err(PipelineError::Recovery(format!(
                    "project has unfinished run {}; resume or stop it before starting another flow",
                    active.run_id
                )));
            }
            if project_has_story_content_locked(creation.project_path)
                .map_err(PipelineError::Recovery)?
            {
                return Err(PipelineError::Recovery(
                    "项目已有故事内容；请使用 AI 聊天的可审阅 patch 工作流修改，Agent Flow 仅用于新建故事。"
                        .to_string(),
                ));
            }
            self.create_run_with_timeout_locked(creation)
        })
    }

    fn create_run_with_timeout_locked(
        &self,
        creation: RunCreation<'_>,
    ) -> Result<Arc<RunHandle>, PipelineError> {
        let RunCreation {
            project_path,
            run_id,
            prompt,
            recipe,
            allow_local_fallback,
            step_timeout,
            clock,
            sink,
        } = creation;
        recipe.validate().map_err(PipelineError::RecipeInvalid)?;
        if recipe
            .steps
            .iter()
            .any(|step| step.executor == StepExecutor::AssetQueue)
        {
            self.asset_generators
                .preflight_run(allow_local_fallback)
                .map_err(PipelineError::CapabilityGap)?;
        }
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
        // Snapshot the resolved deadline onto the persisted RunState so an
        // app restart, a resume_run, or an attach_run reads back the same
        // value the run actually started under — not whatever the user has
        // since edited in settings.
        state.step_timeout_ms = step_timeout.map(|duration| duration.as_millis() as u64);
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
            step_timeout,
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
        // Restore the per-run deadline from the snapshot written at creation
        // time. `step_timeout_ms: None` on an old state file (pre-field)
        // silently falls back to the current Pipeline default, which keeps
        // backward compatibility without re-resolving the capability (which
        // might have changed since the run started).
        let step_timeout = state
            .step_timeout_ms
            .map(std::time::Duration::from_millis)
            .or(self.step_timeout);
        Ok(Arc::new(RunHandle {
            state: Arc::new(Mutex::new(state)),
            notify: Arc::new(Notify::new()),
            cancel_notify: Arc::new(Notify::new()),
            pause_after_step: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            asset_binding_gate: Arc::new(Mutex::new(())),
            step_timeout,
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
        let step_timeout = state
            .step_timeout_ms
            .map(std::time::Duration::from_millis)
            .or(self.step_timeout);
        Ok(Arc::new(RunHandle {
            state: Arc::new(Mutex::new(state)),
            notify: Arc::new(Notify::new()),
            cancel_notify: Arc::new(Notify::new()),
            pause_after_step: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            asset_binding_gate: Arc::new(Mutex::new(())),
            step_timeout,
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

            let action = next_action(project_path, &handle, sink, clock).await;
            match action {
                // `Idle` means either terminal (the run completed/failed) or a
                // transient pause observed between the top-of-loop check and
                // the lock. Either way, loop: the top check returns on terminal
                // and waits on pause.
                Action::Idle => continue,
                Action::Run { id, kind, prompt } => {
                    self.run_step(
                        StepExecution {
                            project_path,
                            handle: handle.as_ref(),
                            sink,
                            clock,
                        },
                        id,
                        kind,
                        prompt,
                    )
                    .await;
                    if handle.pause_after_step.swap(false, Ordering::SeqCst) {
                        let should_pause = {
                            let state = handle.state.lock().await;
                            !state.status.is_terminal() && !state.is_complete()
                        };
                        if should_pause {
                            if let Err(error) = handle.pause(project_path, sink, clock).await {
                                let mut state = handle.state.lock().await;
                                let event = mark_run_persistence_failed(
                                    &mut state,
                                    "单步执行后的暂停状态",
                                    error,
                                );
                                drop(state);
                                sink.emit(event);
                                return;
                            }
                        }
                    }
                }
            }
        }
    }

    async fn run_step(
        &self,
        execution: StepExecution<'_>,
        id: String,
        kind: StepKind,
        prompt: String,
    ) {
        let StepExecution {
            project_path,
            handle,
            sink,
            clock,
        } = execution;
        let _flow_resource_guard = match crate::flow_edit_lock::FlowEditGuard::acquire(
            project_path,
            &[
                crate::flow_edit_lock::FlowResource::Characters,
                crate::flow_edit_lock::FlowResource::StoryPlan,
            ],
        ) {
            Ok(guard) => guard,
            Err(error) => {
                self.fail_step(
                    execution,
                    id,
                    format!("failed to lock Flow Step inputs: {error}"),
                )
                .await;
                return;
            }
        };
        // Load the plan to build the agent context.
        let mut plan = match story_plan::load_plan(project_path) {
            Ok(Some(plan)) => plan,
            Ok(None) => {
                self.fail_step(execution, id, "StoryPlan is missing".to_string())
                    .await;
                return;
            }
            Err(error) => {
                self.fail_step(
                    execution,
                    id,
                    format!("failed to load StoryPlan: {}", error),
                )
                .await;
                return;
            }
        };
        let characters_path = project_path.join("game/config/characters.json");
        if characters_path.is_file() {
            match crate::characters::commands::list_characters_locked(
                project_path.to_string_lossy().as_ref(),
            ) {
                Ok(characters) => {
                    apply_canonical_characters(&mut plan, characters, kind == StepKind::Character);
                }
                Err(error) => {
                    self.fail_step(
                        execution,
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
            (state.prompt.clone(), state.allow_local_fallback)
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
                execution,
                id,
                format!("failed to persist step input snapshot: {}", error),
            )
            .await;
            return;
        }

        let ctx = AgentContext {
            chat: self.chat.as_ref(),
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
        let executor = {
            let state = handle.state.lock().await;
            state
                .find_step(&id)
                .map(|step| step.def.executor.clone())
                .unwrap_or_default()
        };
        #[cfg(test)]
        if let Some((entered, release)) = &self.cancel_wait_registration_hook {
            entered.add_permits(1);
            release
                .acquire()
                .await
                .expect("cancel registration test hook closed")
                .forget();
        }
        let cancel_wait = handle.cancel_notify.notified();
        tokio::pin!(cancel_wait);
        // notify_waiters() stores no permit. Register this waiter before
        // checking the durable atomic flag so stop() cannot land in the gap
        // between the check and select polling.
        cancel_wait.as_mut().enable();
        if handle.cancelled.load(Ordering::SeqCst) {
            return;
        }
        let result = {
            let run_id = handle.state.lock().await.run_id.clone();
            let executor_run = execute_step(ExecutorContext {
                executor: &executor,
                kind,
                agent_context: &ctx,
                agents: &self.agents,
                asset_generators: self.asset_generators.as_ref(),
                project_path,
                run_id: &run_id,
                plan: &plan,
                cancelled: &handle.cancelled,
                asset_binding_gate: &handle.asset_binding_gate,
                #[cfg(test)]
                hanging_asset_queue_started: self.hanging_asset_queue_started.as_ref(),
            });
            tokio::pin!(executor_run);
            if handle.cancelled.load(Ordering::SeqCst) {
                return;
            }
            let timeout_sleep = async {
                match handle.step_timeout {
                    Some(timeout) => tokio::time::sleep(timeout).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                biased;
                _ = &mut cancel_wait => return,
                result = &mut executor_run => result,
                _ = timeout_sleep => {
                    if let Some(timeout) = handle.step_timeout {
                        self.fail_step_timeout(execution, id, timeout).await;
                    }
                    return;
                }
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
                    return;
                }
                if let Err(error) = validate_output_contract(kind, &executor, &out) {
                    drop(state);
                    self.fail_step(execution, id, error.0).await;
                    return;
                }
                // Keep stop() outside the two durable writes: cancellation
                // takes effect either before output or after a full commit.
                apply_output(&mut plan, &out);
                if let Err(error) = story_plan::validate(&plan) {
                    drop(state);
                    self.fail_step(
                        execution,
                        id,
                        format!("Agent output produced an invalid StoryPlan: {}", error),
                    )
                    .await;
                    return;
                }
                let committed =
                    match commit_step_output(project_path, &mut state, &id, &out, &plan, clock) {
                        Ok(committed) => committed,
                        Err(error) => {
                            drop(state);
                            self.fail_step(execution, id, error.0).await;
                            return;
                        }
                    };
                drop(state);
                sink.emit(PipelineEvent::StepSucceeded {
                    run_id: committed.run_id,
                    step_id: id,
                    output: committed.output,
                });
            }
            Err(err) => self.fail_step(execution, id, err.0).await,
        }
    }

    async fn fail_step(&self, execution: StepExecution<'_>, step_id: String, error: String) {
        self.fail_step_with_status(execution, step_id, error, RunStatus::Failed)
            .await;
    }

    async fn fail_step_timeout(
        &self,
        execution: StepExecution<'_>,
        step_id: String,
        timeout: Duration,
    ) {
        let error = format!("step timed out after {:?}", timeout);
        self.fail_step_with_status(execution, step_id, error, RunStatus::Timeout)
            .await;
    }

    async fn fail_step_with_status(
        &self,
        execution: StepExecution<'_>,
        step_id: String,
        error: String,
        status: RunStatus,
    ) {
        let StepExecution {
            project_path,
            handle,
            sink,
            clock,
        } = execution;
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
        if let Err(save_error) = store::save_run_state(project_path, &state) {
            let operation = if status == RunStatus::Timeout {
                "超时终态"
            } else {
                "失败终态"
            };
            let event = mark_run_persistence_failed(&mut state, operation, save_error);
            drop(state);
            sink.emit(event);
            return;
        }
        drop(state);
        sink.emit(PipelineEvent::StepFailed {
            run_id: run_id.clone(),
            step_id,
            error: error.clone(),
        });
        match status {
            RunStatus::Timeout => sink.emit(PipelineEvent::RunTimedOut {
                run_id: run_id.clone(),
                error,
            }),
            _ => sink.emit(PipelineEvent::RunFailed {
                run_id: run_id.clone(),
                error,
            }),
        }
        let _ = record_run_summary(project_path, &run_id, clock);
    }
}
