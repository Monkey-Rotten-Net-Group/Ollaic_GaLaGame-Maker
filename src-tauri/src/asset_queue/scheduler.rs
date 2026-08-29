use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{Mutex, Semaphore};

use super::binder::rebind_asset;
use super::store::{load_queue, save_queue};
use super::transaction::{commit_generated_binding, recover_pending};
use super::types::{AssetAttempt, AssetKind, AssetQueue, AssetTask, AssetTaskStatus};
use crate::story_plan::types::StoryPlan;

pub const ASSET_QUEUE_CANCELLED: &str = "asset queue cancelled";

pub struct GeneratedArtifact {
    pub extension: String,
    pub bytes: Vec<u8>,
    pub used_local_fallback: bool,
}

pub trait AssetGenerator: Send + Sync {
    fn preflight(&self, _task: &AssetTask) -> Result<(), String> {
        Ok(())
    }

    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>>;
}

/// Generate all runnable tasks with per-capability limits, then bind successful
/// artifacts serially so scene and metadata rewrites cannot lose each other.
#[cfg(test)]
pub async fn run_queue(
    project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
    generator: Arc<dyn AssetGenerator>,
) -> Result<AssetQueue, String> {
    run_queue_cancellable(
        project_path,
        run_id,
        plan,
        generator,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
    )
    .await
}

pub async fn run_queue_cancellable(
    project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
    generator: Arc<dyn AssetGenerator>,
    cancelled: Arc<AtomicBool>,
    binding_gate: Arc<Mutex<()>>,
) -> Result<AssetQueue, String> {
    let _queue_guard = super::lock_queue_writes().await;
    recover_pending(project_path)?;
    let mut queue = load_queue(project_path)?;
    let same_run = queue.run_id == run_id;
    queue = if same_run {
        // The upstream scene may have been re-run since this queue was derived;
        // re-derive so moved dialogue regenerates instead of failing the
        // bind_tts text check. Succeeded tasks whose text/target is unchanged
        // are preserved, so this only re-runs what the upstream edit touched.
        super::store::rederive_queue(project_path, run_id, plan, &queue)?
    } else {
        super::store::derive_queue(project_path, run_id, plan)?
    };
    validate_limits(&queue)?;
    if same_run {
        for task in queue
            .tasks
            .iter_mut()
            .filter(|task| task.status == AssetTaskStatus::Succeeded)
        {
            let _binding_guard = binding_gate.lock().await;
            if cancelled.load(Ordering::SeqCst) {
                return Err(ASSET_QUEUE_CANCELLED.to_string());
            }
            if let Err(error) = rebind_asset(project_path, task) {
                task.status = AssetTaskStatus::Failed;
                task.error = Some(format!("rebinding failed: {error}"));
            }
        }
    }
    let attempt_budget = queue.limits.max_retries + 1;
    let mut runnable = Vec::new();
    for (index, task) in queue.tasks.iter_mut().enumerate() {
        if task.status == AssetTaskStatus::Succeeded {
            continue;
        }
        if let Err(error) = generator.preflight(task) {
            task.status = AssetTaskStatus::Pending;
            task.error = Some(format!("pending configuration: {error}"));
            continue;
        }
        let was_blocked = task
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("pending configuration:"));
        let limit = if same_run && (task.status == AssetTaskStatus::Failed || was_blocked) {
            task.attempts.len() as u32 + attempt_budget
        } else {
            attempt_budget
        };
        task.status = AssetTaskStatus::Pending;
        task.error = None;
        runnable.push((index, limit));
    }
    queue.updated_at = now_ms();
    save_queue(project_path, &queue)?;
    let queue = Arc::new(Mutex::new(queue));
    let image = Arc::new(Semaphore::new(queue.lock().await.limits.image));
    let tts = Arc::new(Semaphore::new(queue.lock().await.limits.tts));
    let music = Arc::new(Semaphore::new(queue.lock().await.limits.music));
    let project_path = project_path.to_path_buf();
    let mut futures = FuturesUnordered::new();

    for (index, attempt_limit) in runnable {
        let queue = queue.clone();
        let generator = generator.clone();
        let project_path = project_path.clone();
        let semaphore = {
            let task = queue.lock().await.tasks[index].clone();
            match task.kind {
                AssetKind::Background | AssetKind::Figure => image.clone(),
                AssetKind::Tts => tts.clone(),
                AssetKind::Bgm | AssetKind::Sfx => music.clone(),
            }
        };
        futures.push(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| "asset semaphore closed".to_string())?;
            generate_task(
                &project_path,
                &queue,
                index,
                attempt_limit,
                generator.as_ref(),
            )
            .await
        });
    }

    let mut generated = Vec::new();
    while let Some(result) = futures.next().await {
        if let Some(index) = result? {
            generated.push(index);
        }
    }
    generated.sort_unstable();

    for (position, &index) in generated.iter().enumerate() {
        let _binding_guard = binding_gate.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            let mut state = queue.lock().await;
            for &pending in &generated[position..] {
                if state.tasks[pending].status != AssetTaskStatus::Succeeded {
                    state.tasks[pending].status = AssetTaskStatus::Pending;
                }
            }
            state.updated_at = now_ms();
            save_queue(&project_path, &state)?;
            return Err(ASSET_QUEUE_CANCELLED.to_string());
        }
        let mut state = queue.lock().await;
        *state = commit_generated_binding(&project_path, &state, index)?;
    }
    let result = queue.lock().await.clone();
    Ok(result)
}

