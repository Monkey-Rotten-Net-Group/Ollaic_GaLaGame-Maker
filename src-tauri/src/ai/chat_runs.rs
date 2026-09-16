//! Per-run cancellation registry shared by the Tauri chat command and any
//! Provider execution that exposes an explicit request handle. Frontend
//! orchestration owns a `run_id`; every awaited continuation for that turn
//! funnels through `run_cancellable` so a later Stop can interrupt it.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;

const CANCELLED_MARKER_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_CANCELLED_MARKERS: usize = 1024;

#[derive(Clone)]
struct ChatRunHandle {
    cancelled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl ChatRunHandle {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }
}

/// One slot per `run_id` in the registry. A `Live` slot hosts the in-flight
/// Provider future; a `Cancelled` slot is a poison marker so a later
/// `run_cancellable` for the same id rejects without ever driving a Provider
/// future (closing the cancel-before-register race).
///
/// The marker is bounded rather than permanent: it expires after
/// `CANCELLED_MARKER_TTL` and the oldest markers are evicted once the map
/// reaches `MAX_CANCELLED_MARKERS`. A cancel that arrives more than
/// `CANCELLED_MARKER_TTL` before its register no longer suppresses the run.
#[derive(Clone)]
enum RunState {
    Live(ChatRunHandle),
    Cancelled { inserted_at: Instant, sequence: u64 },
}

/// Frontend → backend chat-turn ownership. Caller cancels through
/// [`ChatRunRegistry::cancel`]; the corresponding provider future is dropped
/// or detached by the [`select!`] inside [`ChatRunRegistry::run_cancellable`].
#[derive(Default)]
pub struct ChatRunRegistry {
    states: Mutex<HashMap<String, RunState>>,
    next_cancelled_sequence: AtomicU64,
}

