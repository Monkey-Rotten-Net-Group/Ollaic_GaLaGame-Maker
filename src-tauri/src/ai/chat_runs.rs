use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;

const CANCELLED_MARKER_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_CANCELLED_MARKERS: usize = 1024;

#[derive(Clone)]
struct ChatRunHandle {
    project_path: PathBuf,
    cancelled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

#[derive(Clone)]
enum ChatRunState {
    Live(ChatRunHandle),
    Cancelled {
        project_path: PathBuf,
        inserted_at: Instant,
        sequence: u64,
    },
}

#[derive(Default)]
pub struct ChatRunRegistry {
    states: Mutex<HashMap<String, ChatRunState>>,
    next_cancelled_sequence: AtomicU64,
}

impl ChatRunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run_cancellable<T>(
        &self,
        project_path: &Path,
        run_id: &str,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let handle = ChatRunHandle {
            project_path: project_path.to_path_buf(),
            cancelled: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        };
        {
            let mut states = self.states.lock().await;
            Self::prune_cancelled_markers(&mut states, Instant::now());
            match states.get(run_id) {
                Some(ChatRunState::Cancelled {
                    project_path: owner,
                    ..
                }) if owner == project_path => {
                    return Err(format!("chat run has been cancelled: {run_id}"));
                }
                Some(ChatRunState::Cancelled {
                    project_path: owner,
                    ..
                })
                | Some(ChatRunState::Live(ChatRunHandle {
                    project_path: owner,
                    ..
                })) if owner != project_path => {
                    return Err(Self::project_mismatch(run_id, owner, project_path));
                }
                Some(ChatRunState::Live(_)) => {
                    return Err(format!("chat run already active: {run_id}"));
                }
                None => {}
                Some(ChatRunState::Cancelled { .. }) => unreachable!("owner match handled above"),
            }
            states.insert(run_id.to_string(), ChatRunState::Live(handle.clone()));
        }

        let result = tokio::select! {
            biased;
            _ = handle.notify.notified() => Err("chat run cancelled".to_string()),
            result = future => result,
        };
        let mut states = self.states.lock().await;
        if states.get(run_id).is_some_and(|current| {
            matches!(current, ChatRunState::Live(current) if Arc::ptr_eq(&current.cancelled, &handle.cancelled))
        })
        {
            if handle.cancelled.load(Ordering::SeqCst) {
                states.insert(
                    run_id.to_string(),
                    self.cancelled_state(handle.project_path.clone(), Instant::now()),
                );
                Self::enforce_cancelled_marker_limit(&mut states);
            } else {
                states.remove(run_id);
            }
        }
        result
    }

    pub async fn cancel(&self, project_path: &Path, run_id: &str) -> Result<bool, String> {
        let mut states = self.states.lock().await;
        let now = Instant::now();
        Self::prune_cancelled_markers(&mut states, now);
        match states.get(run_id).cloned() {
            Some(ChatRunState::Live(handle)) => {
                if handle.project_path != project_path {
                    return Err(Self::project_mismatch(
                        run_id,
                        &handle.project_path,
                        project_path,
                    ));
                }
                if !handle.cancelled.swap(true, Ordering::SeqCst) {
                    handle.notify.notify_one();
                }
                Ok(true)
            }
            Some(ChatRunState::Cancelled {
                project_path: owner,
                ..
            }) => {
                if owner != project_path {
                    Err(Self::project_mismatch(run_id, &owner, project_path))
                } else {
                    Ok(false)
                }
            }
            None => {
                states.insert(
                    run_id.to_string(),
                    self.cancelled_state(project_path.to_path_buf(), now),
                );
                Self::enforce_cancelled_marker_limit(&mut states);
                Ok(false)
            }
        }
    }

    fn project_mismatch(run_id: &str, owner: &Path, caller: &Path) -> String {
        format!(
            "chat run {run_id} belongs to project {}, not {}",
            owner.display(),
            caller.display()
        )
    }

    fn cancelled_state(&self, project_path: PathBuf, inserted_at: Instant) -> ChatRunState {
        ChatRunState::Cancelled {
            project_path,
            inserted_at,
            sequence: self.next_cancelled_sequence.fetch_add(1, Ordering::Relaxed),
        }
    }

    fn prune_cancelled_markers(states: &mut HashMap<String, ChatRunState>, now: Instant) {
        states.retain(|_, state| match state {
            ChatRunState::Live(_) => true,
            ChatRunState::Cancelled { inserted_at, .. } => {
                now.saturating_duration_since(*inserted_at) < CANCELLED_MARKER_TTL
            }
        });
    }

