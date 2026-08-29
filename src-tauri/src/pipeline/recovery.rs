use std::path::Path;

use crate::pipeline::state::RunState;
use crate::pipeline::store;

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
    CapabilityGap(String),
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
            PipelineError::CapabilityGap(e) => write!(f, "Flow capability gap: {}", e),
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
            PipelineError::Recovery(error) => write!(f, "Agent Flow recovery error: {}", error),
            PipelineError::Cleanup(error) => write!(f, "snapshot cleanup deferred: {}", error),
        }
    }
}

impl std::error::Error for PipelineError {}
