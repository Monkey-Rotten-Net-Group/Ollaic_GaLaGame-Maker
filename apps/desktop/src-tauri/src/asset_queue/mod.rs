pub mod binder;
pub mod commands;
pub mod scheduler;
pub mod store;
pub(crate) mod transaction;
pub mod types;

pub use scheduler::{
    run_queue_cancellable, run_queue_scoped_cancellable, AssetGenerator, GeneratedArtifact,
    QueueScope,
};
#[cfg(test)]
pub use store::load_queue;
pub use types::{AssetKind, AssetQueue, AssetTask, AssetTaskStatus};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

// Queue generation and artifact commands serialize per project. Unrelated
// projects must keep progressing while a provider or user review is pending.
type QueueLocks = Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>;
static QUEUE_WRITE_LOCKS: OnceLock<QueueLocks> = OnceLock::new();

pub async fn lock_queue_writes(
    project_path: &Path,
) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
    let project = project_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve asset queue project: {error}"))?;
    let lock = {
        let mut locks = QUEUE_WRITE_LOCKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "asset queue lock registry is poisoned".to_string())?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&project).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(tokio::sync::Mutex::new(()));
            locks.insert(project, Arc::downgrade(&lock));
            lock
        }
    };
    Ok(lock.lock_owned().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    #[tokio::test]
    async fn queue_locks_serialize_canonical_project_paths_without_blocking_other_projects() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ollaic_queue_locks_{nonce}"));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let first_guard = lock_queue_writes(&first).await.unwrap();
        assert!(lock_queue_writes(&first.join(".")).now_or_never().is_none());
        let second_guard = lock_queue_writes(&second).now_or_never().unwrap().unwrap();
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(&first, &alias).unwrap();
            assert!(lock_queue_writes(&alias).now_or_never().is_none());
        }
        drop(first_guard);
        assert!(lock_queue_writes(&first).now_or_never().unwrap().is_ok());
        drop(second_guard);
        std::fs::remove_dir_all(root).unwrap();
    }
}
