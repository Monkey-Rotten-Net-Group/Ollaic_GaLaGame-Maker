//! Tauri-free registry of live runs with project ownership enforcement.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::pipeline::scheduler::RunHandle;

/// A live run held in memory, bound to the project that owns it.
#[derive(Clone)]
pub struct ManagedRun {
    pub handle: Arc<RunHandle>,
    pub project_path: PathBuf,
    pub driving: Arc<AtomicBool>,
}

/// Maps a `run_id` to its live `ManagedRun`. Resolves by id but refuses to
/// hand a run to a caller whose project path differs, closing the cross-project
/// run-id hijack where a run created in project A could be reached from
/// project B.
pub struct RunRegistry {
    runs: tokio::sync::Mutex<HashMap<String, ManagedRun>>,
}

impl RunRegistry {
    pub fn new() -> Self {
        RunRegistry {
            runs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, run_id: String, run: ManagedRun) {
        self.runs.lock().await.insert(run_id, run);
    }

    pub async fn contains(&self, run_id: &str) -> bool {
        self.runs.lock().await.contains_key(run_id)
    }

    pub async fn get(&self, run_id: &str) -> Option<ManagedRun> {
        self.runs.lock().await.get(run_id).cloned()
    }

    /// Resolve a live run, rejecting cross-project access.
    pub async fn resolve(&self, run_id: &str, caller_project: &Path) -> Result<ManagedRun, String> {
        let guard = self.runs.lock().await;
        let entry = guard
            .get(run_id)
            .ok_or_else(|| format!("run not found: {}", run_id))?;
        if entry.project_path != caller_project {
            return Err(format!(
                "run {} belongs to project {}, not {}",
                run_id,
                entry.project_path.display(),
                caller_project.display()
            ));
        }
        Ok(entry.clone())
    }

    /// Insert a run if absent; reject if a run with this id already exists
    /// under a different project.
    pub async fn attach_if_needed(
        &self,
        run_id: &str,
        caller_project: &Path,
        make_run: impl FnOnce() -> Result<ManagedRun, String>,
    ) -> Result<(), String> {
        let mut guard = self.runs.lock().await;
        if let Some(existing) = guard.get(run_id) {
            if existing.project_path != caller_project {
                return Err(format!(
                    "run {} belongs to project {}, not {}",
                    run_id,
                    existing.project_path.display(),
                    caller_project.display()
                ));
            }
            return Ok(());
        }
        let run = make_run()?;
        guard.insert(run_id.to_string(), run);
        Ok(())
    }
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
    use crate::pipeline::state::SystemClock;

    fn make_run(project: &str, run_id: &str) -> ManagedRun {
        let project_path = std::env::temp_dir().join("ollaic_registry").join(project);
        let _ = std::fs::remove_dir_all(&project_path);
        std::fs::create_dir_all(&project_path).unwrap();
        let pipeline = Pipeline::with_default_agents();
        let sink = RecordingSink::new();
        let handle = pipeline
            .create_run(
                &project_path,
                run_id,
                "brief",
                &default_recipe(),
                &SystemClock,
                &sink,
            )
            .unwrap();
        ManagedRun {
            handle,
            project_path,
            driving: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn resolve_rejects_cross_project_access() {
        let registry = RunRegistry::new();
        let path_a = std::env::temp_dir().join("ollaic_registry").join("a");
        let path_b = std::env::temp_dir().join("ollaic_registry").join("b");
        registry
            .insert("run_a".to_string(), make_run("a", "run_a"))
            .await;
        assert!(registry.resolve("run_a", &path_a).await.is_ok());
        let err = registry.resolve("run_a", &path_b).await.err().unwrap();
        assert!(err.contains("belongs to project"));
    }

    #[tokio::test]
    async fn attach_if_needed_rejects_project_mismatch() {
        let registry = RunRegistry::new();
        let path_b = std::env::temp_dir().join("ollaic_registry").join("b");
        registry
            .insert("run_a".to_string(), make_run("a", "run_a"))
            .await;
        let err = registry
            .attach_if_needed("run_a", &path_b, || unreachable!())
            .await
            .err()
            .unwrap();
        assert!(err.contains("belongs to project"));
    }
}
