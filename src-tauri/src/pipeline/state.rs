//! Pipeline run state: the state machine and step-readiness logic for an
//! Agent Flow run. See ADR 0054 (per-step persistence). The playable story
//! stays in WebGAL files; this records generation progress only.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::pipeline::dsl::FlowRecipe;

pub const MAX_STEP_HISTORY: usize = 20;

/// Lifecycle of a single Flow Step within a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    AwaitingInput,
    Skipped,
}

/// Lifecycle of a whole run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Idle,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
    Timeout,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled | RunStatus::Timeout
        )
    }
}

/// Per-step runtime state. The step definition is snapshotted here so a run
/// can resume from disk without the original recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub def: crate::pipeline::dsl::StepDef,
    pub status: StepStatus,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub finished_at: Option<u64>,
    #[serde(default)]
    pub history: Vec<StepRunHistory>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepRunHistory {
    pub attempt: u32,
    pub input_snapshot: String,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub started_at: u64,
    #[serde(default)]
    pub finished_at: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub diff: Option<String>,
    #[serde(default)]
    pub cost: Option<f64>,
    #[serde(default)]
    pub prompt_tokens: Option<u32>,
    #[serde(default)]
    pub completion_tokens: Option<u32>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub downgrade: Option<String>,
    #[serde(default)]
    pub rollback_snapshot: Option<String>,
}

impl StepState {
    pub fn pending(def: crate::pipeline::dsl::StepDef) -> Self {
        StepState {
            def,
            status: StepStatus::Pending,
            attempt: 0,
            output: None,
            error: None,
            started_at: None,
            finished_at: None,
            history: Vec::new(),
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            StepStatus::Succeeded | StepStatus::Failed | StepStatus::Skipped
        )
    }

    pub fn record_attempt(&mut self, history: StepRunHistory, retain_all: bool) -> Vec<String> {
        let mut removed_snapshots = Vec::new();
        if !retain_all && self.history.len() >= MAX_STEP_HISTORY {
            let remove = self.history.len() + 1 - MAX_STEP_HISTORY;
            removed_snapshots.extend(
                self.history
                    .drain(..remove)
                    .filter_map(|attempt| attempt.rollback_snapshot),
            );
        }
        self.history.push(history);
        removed_snapshots
    }
}

/// The full state of one pipeline run, persisted to
/// `.ollaic/pipeline/<run_id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub run_id: String,
    pub project_path: String,
    pub prompt: String,
    pub status: RunStatus,
    pub steps: Vec<StepState>,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub allow_local_fallback: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_queue_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_snapshot_cleanup: Vec<String>,
}

impl RunState {
    pub fn new(
        run_id: impl Into<String>,
        project_path: impl AsRef<Path>,
        prompt: impl Into<String>,
        recipe: &FlowRecipe,
        now_ms: u64,
    ) -> Self {
        RunState {
            run_id: run_id.into(),
            project_path: project_path.as_ref().to_string_lossy().into_owned(),
            prompt: prompt.into(),
            status: RunStatus::Idle,
            steps: recipe
                .steps
                .iter()
                .map(|d| StepState::pending(d.clone()))
                .collect(),
            started_at: now_ms,
            updated_at: now_ms,
            pinned: false,
            allow_local_fallback: false,
            step_timeout_ms: None,
            asset_queue_timeout_ms: None,
            pending_snapshot_cleanup: Vec::new(),
        }
    }

    pub fn find_step(&self, id: &str) -> Option<&StepState> {
        self.steps.iter().find(|s| s.def.id == id)
    }

    pub fn find_step_mut(&mut self, id: &str) -> Option<&mut StepState> {
        self.steps.iter_mut().find(|s| s.def.id == id)
    }

    /// True when every step is in a terminal status.
    pub fn all_steps_terminal(&self) -> bool {
        !self.steps.is_empty() && self.steps.iter().all(|s| s.is_terminal())
    }

    /// True when every step succeeded (no skips/failures).
    #[allow(dead_code)]
    pub fn all_steps_succeeded(&self) -> bool {
        !self.steps.is_empty() && self.steps.iter().all(|s| s.status == StepStatus::Succeeded)
    }

    pub fn has_failed_step(&self) -> bool {
        self.steps.iter().any(|s| s.status == StepStatus::Failed)
    }

    /// A run is complete when every step reached a terminal status and none
    /// failed - skipped steps count as complete (the user opted out).
    pub fn is_complete(&self) -> bool {
        self.all_steps_terminal() && !self.has_failed_step()
    }

