use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{Mutex, Semaphore};

use super::binder::{find_imported_asset_file, rebind_asset_scoped, BindingScope};
use super::store::{load_queue, save_queue};
use super::transaction::{
    bind_imported_asset_scoped, commit_generated_binding_scoped, recover_pending,
};
use super::types::{
    AssetAttempt, AssetKind, AssetQueue, AssetTask, AssetTaskStatus, PENDING_CONFIGURATION_PREFIX,
    PENDING_MANUAL_IMPORT_PREFIX,
};
use crate::story_plan::types::StoryPlan;

pub const ASSET_QUEUE_CANCELLED: &str = "asset queue cancelled";

pub struct QueueScope {
    pub task_ids: HashSet<String>,
    /// None selects setup-only asset binding without touching compiled scenes.
    pub scene_file: Option<String>,
}

#[derive(Default)]
pub struct QueueRunOptions<'a> {
    pub scope: Option<&'a QueueScope>,
    pub retry_placeholders: bool,
}

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

/// Base figures and non-figure tasks run before expression variants.
pub fn is_pass1_anchor_task(task: &AssetTask) -> bool {
    match task.kind {
        AssetKind::Background | AssetKind::Tts | AssetKind::Bgm | AssetKind::Sfx => true,
        AssetKind::Figure => task.emotion.as_deref().unwrap_or("default") == "default",
    }
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
        QueueRunOptions::default(),
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
    options: QueueRunOptions<'_>,
) -> Result<AssetQueue, String> {
    let scope = options.scope;
    let binding_scope = match scope {
        Some(QueueScope {
            scene_file: Some(file),
            ..
        }) => BindingScope::Scene(file),
        Some(_) => BindingScope::AssetsOnly,
        None => BindingScope::Project,
    };
    let is_active = |task: &AssetTask| scope.is_none_or(|scope| scope.task_ids.contains(&task.id));
    let _queue_guard = super::lock_queue_writes(project_path).await?;
    recover_pending(project_path)?;
    let mut queue = load_queue(project_path)?;
    let same_run = queue.run_id == run_id;
    queue = if let Some(scope) = scope {
        super::store::merge_scoped_queue(project_path, run_id, plan, &queue, &scope.task_ids)?
    } else if same_run {
        // The upstream scene may have been re-run since this queue was derived;
        // re-derive so moved dialogue regenerates instead of failing the
        // bind_tts text check. Succeeded tasks whose text/target is unchanged
        // are preserved, so this only re-runs what the upstream edit touched.
        super::store::rederive_queue(project_path, run_id, plan, &queue)?
    } else {
        super::store::derive_queue(project_path, run_id, plan)?
    };
    validate_limits(&queue)?;
    // A completed fallback records missing media, but has not satisfied the requested
    // generation. An explicit rerun retries it, including tasks that reused the
    // same placeholder as an import. Recovery keeps completed bindings intact.
    let fallback_files: HashSet<_> = queue
        .tasks
        .iter()
        .filter(|task| task.used_local_fallback && !task.kind.requires_manual_import())
        .filter_map(|task| {
            task.asset_file
                .as_ref()
                .map(|filename| (task.kind.game_dir(), filename.clone()))
        })
        .collect();
    for task in queue
        .tasks
        .iter_mut()
        .filter(|task| options.retry_placeholders && is_active(task))
    {
        let reused_fallback = task.asset_file.as_ref().is_some_and(|filename| {
            fallback_files.contains(&(task.kind.game_dir(), filename.clone()))
        });
        if !task.kind.requires_manual_import() && (task.used_local_fallback || reused_fallback) {
            task.status = AssetTaskStatus::Pending;
            task.used_local_fallback = true;
        }
    }
    if same_run || scope.is_some() {
        for task in queue.tasks.iter_mut().filter(|task| {
            is_active(task)
                && task.status == AssetTaskStatus::Succeeded
                && task.asset_file.is_some()
        }) {
            let _binding_guard = binding_gate.lock().await;
            if cancelled.load(Ordering::SeqCst) {
                return Err(ASSET_QUEUE_CANCELLED.to_string());
            }
            if let Err(error) = rebind_asset_scoped(project_path, task, binding_scope) {
                task.status = AssetTaskStatus::Failed;
                task.error = Some(format!("rebinding failed: {error}"));
            }
        }
    }
    let attempt_budget = queue.limits.max_retries + 1;
    let mut runnable = Vec::new();
    // Reuse imported assets before checking provider configuration.
    let mut imported = Vec::new();
    for (index, task) in queue.tasks.iter_mut().enumerate() {
        if !is_active(task) || task.status == AssetTaskStatus::Succeeded {
            continue;
        }
        // The existing binding is a known placeholder, never a manual override.
        let imported_file = if task.used_local_fallback && task.asset_file.is_some() {
            Ok(None)
        } else {
            find_imported_asset_file(project_path, task)
        };
        match imported_file {
            Ok(Some(filename)) => {
                imported.push((index, filename));
                continue;
            }
            Err(error) if task.kind.requires_manual_import() => {
                task.status = AssetTaskStatus::Pending;
                task.error = Some(format!("{PENDING_MANUAL_IMPORT_PREFIX}{error}"));
                continue;
            }
            _ => {}
        }
        if let Err(error) = generator.preflight(task) {
            task.status = AssetTaskStatus::Pending;
            task.error = Some(if task.kind.requires_manual_import() {
                format!("{PENDING_MANUAL_IMPORT_PREFIX}{error}")
            } else {
                format!("{PENDING_CONFIGURATION_PREFIX}{error}")
            });
            continue;
        }
        let was_blocked = task.error.as_deref().is_some_and(|error| {
            error.starts_with(PENDING_CONFIGURATION_PREFIX)
                || error.starts_with(PENDING_MANUAL_IMPORT_PREFIX)
        });
        let fresh_budget = task.used_local_fallback
            || ((same_run || scope.is_some())
                && (task.status == AssetTaskStatus::Failed || was_blocked))
            || (scope.is_some() && !task.attempts.is_empty());
        let limit = if fresh_budget {
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
    let audio = Arc::new(Semaphore::new(queue.lock().await.limits.music));
    let project_path_buf = project_path.to_path_buf();

    // Bind imported assets before starting generation.
    for (index, filename) in imported {
        let _binding_guard = binding_gate.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            return Err(ASSET_QUEUE_CANCELLED.to_string());
        }
        let task_id = queue.lock().await.tasks[index].id.clone();
        let bound =
            match bind_imported_asset_scoped(&project_path_buf, &task_id, &filename, binding_scope)
            {
                Ok(bound) => bound,
                Err(error) => {
                    let mut state = queue.lock().await;
                    if let Some(task) = state.tasks.get_mut(index) {
                        task.status = AssetTaskStatus::Pending;
                        task.error = Some(format!("imported binding failed: {error}"));
                    }
                    state.updated_at = now_ms();
                    save_queue(&project_path_buf, &state)?;
                    continue;
                }
            };
        *queue.lock().await = bound;
    }

    // Complete and bind anchors before starting expression variants.
    type RunnablePass = Vec<(usize, u32)>;
    let (pass1, pass2): (RunnablePass, RunnablePass) = {
        let state = queue.lock().await;
        runnable
            .into_iter()
            .partition(|(index, _)| is_pass1_anchor_task(&state.tasks[*index]))
    };

    // Generate anchors and non-figure assets.
    let mut pass1_futures = FuturesUnordered::new();
    for (index, attempt_limit) in pass1 {
        let queue = queue.clone();
        let generator = generator.clone();
        let project_path = project_path_buf.clone();
        let semaphore = {
            let task = queue.lock().await.tasks[index].clone();
            match task.kind {
                AssetKind::Background | AssetKind::Figure => image.clone(),
                AssetKind::Tts => tts.clone(),
                AssetKind::Bgm | AssetKind::Sfx => audio.clone(),
            }
        };
        pass1_futures.push(async move {
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

    let mut generated_pass1 = Vec::new();
    while let Some(result) = pass1_futures.next().await {
        if let Some(index) = result? {
            generated_pass1.push(index);
        }
    }
    generated_pass1.sort_unstable();

    // Commit anchors before expression generation.
    for (position, &index) in generated_pass1.iter().enumerate() {
        let _binding_guard = binding_gate.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            let mut state = queue.lock().await;
            for &pending in &generated_pass1[position..] {
                if state.tasks[pending].status != AssetTaskStatus::Succeeded {
                    state.tasks[pending].status = AssetTaskStatus::Pending;
                }
            }
            state.updated_at = now_ms();
            save_queue(&project_path_buf, &state)?;
            return Err(ASSET_QUEUE_CANCELLED.to_string());
        }
        let mut state = queue.lock().await;
        *state = commit_generated_binding_scoped(&project_path_buf, &state, index, binding_scope)?;
    }

    // Gate variants on their successfully committed default.
    let mut pass2_runnable = Vec::new();
    {
        let mut state = queue.lock().await;
        for (index, attempt_limit) in pass2 {
            let task = &state.tasks[index];
            let char_ref = task.character_ref.as_deref().unwrap_or("").to_string();
            // Files alone cannot satisfy this dependency: this run's default must bind successfully.
            let is_ready = !char_ref.is_empty()
                && state.tasks.iter().any(|anchor| {
                    anchor.kind == AssetKind::Figure
                        && anchor.character_ref.as_deref() == Some(char_ref.as_str())
                        && anchor.emotion.as_deref().unwrap_or("default") == "default"
                        && anchor.status == AssetTaskStatus::Succeeded
                });

            if is_ready {
                pass2_runnable.push((index, attempt_limit));
            } else {
                let task_mut = &mut state.tasks[index];
                task_mut.status = AssetTaskStatus::Failed;
                task_mut.error = Some(format!(
                    "角色「{char_ref}」的基础立绘 (default anchor) 未完成，无法生成表情差分"
                ));
            }
        }
        state.updated_at = now_ms();
        save_queue(&project_path_buf, &state)?;
    }

    let mut pass2_futures = FuturesUnordered::new();
    for (index, attempt_limit) in pass2_runnable {
        let queue = queue.clone();
        let generator = generator.clone();
        let project_path = project_path_buf.clone();
        let semaphore = image.clone();
        pass2_futures.push(async move {
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

    let mut generated_pass2 = Vec::new();
    while let Some(result) = pass2_futures.next().await {
        if let Some(index) = result? {
            generated_pass2.push(index);
        }
    }
    generated_pass2.sort_unstable();

    // Commit expression variants.
    for (position, &index) in generated_pass2.iter().enumerate() {
        let _binding_guard = binding_gate.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            let mut state = queue.lock().await;
            for &pending in &generated_pass2[position..] {
                if state.tasks[pending].status != AssetTaskStatus::Succeeded {
                    state.tasks[pending].status = AssetTaskStatus::Pending;
                }
            }
            state.updated_at = now_ms();
            save_queue(&project_path_buf, &state)?;
            return Err(ASSET_QUEUE_CANCELLED.to_string());
        }
        let mut state = queue.lock().await;
        *state = commit_generated_binding_scoped(&project_path_buf, &state, index, binding_scope)?;
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
        let generated = match generator.generate(&task).await {
            Ok(generated)
                if generated.used_local_fallback && !task.kind.requires_manual_import() =>
            {
                // Keep the unmet requirement without publishing blank media or binding it.
                let mut state = queue.lock().await;
                let task = &mut state.tasks[index];
                task.status = AssetTaskStatus::Succeeded;
                task.used_local_fallback = true;
                task.attempts.push(AssetAttempt {
                    attempt,
                    started_at,
                    finished_at: now_ms(),
                    artifact: None,
                    imported_file: None,
                    error: None,
                    used_local_fallback: true,
                });
                state.updated_at = now_ms();
                save_queue(project_path, &state)?;
                return Ok(None);
            }
            result => {
                result.and_then(|generated| write_artifact(project_path, &task, attempt, generated))
            }
        };
        match generated {
            Ok((artifact, used_local_fallback)) => {
                let mut state = queue.lock().await;
                state.tasks[index].attempts.push(AssetAttempt {
                    attempt,
                    started_at,
                    finished_at: now_ms(),
                    artifact: Some(artifact.to_string_lossy().into_owned()),
                    imported_file: None,
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
                    imported_file: None,
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