impl ChatRunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drive `future` under the ownership of `run_id`. Concurrent calls for the
    /// same id are rejected so a stale Run B cannot hijack an active Run A. A
    /// `cancel` that arrived before this call rejects the registration
    /// immediately so a Provider future never starts after Stop.
    pub async fn run_cancellable<T>(
        &self,
        run_id: &str,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let handle = {
            let mut states = self.states.lock().await;
            Self::prune_cancelled_markers(&mut states, Instant::now());
            match states.get(run_id) {
                Some(RunState::Cancelled { .. }) => {
                    return Err(format!("chat run has been cancelled: {run_id}"));
                }
                Some(RunState::Live(_)) => {
                    return Err(format!("chat run already active: {run_id}"));
                }
                None => {
                    let handle = ChatRunHandle::new();
                    states.insert(run_id.to_string(), RunState::Live(handle.clone()));
                    handle
                }
            }
        };

        let result = tokio::select! {
            biased;
            _ = handle.notify.notified() => Err("chat run cancelled".to_string()),
            result = future => result,
        };
        let mut states = self.states.lock().await;
        // Only remove the slot if it still belongs to *this* future. Cancel
        // replaces the Live slot with a sticky marker before signalling it.
        if let Some(RunState::Live(current)) = states.get(run_id) {
            if Arc::ptr_eq(&current.cancelled, &handle.cancelled) {
                states.remove(run_id);
            }
        }
        result
    }

    /// Cancel a previously registered run. Returns `true` if a live run was
    /// signalled, `false` if the id was already cancelled, completed, or
    /// never started. In the `false` cases the id is poisoned for
    /// `CANCELLED_MARKER_TTL`: a later `run_cancellable` for the same id
    /// rejects while the marker lives, or until the oldest markers are
    /// evicted at `MAX_CANCELLED_MARKERS`. Safe to call repeatedly.
    pub async fn cancel(&self, run_id: &str) -> bool {
        let mut states = self.states.lock().await;
        let now = Instant::now();
        Self::prune_cancelled_markers(&mut states, now);
        match states.remove(run_id) {
            Some(RunState::Live(handle)) => {
                if !handle.cancelled.swap(true, Ordering::SeqCst) {
                    handle.notify.notify_one();
                }
                states.insert(run_id.to_string(), self.cancelled_marker(now));
                Self::enforce_cancelled_marker_limit(&mut states);
                true
            }
            Some(marker @ RunState::Cancelled { .. }) => {
                // Re-insert the marker so the poison remains sticky across
                // repeated cancels, and return false (no live run to signal).
                states.insert(run_id.to_string(), marker);
                false
            }
            None => {
                // No run registered yet. Mark the id so a later
                // `run_cancellable` rejects instead of starting a Provider
                // future after Stop.
                states.insert(run_id.to_string(), self.cancelled_marker(now));
                Self::enforce_cancelled_marker_limit(&mut states);
                false
            }
        }
    }

    fn cancelled_marker(&self, inserted_at: Instant) -> RunState {
        RunState::Cancelled {
            inserted_at,
            sequence: self.next_cancelled_sequence.fetch_add(1, Ordering::Relaxed),
        }
    }

    fn prune_cancelled_markers(states: &mut HashMap<String, RunState>, now: Instant) {
        states.retain(|_, state| match state {
            RunState::Live(_) => true,
            RunState::Cancelled { inserted_at, .. } => {
                now.saturating_duration_since(*inserted_at) < CANCELLED_MARKER_TTL
            }
        });
    }

    fn enforce_cancelled_marker_limit(states: &mut HashMap<String, RunState>) {
        while states
            .values()
            .filter(|state| matches!(state, RunState::Cancelled { .. }))
            .count()
            > MAX_CANCELLED_MARKERS
        {
            let oldest = states
                .iter()
                .filter_map(|(run_id, state)| match state {
                    RunState::Cancelled { sequence, .. } => Some((run_id.clone(), *sequence)),
                    RunState::Live(_) => None,
                })
                .min_by_key(|(_, sequence)| *sequence)
                .map(|(run_id, _)| run_id);
            if let Some(run_id) = oldest {
                states.remove(&run_id);
            } else {
                break;
            }
        }
    }

    /// Snapshot whether a run is currently registered. Used by tests to
    /// confirm a slot was freed after completion.
    #[cfg(test)]
    pub async fn is_active(&self, run_id: &str) -> bool {
        let states = self.states.lock().await;
        matches!(states.get(run_id), Some(RunState::Live(_)))
    }

    #[cfg(test)]
    async fn cancelled_marker_count(&self) -> usize {
        self.states
            .lock()
            .await
            .values()
            .filter(|state| matches!(state, RunState::Cancelled { .. }))
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn ai_chat_cancel_aborts_registered_provider_future() {
        let registry = Arc::new(ChatRunRegistry::new());
        let runner = registry.clone();
        let task = tokio::spawn(async move {
            runner
                .run_cancellable("run-a", async {
                    std::future::pending::<()>().await;
                    Ok::<_, String>(())
                })
                .await
        });
        // Give the spawned task a chance to register before we cancel.
        tokio::task::yield_now().await;
        assert!(registry.cancel("run-a").await);
        // A repeat cancel after the run is signalled is idempotent.
        assert!(!registry.cancel("run-a").await);
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("cancelled provider future stayed active")
            .unwrap()
            .unwrap_err();
        assert!(error.contains("cancelled"));
        assert!(!registry.is_active("run-a").await);
        assert!(registry
            .run_cancellable("run-a", async { Ok::<_, String>(()) })
            .await
            .unwrap_err()
            .contains("has been cancelled"));
    }

    #[tokio::test]
    async fn ai_chat_cancel_is_idempotent_for_unknown_or_finished_runs() {
        let registry = ChatRunRegistry::new();
        assert!(!registry.cancel("missing").await);
        assert_eq!(
            registry
                .run_cancellable("done", async { Ok::<_, String>(42) })
                .await
                .unwrap(),
            42
        );
        assert!(!registry.cancel("done").await);
    }

    #[tokio::test]
    async fn a_new_run_id_is_independent_from_a_cancelled_run() {
        let registry = ChatRunRegistry::new();
        assert_eq!(
            registry
                .run_cancellable("run-b", async { Ok::<_, String>("new") })
                .await
                .unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn concurrent_runs_with_the_same_id_are_rejected() {
        let registry = Arc::new(ChatRunRegistry::new());
        let runner = registry.clone();
        let task = tokio::spawn(async move {
            runner
                .run_cancellable("dup", async {
                    std::future::pending::<()>().await;
                    Ok::<_, String>(())
                })
                .await
        });
        tokio::task::yield_now().await;
        let err = registry
            .run_cancellable("dup", async { Ok::<_, String>(()) })
            .await
            .unwrap_err();
        assert!(err.contains("already active"));
        assert!(registry.cancel("dup").await);
        let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
    }

    /// Race regression: Stop fires *before* the Provider future registers,
    /// then a later call (e.g. the next prompt) tries to start a Provider
    /// under the same `run_id`. The registration must reject so the late
    /// Provider future is never driven after Stop.
    #[tokio::test]
    async fn cancel_before_register_poisons_run_id() {
        let registry = ChatRunRegistry::new();
        // Stop arrives before any register call.
        assert!(!registry.cancel("never-started").await);
        // A later attempt to start a Provider under the same id must fail.
        let err = registry
            .run_cancellable("never-started", async { Ok::<_, String>(()) })
            .await
            .unwrap_err();
        assert!(err.contains("has been cancelled"));
        assert!(!registry.is_active("never-started").await);
        assert!(registry
            .run_cancellable("never-started", async { Ok::<_, String>(99) })
            .await
            .unwrap_err()
            .contains("has been cancelled"));
    }

    /// Once a run completes naturally, a subsequent cancel on the same id
    /// still poisons the slot: an automatic retry (or a duplicate Start) for
    /// that exact id must not silently re-drive a Provider that the user
    /// already meant to abandon.
    #[tokio::test]
    async fn cancel_after_completion_poisons_subsequent_register_with_same_id() {
        let registry = ChatRunRegistry::new();
        assert_eq!(
            registry
                .run_cancellable("done", async { Ok::<_, String>(42) })
                .await
                .unwrap(),
            42
        );
        assert!(!registry.cancel("done").await);
        let err = registry
            .run_cancellable("done", async { Ok::<_, String>(99) })
            .await
            .unwrap_err();
        assert!(err.contains("has been cancelled"));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_markers_expire_without_weakening_the_registration_race_window() {
        let registry = ChatRunRegistry::new();
        assert!(!registry.cancel("expiring").await);
        tokio::time::advance(CANCELLED_MARKER_TTL - Duration::from_millis(1)).await;
        assert!(registry
            .run_cancellable("expiring", async { Ok::<_, String>(()) })
            .await
            .unwrap_err()
            .contains("has been cancelled"));

        assert!(!registry.cancel("expired").await);
        tokio::time::advance(CANCELLED_MARKER_TTL).await;
        assert_eq!(
            registry
                .run_cancellable("expired", async { Ok::<_, String>(7) })
                .await
                .unwrap(),
            7
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_marker_storage_is_bounded_and_keeps_recent_cancellations() {
        let registry = ChatRunRegistry::new();
        for index in 0..=MAX_CANCELLED_MARKERS {
            assert!(!registry.cancel(&format!("cancelled-{index}")).await);
        }

        assert_eq!(
            registry.cancelled_marker_count().await,
            MAX_CANCELLED_MARKERS
        );
        assert!(registry
            .run_cancellable(&format!("cancelled-{MAX_CANCELLED_MARKERS}"), async {
                Ok::<_, String>(())
            },)
            .await
            .unwrap_err()
            .contains("has been cancelled"));
        assert_eq!(
            registry
                .run_cancellable("cancelled-0", async { Ok::<_, String>(9) })
                .await
                .unwrap(),
            9
        );
    }
}
