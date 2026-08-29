use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};

use crate::pipeline::dsl::FlowRecipe;
use crate::pipeline::events::{EventSink, PipelineEvent};
use crate::pipeline::recovery::{
    cleanup_rollback_snapshots, queue_rollback_snapshot_cleanup, rollback_snapshot_ids,
    PipelineError,
};
use crate::pipeline::state::{Clock, RunState, RunStatus, StepStatus};
use crate::pipeline::store;

pub struct RunHandle {
    pub state: Arc<Mutex<RunState>>,
    pub(crate) notify: Arc<Notify>,
    pub(crate) cancel_notify: Arc<Notify>,
    pub(crate) pause_after_step: AtomicBool,
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) asset_binding_gate: Arc<Mutex<()>>,
    /// Per-run deadline snapshot, taken at run-creation time from the
    /// Provider capability that was live then. Once a Run is in flight,
    /// subsequent config edits must not change its deadline mid-flight.
    pub step_timeout: Option<Duration>,
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
    /// coherent Flow Dependency suffix without repeating completed upstream work.
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
