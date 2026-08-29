use std::path::Path;
use std::sync::Arc;

use crate::pipeline::dsl::StepKind;
use crate::pipeline::events::{EventSink, PipelineEvent};
use crate::pipeline::project_state::record_run_summary;
use crate::pipeline::recovery::{cleanup_rollback_snapshots, queue_rollback_snapshot_cleanup};
use crate::pipeline::run_control::RunHandle;
use crate::pipeline::state::{Clock, RunStatus, StepRunHistory, StepStatus};
use crate::pipeline::store;

pub(crate) enum Action {
    /// Run the step with this id, kind, and resolved prompt.
    Run {
        id: String,
        kind: StepKind,
        prompt: String,
    },
    /// Nothing left to do this iteration.
    Idle,
}

pub(crate) fn mark_run_persistence_failed(
    state: &mut crate::pipeline::state::RunState,
    operation: &str,
    error: impl std::fmt::Display,
) -> PipelineEvent {
    state.status = RunStatus::PersistenceFailed;
    let run_id = state.run_id.clone();
    PipelineEvent::RunPersistenceFailed {
        run_id: run_id.clone(),
        error: format!(
            "无法保存运行 '{run_id}' 的{operation}：{error}。请重新打开项目，从上次已保存的进度恢复。"
        ),
    }
}

pub(crate) async fn next_action(
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
                let event = mark_run_persistence_failed(&mut state, "步骤启动状态", err);
                drop(state);
                sink.emit(event);
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
                    let event = mark_run_persistence_failed(&mut state, "完成终态", err);
                    drop(state);
                    sink.emit(event);
                    return Action::Idle;
                }
                drop(state);
                sink.emit(PipelineEvent::RunCompleted {
                    run_id: run_id.clone(),
                });
                let _ = record_run_summary(project_path, &run_id, clock);
                Action::Idle
            } else {
                let error = "flow blocked: a dependency failed or is missing".to_string();
                state.status = RunStatus::Failed;
                state.updated_at = clock.now_ms();
                let run_id = state.run_id.clone();
                if let Err(save_error) = store::save_run_state(project_path, &state) {
                    let event = mark_run_persistence_failed(&mut state, "依赖阻塞终态", save_error);
                    drop(state);
                    sink.emit(event);
                    return Action::Idle;
                }
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