    /// A step is ready to run when it is `Pending` and every dependency is
    /// `Succeeded` or `Skipped` (a skipped dependency unblocks downstream, so
    /// a user can skip an optional step and keep the flow moving).
    pub fn next_ready_step_id(&self) -> Option<String> {
        for step in &self.steps {
            if step.status != StepStatus::Pending {
                continue;
            }
            if self.deps_satisfied(step) {
                return Some(step.def.id.clone());
            }
        }
        None
    }

    fn deps_satisfied(&self, step: &StepState) -> bool {
        for dep_id in &step.def.depends_on {
            match self.find_step(dep_id) {
                Some(dep) => match dep.status {
                    StepStatus::Succeeded | StepStatus::Skipped => continue,
                    _ => return false,
                },
                None => return false,
            }
        }
        true
    }
}

/// Injectable clock so the scheduler is deterministic in tests (mock time,
/// not your own modules - see TDD mocking guidance).
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::dsl::{FlowRecipe, StepDef, StepKind};

    fn recipe_ab() -> FlowRecipe {
        FlowRecipe::new()
            .step(StepDef::new("a", StepKind::Plan))
            .step(StepDef::new("b", StepKind::Outline).depends_on("a"))
    }

    #[test]
    fn fresh_run_has_all_steps_pending() {
        let state = RunState::new("run_1", ".", "prompt", &recipe_ab(), 100);
        assert_eq!(state.status, RunStatus::Idle);
        assert!(state.steps.iter().all(|s| s.status == StepStatus::Pending));
    }

    #[test]
    fn first_ready_step_respects_dependencies() {
        let mut state = RunState::new("run_1", ".", "prompt", &recipe_ab(), 100);
        // Initially only `a` is ready (b depends on a).
        assert_eq!(state.next_ready_step_id().as_deref(), Some("a"));
        state.find_step_mut("a").unwrap().status = StepStatus::Running;
        // While `a` is running, nothing is ready.
        assert_eq!(state.next_ready_step_id(), None);
        state.find_step_mut("a").unwrap().status = StepStatus::Succeeded;
        // Now `b` is ready.
        assert_eq!(state.next_ready_step_id().as_deref(), Some("b"));
        state.find_step_mut("b").unwrap().status = StepStatus::Succeeded;
        assert_eq!(state.next_ready_step_id(), None);
        assert!(state.all_steps_succeeded());
    }

    #[test]
    fn failed_dependency_blocks_downstream() {
        let mut state = RunState::new("run_1", ".", "prompt", &recipe_ab(), 100);
        state.find_step_mut("a").unwrap().status = StepStatus::Failed;
        assert_eq!(state.next_ready_step_id(), None);
        assert!(!state.all_steps_succeeded());
        assert!(!state.all_steps_terminal());
    }

    #[test]
    fn skipped_dependency_unblocks_downstream() {
        let mut state = RunState::new("run_1", ".", "prompt", &recipe_ab(), 100);
        state.find_step_mut("a").unwrap().status = StepStatus::Skipped;
        // `b` is still pending but its (skipped) dependency no longer blocks it.
        assert_eq!(state.next_ready_step_id().as_deref(), Some("b"));
        assert!(!state.is_complete(), "b is still pending");
    }

    #[test]
    fn step_history_keeps_only_the_latest_attempts() {
        let mut step = StepState::pending(StepDef::new("a", StepKind::Plan));
        for attempt in 1..=MAX_STEP_HISTORY as u32 + 3 {
            let removed = step.record_attempt(
                StepRunHistory {
                    attempt,
                    input_snapshot: attempt.to_string(),
                    output: None,
                    error: None,
                    started_at: attempt as u64,
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
                false,
            );
            if attempt == 1 {
                step.history[0].rollback_snapshot = Some("old-snapshot".to_string());
            }
            if attempt == MAX_STEP_HISTORY as u32 + 1 {
                assert_eq!(removed, vec!["old-snapshot"]);
            } else {
                assert!(removed.is_empty());
            }
        }
        assert_eq!(step.history.len(), MAX_STEP_HISTORY);
        assert_eq!(step.history.first().unwrap().attempt, 4);
        assert_eq!(step.history.last().unwrap().attempt, 23);

        let retained = step.history.last().unwrap().clone();
        assert!(step.record_attempt(retained, true).is_empty());
        assert_eq!(step.history.len(), MAX_STEP_HISTORY + 1);
    }
}
