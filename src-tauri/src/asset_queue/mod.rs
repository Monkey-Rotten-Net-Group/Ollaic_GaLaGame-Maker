pub mod binder;
pub mod commands;
pub mod scheduler;
pub mod store;
pub(crate) mod transaction;
pub mod types;

pub use scheduler::{run_queue_cancellable, AssetGenerator, GeneratedArtifact};
#[cfg(test)]
pub use store::load_queue;
pub use types::{AssetKind, AssetQueue, AssetTask, AssetTaskStatus};

// ponytail: one process-wide lock is enough for the current single-project flow;
// use per-project locks if concurrent project generation becomes a real workflow.
static QUEUE_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn lock_queue_writes() -> tokio::sync::MutexGuard<'static, ()> {
    QUEUE_WRITE_LOCK.lock().await
}