    fn enforce_cancelled_marker_limit(states: &mut HashMap<String, ChatRunState>) {
        while states
            .values()
            .filter(|state| matches!(state, ChatRunState::Cancelled { .. }))
            .count()
            > MAX_CANCELLED_MARKERS
        {
            let oldest = states
                .iter()
                .filter_map(|(run_id, state)| match state {
                    ChatRunState::Cancelled { sequence, .. } => Some((run_id.clone(), *sequence)),
                    ChatRunState::Live(_) => None,
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
                .run_cancellable(Path::new("/project/a"), "run-a", async {
                    std::future::pending::<()>().await;
                    Ok::<_, String>(())
                })
                .await
        });
        tokio::task::yield_now().await;
        assert!(registry
            .cancel(Path::new("/project/a"), "run-a")
            .await
            .unwrap());
        assert!(registry
            .cancel(Path::new("/project/a"), "run-a")
            .await
            .unwrap());
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("cancelled provider future stayed active")
            .unwrap()
            .unwrap_err();
        assert!(error.contains("cancelled"));
        assert!(!registry
            .cancel(Path::new("/project/a"), "run-a")
            .await
            .unwrap());
        assert!(registry
            .run_cancellable(Path::new("/project/a"), "run-a", async {
                Ok::<_, String>(())
            })
            .await
            .unwrap_err()
            .contains("has been cancelled"));
    }

    #[tokio::test]
    async fn ai_chat_cancel_is_idempotent_for_unknown_or_finished_runs() {
        let registry = ChatRunRegistry::new();
        assert!(!registry
            .cancel(Path::new("/project/a"), "missing")
            .await
            .unwrap());
        assert_eq!(
            registry
                .run_cancellable(Path::new("/project/a"), "done", async {
                    Ok::<_, String>(42)
                })
                .await
                .unwrap(),
            42
        );
        assert!(!registry
            .cancel(Path::new("/project/a"), "done")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn a_new_run_id_is_independent_from_a_cancelled_run() {
        let registry = ChatRunRegistry::new();
        assert_eq!(
            registry
                .run_cancellable(Path::new("/project/a"), "run-b", async {
                    Ok::<_, String>("new")
                })
                .await
                .unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn project_b_cannot_cancel_or_reuse_project_a_run_id() {
        let registry = Arc::new(ChatRunRegistry::new());
        let runner = registry.clone();
        let task = tokio::spawn(async move {
            runner
                .run_cancellable(Path::new("/project/a"), "shared", async {
                    std::future::pending::<()>().await;
                    Ok::<_, String>(())
                })
                .await
        });
        tokio::task::yield_now().await;

        let cancel_error = registry
            .cancel(Path::new("/project/b"), "shared")
            .await
            .unwrap_err();
        assert!(cancel_error.contains("belongs to project"));
        let reuse_error = registry
            .run_cancellable(Path::new("/project/b"), "shared", async {
                Ok::<_, String>(())
            })
            .await
            .unwrap_err();
        assert!(reuse_error.contains("belongs to project"));

        assert!(registry
            .cancel(Path::new("/project/a"), "shared")
            .await
            .unwrap());
        task.await.unwrap().unwrap_err();
    }

    #[tokio::test]
    async fn cancel_before_register_rejects_the_late_provider_for_the_same_project() {
        let registry = ChatRunRegistry::new();
        assert!(!registry
            .cancel(Path::new("/project/a"), "late")
            .await
            .unwrap());
        let error = registry
            .run_cancellable(Path::new("/project/a"), "late", async {
                Ok::<_, String>(())
            })
            .await
            .unwrap_err();
        assert!(error.contains("has been cancelled"));
        assert!(registry
            .run_cancellable(Path::new("/project/a"), "late", async {
                Ok::<_, String>(())
            })
            .await
            .unwrap_err()
            .contains("has been cancelled"));
    }

    #[tokio::test]
    async fn another_project_cannot_consume_a_cancel_before_register_marker() {
        let registry = ChatRunRegistry::new();
        assert!(!registry
            .cancel(Path::new("/project/a"), "late")
            .await
            .unwrap());
        assert!(registry
            .run_cancellable(Path::new("/project/b"), "late", async {
                Ok::<_, String>(())
            })
            .await
            .unwrap_err()
            .contains("belongs to project"));
        assert!(registry
            .run_cancellable(Path::new("/project/a"), "late", async {
                Ok::<_, String>(())
            })
            .await
            .unwrap_err()
            .contains("has been cancelled"));
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_before_register_markers_expire_and_are_bounded() {
        let registry = ChatRunRegistry::new();
        for index in 0..=MAX_CANCELLED_MARKERS {
            assert!(!registry
                .cancel(Path::new("/project/a"), &format!("late-{index}"))
                .await
                .unwrap());
        }
        assert_eq!(
            registry
                .states
                .lock()
                .await
                .values()
                .filter(|state| matches!(state, ChatRunState::Cancelled { .. }))
                .count(),
            MAX_CANCELLED_MARKERS
        );
        assert!(registry
            .run_cancellable(
                Path::new("/project/a"),
                &format!("late-{MAX_CANCELLED_MARKERS}"),
                async { Ok::<_, String>(()) },
            )
            .await
            .unwrap_err()
            .contains("has been cancelled"));
        assert_eq!(
            registry
                .run_cancellable(Path::new("/project/a"), "late-0", async {
                    Ok::<_, String>(7)
                })
                .await
                .unwrap(),
            7
        );

        assert!(!registry
            .cancel(Path::new("/project/a"), "expires")
            .await
            .unwrap());
        tokio::time::advance(CANCELLED_MARKER_TTL).await;
        assert_eq!(
            registry
                .run_cancellable(Path::new("/project/a"), "expires", async {
                    Ok::<_, String>(7)
                })
                .await
                .unwrap(),
            7
        );
    }
}
