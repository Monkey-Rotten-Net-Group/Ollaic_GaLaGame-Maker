//! Pipeline events and the `EventSink` boundary. The orchestrator emits
//! through `EventSink`; the Tauri adapter forwards to `AppHandle::emit`
//! (ADR 0055), tests use `RecordingSink`.

use serde::Serialize;

#[cfg(test)]
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PipelineEvent {
    RunStarted {
        run_id: String,
    },
    StepStarted {
        run_id: String,
        step_id: String,
        kind: String,
    },
    StepSucceeded {
        run_id: String,
        step_id: String,
        output: Option<String>,
    },
    StepFailed {
        run_id: String,
        step_id: String,
        error: String,
    },
    StepSkipped {
        run_id: String,
        step_id: String,
    },
    RunPaused {
        run_id: String,
    },
    RunResumed {
        run_id: String,
    },
    RunCompleted {
        run_id: String,
    },
    RunFailed {
        run_id: String,
        error: String,
    },
    RunTimedOut {
        run_id: String,
        error: String,
    },
    RunPersistenceFailed {
        run_id: String,
        error: String,
    },
    RunStopped {
        run_id: String,
    },
}

impl PipelineEvent {
    pub fn run_id(&self) -> &str {
        match self {
            PipelineEvent::RunStarted { run_id }
            | PipelineEvent::RunPaused { run_id }
            | PipelineEvent::RunResumed { run_id }
            | PipelineEvent::RunCompleted { run_id }
            | PipelineEvent::RunStopped { run_id }
            | PipelineEvent::RunFailed { run_id, .. }
            | PipelineEvent::RunTimedOut { run_id, .. }
            | PipelineEvent::RunPersistenceFailed { run_id, .. } => run_id,
            PipelineEvent::StepStarted { run_id, .. }
            | PipelineEvent::StepSucceeded { run_id, .. }
            | PipelineEvent::StepFailed { run_id, .. }
            | PipelineEvent::StepSkipped { run_id, .. } => run_id,
        }
    }
}

/// Sink for pipeline events. Implementations: `RecordingSink` (tests) and
/// the Tauri adapter (emits to the `pipeline:{run_id}` channel).
pub trait EventSink: Send + Sync {
    fn emit(&self, event: PipelineEvent);
}

/// Collects emitted events in order, for assertions. Test-only.
#[cfg(test)]
pub struct RecordingSink {
    events: Mutex<Vec<PipelineEvent>>,
}

#[cfg(test)]
impl Default for RecordingSink {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl RecordingSink {
    pub fn new() -> Self {
        RecordingSink {
            events: Mutex::new(Vec::new()),
        }
    }

    pub fn events(&self) -> Vec<PipelineEvent> {
        self.events.lock().unwrap().clone()
    }
}

#[cfg(test)]
impl EventSink for RecordingSink {
    fn emit(&self, event: PipelineEvent) {
        self.events.lock().unwrap().push(event);
    }
}
