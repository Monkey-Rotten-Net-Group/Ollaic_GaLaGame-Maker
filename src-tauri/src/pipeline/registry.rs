//! Tauri-free registry of live runs with project ownership enforcement.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::pipeline::run_control::RunHandle;

/// A live run held in memory, bound to the project that owns it.
#[derive(Clone)]
pub struct ManagedRun {
    pub handle: Arc<RunHandle>,
    pub project_path: PathBuf,
    pub driving: Arc<AtomicBool>,
}

/// Maps a `run_id` to its live `ManagedRun` and serializes lifecycle changes
/// that acquire a project's single active-run slot.
pub struct RunRegistry {
    runs: tokio::sync::Mutex<HashMap<String, ManagedRun>>,
}

impl RunRegistry {
    pub fn new() -> Self {
        RunRegistry {
            runs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    async fn insert(&self, run_id: String, run: ManagedRun) {
        self.runs.lock().await.insert(run_id, run);
    }

    /// Atomically reserve a project's active-run slot, create the run, and
    /// publish it by id. A non-terminal run owns the project whether it is
    /// currently running or paused.
    pub async fn insert_active_with(
        &self,
        run_id: &str,
        project_path: &Path,
        make_run: impl FnOnce() -> Result<ManagedRun, String>,
    ) -> Result<ManagedRun, String> {
        let mut guard = self.runs.lock().await;
        if let Some(existing) = guard.get(run_id) {
            if same_project(&existing.project_path, project_path) {
                return Err(format!(
                    "run {} is already in memory for project {}; resume that live run instead",
                    run_id,
                    existing.project_path.display()
                ));
            }
            return Err(format!(
                "run {} belongs to project {}, not {}",
                run_id,
                existing.project_path.display(),
                project_path.display()
            ));
        }
        Self::ensure_project_available(&guard, project_path, run_id, Some(run_id)).await?;
        let run = make_run()?;
        guard.insert(run_id.to_string(), run.clone());
        Ok(run)
    }

    /// Resolve a live run, rejecting cross-project access.
    pub async fn resolve(&self, run_id: &str, caller_project: &Path) -> Result<ManagedRun, String> {
        let guard = self.runs.lock().await;
        let entry = guard
            .get(run_id)
            .ok_or_else(|| format!("run not found: {}", run_id))?;
        if !same_project(&entry.project_path, caller_project) {
            return Err(format!(
                "run {} belongs to project {}, not {}",
                run_id,
                entry.project_path.display(),
                caller_project.display()
            ));
        }
        Ok(entry.clone())
    }

    /// Resolve a live run when present, while preserving the caller's ability
    /// to fall back to project-owned persisted state when no live run exists.
    pub async fn resolve_if_present(
        &self,
        run_id: &str,
        caller_project: &Path,
    ) -> Result<Option<ManagedRun>, String> {
        let guard = self.runs.lock().await;
        let Some(entry) = guard.get(run_id) else {
            return Ok(None);
        };
        if !same_project(&entry.project_path, caller_project) {
            return Err(format!(
                "run {} belongs to project {}, not {}",
                run_id,
                entry.project_path.display(),
                caller_project.display()
            ));
        }
        Ok(Some(entry.clone()))
    }

    /// Insert a persisted run if absent without attaching it alongside a
    /// different active run for the same project.
    pub async fn attach_if_needed(
        &self,
        run_id: &str,
        caller_project: &Path,
        make_run: impl FnOnce() -> Result<ManagedRun, String>,
    ) -> Result<(), String> {
        let mut guard = self.runs.lock().await;
        if let Some(existing) = guard.get(run_id) {
            if !same_project(&existing.project_path, caller_project) {
                return Err(format!(
                    "run {} belongs to project {}, not {}",
                    run_id,
                    existing.project_path.display(),
                    caller_project.display()
                ));
            }
            return Ok(());
        }
        Self::ensure_project_available(&guard, caller_project, run_id, Some(run_id)).await?;
        let run = make_run()?;
        guard.insert(run_id.to_string(), run);
        Ok(())
    }

    /// Run an operation that may reactivate a terminal run while holding the
    /// same project-level claim used by new starts and crash-resumes.
    pub async fn with_project_activation<T, F, Fut>(
        &self,
        run_id: &str,
        caller_project: &Path,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce(ManagedRun) -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        let guard = self.runs.lock().await;
        let entry = guard
            .get(run_id)
            .ok_or_else(|| format!("run not found: {}", run_id))?;
        if !same_project(&entry.project_path, caller_project) {
            return Err(format!(
                "run {} belongs to project {}, not {}",
                run_id,
                entry.project_path.display(),
                caller_project.display()
            ));
        }
        Self::ensure_project_available(&guard, caller_project, run_id, Some(run_id)).await?;
        operation(entry.clone()).await
    }

    async fn ensure_project_available(
        runs: &HashMap<String, ManagedRun>,
        project_path: &Path,
        requested_run_id: &str,
        excluded_run_id: Option<&str>,
    ) -> Result<(), String> {
        for (run_id, run) in runs {
            if excluded_run_id == Some(run_id.as_str())
                || !same_project(&run.project_path, project_path)
            {
                continue;
            }
            if !run.handle.state().lock().await.status.is_terminal() {
                return Err(format!(
                    "project {} already has active run {}; finish or stop it before activating run {}",
                    project_path.display(),
                    run_id,
                    requested_run_id
                ));
            }
        }
        for run in crate::pipeline::store::list_run_states(project_path)
            .map_err(|error| format!("failed to inspect persisted runs: {error}"))?
        {
            if excluded_run_id == Some(run.run_id.as_str()) || run.status.is_terminal() {
                continue;
            }
            return Err(format!(
                "project {} already has active run {}; finish or stop it before activating run {}",
                project_path.display(),
                run.run_id,
                requested_run_id
            ));
        }
        Ok(())
    }
}

fn same_project(left: &Path, right: &Path) -> bool {
    project_key(left) == project_key(right)
}

fn project_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl Default for RunRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::dsl::default_recipe;
    use crate::pipeline::events::RecordingSink;
    use crate::pipeline::scheduler::Pipeline;
    use crate::pipeline::state::{RunStatus, SystemClock};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let nonce = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ollaic_registry_{}_{}_{}",
                label,
                std::process::id(),
                nonce
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn project(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn make_run(project_path: &Path, run_id: &str) -> ManagedRun {
        std::fs::create_dir_all(project_path).unwrap();
        let pipeline = Pipeline::with_default_agents();
        let sink = RecordingSink::new();
        let handle = pipeline
            .create_run(
                project_path,
                run_id,
                "brief",
                &default_recipe(),
                &SystemClock,
                &sink,
            )
            .unwrap();
        ManagedRun {
            handle,
            project_path: project_path.to_path_buf(),
            driving: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn resolve_rejects_cross_project_access() {
        let root = TestRoot::new("resolve");
        let registry = RunRegistry::new();
        let path_a = root.project("a");
        let path_b = root.project("b");
        registry
            .insert("run_a".to_string(), make_run(&path_a, "run_a"))
            .await;
        assert!(registry.resolve("run_a", &path_a).await.is_ok());
        let err = registry.resolve("run_a", &path_b).await.err().unwrap();
        assert!(err.contains("belongs to project"));
    }

    #[tokio::test]
    async fn optional_live_resolution_rejects_cross_project_access_without_hiding_missing_runs() {
        let root = TestRoot::new("optional_resolve");
        let registry = RunRegistry::new();
        let path_a = root.project("a");
        let path_b = root.project("b");
        registry
            .insert("run_a".to_string(), make_run(&path_a, "run_a"))
            .await;

        assert!(registry
            .resolve_if_present("missing", &path_b)
            .await
            .unwrap()
            .is_none());
        let error = registry
            .resolve_if_present("run_a", &path_b)
            .await
            .err()
            .unwrap();
        assert!(error.contains("belongs to project"));
    }

    #[tokio::test]
    async fn attach_if_needed_rejects_project_mismatch() {
        let root = TestRoot::new("attach");
        let registry = RunRegistry::new();
        let path_a = root.project("a");
        let path_b = root.project("b");
        registry
            .insert("run_a".to_string(), make_run(&path_a, "run_a"))
            .await;
        let err = registry
            .attach_if_needed("run_a", &path_b, || unreachable!())
            .await
            .err()
            .unwrap();
        assert!(err.contains("belongs to project"));
    }

    #[tokio::test]
    async fn concurrent_active_inserts_create_only_one_run_for_a_project() {
        let root = TestRoot::new("concurrent_claim");
        let project = root.project("project");
        let registry = RunRegistry::new();
        let creations = AtomicUsize::new(0);

        let first = registry.insert_active_with("run_a", &project, || {
            creations.fetch_add(1, Ordering::SeqCst);
            Ok(make_run(&project, "run_a"))
        });
        let second = registry.insert_active_with("run_b", &project, || {
            creations.fetch_add(1, Ordering::SeqCst);
            Ok(make_run(&project, "run_b"))
        });
        let (first, second) = tokio::join!(first, second);

        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert_eq!(creations.load(Ordering::SeqCst), 1);
        let error = first.err().or_else(|| second.err()).unwrap();
        assert!(error.contains("already has active run"));
        assert!(error.contains("finish or stop it"));
    }

    #[tokio::test]
    async fn terminal_run_releases_project_for_a_new_run() {
        let root = TestRoot::new("terminal_release");
        let project = root.project("project");
        let registry = RunRegistry::new();
        let first = registry
            .insert_active_with("run_a", &project, || Ok(make_run(&project, "run_a")))
            .await
            .unwrap();
        {
            let mut state = first.handle.state().lock().await;
            state.status = RunStatus::Completed;
            crate::pipeline::store::save_run_state(&project, &state).unwrap();
        }

        registry
            .insert_active_with("run_b", &project, || Ok(make_run(&project, "run_b")))
            .await
            .unwrap();

        assert!(registry.resolve("run_a", &project).await.is_ok());
        assert!(registry.resolve("run_b", &project).await.is_ok());
    }

    #[tokio::test]
    async fn attach_does_not_mutate_a_project_owned_by_another_active_run() {
        let root = TestRoot::new("attach_claim");
        let project = root.project("project");
        let registry = RunRegistry::new();
        registry
            .insert_active_with("run_a", &project, || Ok(make_run(&project, "run_a")))
            .await
            .unwrap();
        let attached = AtomicBool::new(false);

        let error = registry
            .attach_if_needed("run_b", &project, || {
                attached.store(true, Ordering::SeqCst);
                Ok(make_run(&project, "run_b"))
            })
            .await
            .unwrap_err();

        assert!(!attached.load(Ordering::SeqCst));
        assert!(error.contains("already has active run run_a"));
    }

    #[tokio::test]
    async fn persisted_unfinished_run_blocks_attach_after_restart() {
        let root = TestRoot::new("persisted_attach_claim");
        let project = root.project("project");
        let terminal = make_run(&project, "run_terminal");
        {
            let mut state = terminal.handle.state().lock().await;
            state.status = RunStatus::Completed;
            crate::pipeline::store::save_run_state(&project, &state).unwrap();
        }
        let _unfinished = make_run(&project, "run_unfinished");
        let registry = RunRegistry::new();

        let error = registry
            .attach_if_needed("run_terminal", &project, || Ok(terminal))
            .await
            .unwrap_err();

        assert!(error.contains("already has active run run_unfinished"));
        assert!(registry
            .resolve_if_present("run_terminal", &project)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn persisted_unfinished_run_blocks_resume_after_restart() {
        let root = TestRoot::new("persisted_resume_claim");
        let project = root.project("project");
        let resumable = make_run(&project, "run_resumable");
        let _unfinished = make_run(&project, "run_unfinished");
        let registry = RunRegistry::new();

        let error = registry
            .insert_active_with("run_resumable", &project, || Ok(resumable))
            .await
            .err()
            .expect("another persisted unfinished run must keep the project claim");

        assert!(error.contains("already has active run run_unfinished"));
        assert!(registry
            .resolve_if_present("run_resumable", &project)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn persisted_unfinished_run_blocks_reactivation() {
        let root = TestRoot::new("persisted_reactivation_claim");
        let project = root.project("project");
        let terminal = make_run(&project, "run_terminal");
        {
            let mut state = terminal.handle.state().lock().await;
            state.status = RunStatus::Failed;
            crate::pipeline::store::save_run_state(&project, &state).unwrap();
        }
        let registry = RunRegistry::new();
        registry.insert("run_terminal".to_string(), terminal).await;
        let _unfinished = make_run(&project, "run_unfinished");

        let error = registry
            .with_project_activation("run_terminal", &project, |_| async { Ok(()) })
            .await
            .unwrap_err();

        assert!(error.contains("already has active run run_unfinished"));
    }

    #[tokio::test]
    async fn terminal_run_cannot_reactivate_while_a_new_run_owns_the_project() {
        let root = TestRoot::new("reactivation_claim");
        let project = root.project("project");
        let registry = RunRegistry::new();
        let first = registry
            .insert_active_with("run_a", &project, || Ok(make_run(&project, "run_a")))
            .await
            .unwrap();
        {
            let mut state = first.handle.state().lock().await;
            state.status = RunStatus::Failed;
            crate::pipeline::store::save_run_state(&project, &state).unwrap();
        }
        registry
            .insert_active_with("run_b", &project, || Ok(make_run(&project, "run_b")))
            .await
            .unwrap();
        let reactivated = AtomicBool::new(false);

        let error = registry
            .with_project_activation("run_a", &project, |_| async {
                reactivated.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap_err();

        assert!(!reactivated.load(Ordering::SeqCst));
        assert!(error.contains("already has active run run_b"));
    }
}