async fn generate_task(
    project_path: &Path,
    queue: &Mutex<AssetQueue>,
    index: usize,
    attempt_limit: u32,
    generator: &dyn AssetGenerator,
) -> Result<Option<usize>, String> {
    loop {
        let (task, attempt) = {
            let mut state = queue.lock().await;
            let task = &mut state.tasks[index];
            let attempt = task.attempts.len() as u32 + 1;
            if attempt > attempt_limit {
                task.status = AssetTaskStatus::Failed;
                task.error
                    .get_or_insert_with(|| "retry limit reached".to_string());
                state.updated_at = now_ms();
                save_queue(project_path, &state)?;
                return Ok(None);
            }
            task.status = if attempt == 1 {
                AssetTaskStatus::Running
            } else {
                AssetTaskStatus::Retrying
            };
            task.error = None;
            let snapshot = task.clone();
            state.updated_at = now_ms();
            save_queue(project_path, &state)?;
            (snapshot, attempt)
        };
        let started_at = now_ms();
        let generated = generator
            .generate(&task)
            .await
            .and_then(|generated| write_artifact(project_path, &task, attempt, generated));
        match generated {
            Ok((artifact, used_local_fallback)) => {
                let mut state = queue.lock().await;
                state.tasks[index].attempts.push(AssetAttempt {
                    attempt,
                    started_at,
                    finished_at: now_ms(),
                    artifact: Some(artifact.to_string_lossy().into_owned()),
                    error: None,
                    used_local_fallback,
                });
                state.updated_at = now_ms();
                save_queue(project_path, &state)?;
                return Ok(Some(index));
            }
            Err(error) => {
                if error == ASSET_QUEUE_CANCELLED {
                    return Err(error);
                }
                let mut state = queue.lock().await;
                let task = &mut state.tasks[index];
                task.attempts.push(AssetAttempt {
                    attempt,
                    started_at,
                    finished_at: now_ms(),
                    artifact: None,
                    error: Some(error.clone()),
                    used_local_fallback: false,
                });
                task.error = Some(error);
                task.status = if attempt < attempt_limit {
                    AssetTaskStatus::Retrying
                } else {
                    AssetTaskStatus::Failed
                };
                state.updated_at = now_ms();
                save_queue(project_path, &state)?;
                if attempt >= attempt_limit {
                    return Ok(None);
                }
            }
        }
    }
}

fn write_artifact(
    project_path: &Path,
    task: &AssetTask,
    attempt: u32,
    generated: GeneratedArtifact,
) -> Result<(std::path::PathBuf, bool), String> {
    validate_extension(&generated.extension)?;
    validate_component(&task.id)?;
    let artifact = project_path
        .join(".ollaic/artifacts/assets")
        .join(&task.id)
        .join(format!("{attempt}.{}", generated.extension));
    if let Some(parent) = artifact.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create artifact directory {}: {error}",
                parent.display()
            )
        })?;
    }
    crate::json_store::write_crash_safe(&artifact, &generated.bytes)
        .map_err(|error| format!("failed to write artifact {}: {error}", artifact.display()))?;
    Ok((artifact, generated.used_local_fallback))
}

fn validate_limits(queue: &AssetQueue) -> Result<(), String> {
    if queue.limits.image == 0 || queue.limits.tts == 0 || queue.limits.music == 0 {
        return Err("asset queue concurrency limits must be greater than zero".to_string());
    }
    Ok(())
}

fn validate_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(format!("invalid asset task id: {value}"));
    }
    Ok(())
}

fn validate_extension(value: &str) -> Result<(), String> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return Err(format!("invalid generated artifact extension: {value}"));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod tests;
