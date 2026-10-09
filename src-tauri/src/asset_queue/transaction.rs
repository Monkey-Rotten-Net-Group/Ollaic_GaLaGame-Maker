use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::binder::BindingTransaction;
use super::store::{load_queue, queue_path, save_queue};
use super::types::{AssetAttempt, AssetQueue, AssetTask, AssetTaskStatus};

const TRANSACTION_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingTransaction {
    version: u32,
    previous_queue: AssetQueue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rollback_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    staged_artifact: Option<StagedArtifact>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagedArtifact {
    original: PathBuf,
    staged: PathBuf,
}

enum BindingCommitError {
    Binding(String),
    Persistence(String),
}

pub(crate) fn load_queue_consistent(project_path: &Path) -> Result<Option<AssetQueue>, String> {
    crate::project_lock::with_project_lock_unrecovered(project_path, || {
        crate::project_lock::recover_project_locked(project_path)?;
        queue_path(project_path)
            .is_file()
            .then(|| load_queue(project_path))
            .transpose()
    })
}

pub(crate) fn recover_pending(project_path: &Path) -> Result<(), String> {
    crate::project_lock::with_project_lock_unrecovered(project_path, || {
        crate::project_lock::recover_project_locked(project_path)
    })
}

pub(crate) fn commit_generated_binding(
    project_path: &Path,
    queue: &AssetQueue,
    task_index: usize,
) -> Result<AssetQueue, String> {
    crate::project_lock::with_project_lock_unrecovered(project_path, || {
        crate::project_lock::recover_project_locked(project_path)?;
        commit_generated_binding_locked_with(project_path, queue, task_index, save_queue)
    })
}

fn commit_generated_binding_locked_with(
    project_path: &Path,
    queue: &AssetQueue,
    task_index: usize,
    writer: impl FnOnce(&Path, &AssetQueue) -> Result<(), String>,
) -> Result<AssetQueue, String> {
    let task = queue
        .tasks
        .get(task_index)
        .ok_or_else(|| format!("asset task index out of range: {task_index}"))?;
    let pending = begin_binding_transaction_locked(project_path, queue)?;
    match persist_binding_locked_with(project_path, queue, task_index, task, writer) {
        Ok(queue) => {
            commit_pending_locked(project_path, pending)?;
            Ok(queue)
        }
        Err(BindingCommitError::Persistence(error)) => {
            let recovery = recover_pending_locked(project_path);
            Err(format!("{error}{}", rollback_suffix(recovery)))
        }
        Err(BindingCommitError::Binding(error)) => {
            recover_pending_locked(project_path)
                .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
            let mut failed = queue.clone();
            let task = &mut failed.tasks[task_index];
            task.status = AssetTaskStatus::Failed;
            task.error = Some(format!("binding failed: {error}"));
            failed.updated_at = now_ms();
            save_queue(project_path, &failed)?;
            Ok(failed)
        }
    }
}

pub(crate) fn promote_artifact(
    project_path: &Path,
    task_id: &str,
    attempt: u32,
) -> Result<AssetQueue, String> {
    crate::project_lock::with_project_lock_unrecovered(project_path, || {
        crate::project_lock::recover_project_locked(project_path)?;
        let queue = load_queue(project_path)?;
        let task_index = queue
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or_else(|| format!("asset task not found: {task_id}"))?;
        let selected = queue.tasks[task_index]
            .attempts
            .iter()
            .find(|item| item.attempt == attempt && item.artifact.is_some())
            .cloned()
            .ok_or_else(|| format!("asset artifact not found: {task_id}/{attempt}"))?;
        resolve_artifact(project_path, &queue, task_id, attempt)?;
        let mut candidate = queue.tasks[task_index].clone();
        candidate.attempts = vec![selected];
        candidate.used_local_fallback = candidate.attempts[0].used_local_fallback;
        let pending = begin_binding_transaction_locked(project_path, &queue)?;
        match persist_binding_locked_with(project_path, &queue, task_index, &candidate, save_queue)
        {
            Ok(updated) => {
                commit_pending_locked(project_path, pending)?;
                Ok(updated)
            }
            Err(error) => {
                let error = binding_commit_error(error);
                let recovery = recover_pending_locked(project_path);
                Err(format!("{error}{}", rollback_suffix(recovery)))
            }
        }
    })
}

/// Bind an audio file the user already imported into the project's asset
/// directory to a manual BGM/SFX task. Manual audio tasks never produce a
/// generated artifact, so this is their only completion path. The binding goes
/// through the same snapshot + journal transaction as a generated artifact, so
/// a failure leaves neither scene/metadata edits nor queue state behind.
pub(crate) fn bind_imported_audio(
    project_path: &Path,
    task_id: &str,
    filename: &str,
) -> Result<AssetQueue, String> {
    crate::project_lock::with_project_lock_unrecovered(project_path, || {
        crate::project_lock::recover_project_locked(project_path)?;
        let queue = load_queue(project_path)?;
        let task_index = queue
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or_else(|| format!("asset task not found: {task_id}"))?;
        let task = queue.tasks[task_index].clone();
        if !task.kind.requires_manual_import() {
            return Err(format!(
                "task {task_id} is not a manual audio task; use artifact promotion instead"
            ));
        }
        // Input the user controls is rejected outright: it is not a generation
        // failure, so it must not burn an attempt or flip the task to Failed.
        crate::asset_queue::binder::validate_imported_filename(filename)?;
        let imported_path = project_path
            .join("game")
            .join(task.kind.game_dir())
            .join(filename);
        if !imported_path.is_file() {
            return Err(format!(
                "imported audio file is missing: {}",
                imported_path.display()
            ));
        }
        // Re-binding the same file is a no-op beyond refreshing references, so
        // a repeated import stays idempotent instead of piling up attempts.
        if task.status == AssetTaskStatus::Succeeded && task.asset_file.as_deref() == Some(filename)
        {
            return rebind_imported_audio_locked(project_path, queue, task_index);
        }
        // Keep the full attempt history so numbers stay monotonic; repeating a
        // bind is already handled by the Succeeded short-circuit above.
        let mut candidate = task;
        let attempt_number = candidate.attempts.len() as u32 + 1;
        let started_at = now_ms();
        let pending = begin_binding_transaction_locked(project_path, &queue)?;
        let transaction =
            match BindingTransaction::apply_imported_locked(project_path, &candidate, filename) {
                Ok(transaction) => transaction,
                Err(error) => {
                    recover_pending_locked(project_path)
                        .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
                    let mut failed = queue.clone();
                    let mut failed_task = failed.tasks[task_index].clone();
                    // The failure is recorded on the untouched task, so its
                    // attempt number has to follow that task's own history.
                    let failed_attempt = failed_task.attempts.len() as u32 + 1;
                    failed_task.attempts.push(AssetAttempt {
                        attempt: failed_attempt,
                        started_at,
                        finished_at: now_ms(),
                        artifact: None,
                        imported_file: Some(filename.to_string()),
                        error: Some(error.clone()),
                        used_local_fallback: false,
                    });
                    failed_task.status = AssetTaskStatus::Failed;
                    failed_task.error = Some(format!("imported binding failed: {error}"));
                    failed.tasks[task_index] = failed_task;
                    failed.updated_at = now_ms();
                    save_queue(project_path, &failed)?;
                    return Ok(failed);
                }
            };
        let bound_filename = transaction.filename().to_string();
        candidate.status = AssetTaskStatus::Succeeded;
        candidate.asset_file = Some(bound_filename);
        candidate.error = None;
        candidate.used_local_fallback = false;
        candidate.attempts.push(AssetAttempt {
            attempt: attempt_number,
            started_at,
            finished_at: now_ms(),
            artifact: None,
            imported_file: Some(filename.to_string()),
            error: None,
            used_local_fallback: false,
        });
        let mut updated = queue.clone();
        updated.tasks[task_index] = candidate;
        updated.updated_at = now_ms();
        if let Err(error) = save_queue(project_path, &updated) {
            let rollback =
                combine_rollbacks([transaction.rollback(), save_queue(project_path, &queue)]);
            recover_pending_locked(project_path)?;
            return Err(format!(
                "failed to persist imported asset queue: {error}{}",
                rollback_suffix(rollback)
            ));
        }
        transaction.commit();
        commit_pending_locked(project_path, pending)?;
        Ok(updated)
    })
}

/// Refresh scene/metadata references for an already-satisfied manual audio
/// task without recording another attempt.
fn rebind_imported_audio_locked(
    project_path: &Path,
    queue: AssetQueue,
    task_index: usize,
) -> Result<AssetQueue, String> {
    let task = queue.tasks[task_index].clone();
    let filename = task
        .asset_file
        .clone()
        .ok_or_else(|| format!("task {} has no bound audio file", task.id))?;
    let pending = begin_binding_transaction_locked(project_path, &queue)?;
    let transaction =
        match BindingTransaction::apply_imported_locked(project_path, &task, &filename) {
            Ok(transaction) => transaction,
            Err(error) => {
                recover_pending_locked(project_path)
                    .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
                return Err(format!("rebinding imported audio failed: {error}"));
            }
        };
    let mut updated = queue.clone();
    updated.updated_at = now_ms();
    if let Err(error) = save_queue(project_path, &updated) {
        let rollback =
            combine_rollbacks([transaction.rollback(), save_queue(project_path, &queue)]);
        recover_pending_locked(project_path)?;
        return Err(format!(
            "failed to persist rebound asset queue: {error}{}",
            rollback_suffix(rollback)
        ));
    }
    transaction.commit();
    commit_pending_locked(project_path, pending)?;
    Ok(updated)
}

pub(crate) fn delete_artifact(
    project_path: &Path,
    task_id: &str,
    attempt: u32,
) -> Result<AssetQueue, String> {
    crate::project_lock::with_project_lock_unrecovered(project_path, || {
        crate::project_lock::recover_project_locked(project_path)?;
        let queue = load_queue(project_path)?;
        delete_artifact_locked_with(project_path, queue, task_id, attempt, save_queue)
    })
}

fn persist_binding_locked_with(
    project_path: &Path,
    queue: &AssetQueue,
    task_index: usize,
    binding_task: &AssetTask,
    writer: impl FnOnce(&Path, &AssetQueue) -> Result<(), String>,
) -> Result<AssetQueue, BindingCommitError> {
    let transaction = BindingTransaction::apply_locked(project_path, binding_task)
        .map_err(BindingCommitError::Binding)?;
    let mut updated = queue.clone();
    let task = &mut updated.tasks[task_index];
    task.status = AssetTaskStatus::Succeeded;
    task.asset_file = Some(transaction.filename().to_string());
    task.error = None;
    task.used_local_fallback = binding_task
        .attempts
        .iter()
        .rev()
        .find(|attempt| attempt.artifact.is_some())
        .is_some_and(|attempt| attempt.used_local_fallback);
    updated.updated_at = now_ms();

    if let Err(error) = writer(project_path, &updated) {
        let rollback = rollback_binding_and_queue(project_path, transaction, queue);
        return Err(BindingCommitError::Persistence(format!(
            "failed to persist bound asset queue: {error}{}",
            rollback_suffix(rollback)
        )));
    }
    transaction.commit();
    Ok(updated)
}

fn delete_artifact_locked_with(
    project_path: &Path,
    queue: AssetQueue,
    task_id: &str,
    attempt: u32,
    writer: impl FnOnce(&Path, &AssetQueue) -> Result<(), String>,
) -> Result<AssetQueue, String> {
    let artifact = resolve_artifact(project_path, &queue, task_id, attempt)?;
    let pending = begin_artifact_deletion_locked(project_path, &queue, &artifact)?;
    let staged = pending
        .staged_artifact
        .as_ref()
        .expect("artifact deletion transaction must have staging paths");
    let staged_path = checked_transaction_path(project_path, &staged.staged)?;
    std::fs::rename(&artifact, &staged_path).map_err(|error| {
        format!(
            "failed to stage artifact deletion {}: {error}",
            artifact.display()
        )
    })?;

    let mut updated = queue;
    let record = updated
        .tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .and_then(|task| {
            task.attempts
                .iter_mut()
                .find(|item| item.attempt == attempt)
        })
        .ok_or_else(|| format!("asset attempt not found: {task_id}/{attempt}"))?;
    record.artifact = None;
    updated.updated_at = now_ms();

    if let Err(error) = writer(project_path, &updated) {
        let rollback = recover_pending_locked(project_path);
        return Err(format!(
            "failed to persist artifact deletion: {error}{}",
            rollback_suffix(rollback)
        ));
    }
    commit_pending_locked(project_path, pending)?;
    Ok(updated)
}

pub(crate) fn resolve_artifact(
    project_path: &Path,
    queue: &AssetQueue,
    task_id: &str,
    attempt: u32,
) -> Result<PathBuf, String> {
    if task_id.is_empty()
        || !task_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(format!("invalid asset task id: {task_id}"));
    }
    let artifact = queue
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .and_then(|task| task.attempts.iter().find(|item| item.attempt == attempt))
        .and_then(|item| item.artifact.as_deref())
        .ok_or_else(|| format!("asset artifact not found: {task_id}/{attempt}"))?;
    let root = project_path
        .join(".ollaic/artifacts/assets")
        .canonicalize()
        .map_err(|error| format!("failed to resolve artifact root: {error}"))?;
    let artifact = Path::new(artifact)
        .canonicalize()
        .map_err(|error| format!("failed to resolve artifact: {error}"))?;
    if !artifact.starts_with(root.join(task_id)) || !artifact.is_file() {
        return Err("artifact is outside the project task directory".to_string());
    }
    Ok(artifact)
}

fn begin_binding_transaction_locked(
    project_path: &Path,
    previous_queue: &AssetQueue,
) -> Result<PendingTransaction, String> {
    let project = project_path.to_string_lossy().into_owned();
    let snapshot = crate::webgal::project::create_project_snapshot_locked(
        &project,
        Some("Asset queue rollback".to_string()),
        Some("auto".to_string()),
        Some("Automatic rollback point for asset binding".to_string()),
    )?;
    let pending = PendingTransaction {
        version: TRANSACTION_VERSION,
        previous_queue: previous_queue.clone(),
        rollback_snapshot: Some(snapshot.id.clone()),
        staged_artifact: None,
    };
    if let Err(error) = write_pending(project_path, &pending) {
        let _ = crate::webgal::project::delete_project_snapshot_locked(&project, &snapshot.id);
        return Err(error);
    }
    Ok(pending)
}

fn begin_artifact_deletion_locked(
    project_path: &Path,
    previous_queue: &AssetQueue,
    artifact: &Path,
) -> Result<PendingTransaction, String> {
    let root = project_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve project root: {error}"))?;
    let canonical_artifact = artifact
        .canonicalize()
        .unwrap_or_else(|_| artifact.to_path_buf());
    let original = canonical_artifact
        .strip_prefix(&root)
        .or_else(|_| artifact.strip_prefix(project_path))
        .map_err(|_| "artifact is outside the project".to_string())?
        .to_path_buf();
    let staged = PathBuf::from(".ollaic/assets/transaction-artifact");
    let staged_path = checked_transaction_path(project_path, &staged)?;
    if staged_path.exists() {
        return Err(format!(
            "stale asset transaction staging file: {}",
            staged_path.display()
        ));
    }
    let pending = PendingTransaction {
        version: TRANSACTION_VERSION,
        previous_queue: previous_queue.clone(),
        rollback_snapshot: None,
        staged_artifact: Some(StagedArtifact { original, staged }),
    };
    write_pending(project_path, &pending)?;
    Ok(pending)
}

pub(crate) fn recover_pending_locked(project_path: &Path) -> Result<(), String> {
    let Some(pending) = read_pending(project_path)? else {
        cleanup_committed_staging(project_path)?;
        return Ok(());
    };
    if pending.version != TRANSACTION_VERSION {
        return Err(format!(
            "unsupported asset transaction version {}",
            pending.version
        ));
    }

    let project = project_path.to_string_lossy().into_owned();
    if let Some(snapshot_id) = pending.rollback_snapshot.as_deref() {
        crate::webgal::project::restore_project_snapshot_locked(&project, snapshot_id)
            .map_err(|error| format!("failed to restore asset transaction snapshot: {error}"))?;
    }
    save_queue(project_path, &pending.previous_queue)
        .map_err(|error| format!("failed to restore asset transaction queue: {error}"))?;
    if let Some(staged) = pending.staged_artifact.as_ref() {
        let original = checked_transaction_path(project_path, &staged.original)?;
        let staged_path = checked_transaction_path(project_path, &staged.staged)?;
        match (original.exists(), staged_path.exists()) {
            (false, true) => std::fs::rename(&staged_path, &original).map_err(|error| {
                format!(
                    "failed to restore staged artifact {}: {error}",
                    original.display()
                )
            })?,
            (true, false) => {}
            (true, true) => {
                return Err(format!(
                    "asset transaction has both original and staged artifacts: {}",
                    original.display()
                ))
            }
            (false, false) => {
                return Err(format!(
                    "asset transaction artifact is missing: {}",
                    original.display()
                ))
            }
        }
    }
    commit_pending_locked(project_path, pending)
}

fn cleanup_committed_staging(project_path: &Path) -> Result<(), String> {
    let staged = checked_transaction_path(
        project_path,
        Path::new(".ollaic/assets/transaction-artifact"),
    )?;
    if staged.exists() {
        std::fs::remove_file(&staged).map_err(|error| {
            format!(
                "failed to clean committed artifact staging file {}: {error}",
                staged.display()
            )
        })?;
    }
    Ok(())
}

fn commit_pending_locked(project_path: &Path, pending: PendingTransaction) -> Result<(), String> {
    let path = pending_path(project_path);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| {
            format!(
                "failed to clear asset transaction journal {}: {error}",
                path.display()
            )
        })?;
    }
    if let Some(staged) = pending.staged_artifact {
        let staged_path = checked_transaction_path(project_path, &staged.staged)?;
        if staged_path.exists() {
            let _ = std::fs::remove_file(staged_path);
        }
    }
    if let Some(snapshot_id) = pending.rollback_snapshot {
        let project = project_path.to_string_lossy().into_owned();
        let _ = crate::webgal::project::delete_project_snapshot_locked(&project, &snapshot_id);
    }
    Ok(())
}

fn write_pending(project_path: &Path, pending: &PendingTransaction) -> Result<(), String> {
    let path = pending_path(project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create asset transaction directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(pending)
        .map_err(|error| format!("failed to serialize asset transaction: {error}"))?;
    crate::json_store::write_crash_safe(&path, &bytes).map_err(|error| {
        format!(
            "failed to write asset transaction journal {}: {error}",
            path.display()
        )
    })
}

fn read_pending(project_path: &Path) -> Result<Option<PendingTransaction>, String> {
    let path = pending_path(project_path);
    if !path.exists() {
        return Ok(None);
    }
    let source = crate::json_store::read_to_string_recovering(&path).map_err(|error| {
        format!(
            "failed to read asset transaction journal {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&source).map(Some).map_err(|error| {
        format!(
            "invalid asset transaction journal {}: {error}",
            path.display()
        )
    })
}

fn pending_path(project_path: &Path) -> PathBuf {
    project_path.join(".ollaic/assets/transaction.json")
}

fn checked_transaction_path(project_path: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "invalid asset transaction path: {}",
            relative.display()
        ));
    }
    Ok(project_path.join(relative))
}

fn rollback_binding_and_queue(
    project_path: &Path,
    transaction: BindingTransaction,
    previous_queue: &AssetQueue,
) -> Result<(), String> {
    combine_rollbacks([
        transaction.rollback(),
        save_queue(project_path, previous_queue),
    ])
}

fn combine_rollbacks(results: impl IntoIterator<Item = Result<(), String>>) -> Result<(), String> {
    let errors = results
        .into_iter()
        .filter_map(Result::err)
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn binding_commit_error(error: BindingCommitError) -> String {
    match error {
        BindingCommitError::Binding(error) | BindingCommitError::Persistence(error) => error,
    }
}

fn rollback_suffix(result: Result<(), String>) -> String {
    result
        .err()
        .map(|error| format!("; rollback failed: {error}"))
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_queue::types::{AssetAttempt, AssetKind};

    fn fixture(name: &str) -> (PathBuf, AssetQueue, PathBuf) {
        let project = std::env::temp_dir().join(format!(
            "ollaic_asset_transaction_{name}_{}_{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(project.join("game/scene")).unwrap();
        std::fs::write(project.join("game/scene/start.txt"), ":hello;\n").unwrap();
        let artifact = project.join(".ollaic/artifacts/assets/bg_start/1.png");
        std::fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        std::fs::write(&artifact, b"png").unwrap();
        let queue = AssetQueue::new(
            "run-1",
            vec![AssetTask {
                id: "bg_start".into(),
                kind: AssetKind::Background,
                target_stem: "bg_start".into(),
                prompt: "background".into(),
                scene_ref: Some("start.txt".into()),
                character_ref: None,
                emotion: None,
                dialogue_index: None,
                text: None,
                status: AssetTaskStatus::Running,
                attempts: vec![AssetAttempt {
                    attempt: 1,
                    started_at: 1,
                    finished_at: 2,
                    artifact: Some(artifact.to_string_lossy().into_owned()),
                    imported_file: None,
                    error: None,
                    used_local_fallback: false,
                }],
                asset_file: None,
                error: None,
                used_local_fallback: false,
            }],
            now_ms(),
        );
        (project, queue, artifact)
    }

    /// Queue with a single manual BGM task waiting for an imported file.
    fn manual_audio_fixture(name: &str) -> (PathBuf, AssetQueue) {
        let project = std::env::temp_dir().join(format!(
            "ollaic_asset_transaction_{name}_{}_{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(project.join("game/scene")).unwrap();
        std::fs::create_dir_all(project.join("game/bgm")).unwrap();
        std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
        let queue = AssetQueue::new(
            "run-1",
            vec![AssetTask {
                id: "bgm_theme".into(),
                kind: AssetKind::Bgm,
                target_stem: "bgm_theme".into(),
                prompt: "theme".into(),
                scene_ref: Some("start.txt".into()),
                character_ref: None,
                emotion: None,
                dialogue_index: None,
                text: None,
                status: AssetTaskStatus::Pending,
                attempts: Vec::new(),
                asset_file: None,
                error: Some("pending manual import: BGM/SFX 不支持 AI 生成".to_string()),
                used_local_fallback: false,
            }],
            now_ms(),
        );
        (project, queue)
    }

    #[test]
    fn imported_audio_binding_succeeds_and_is_idempotent() {
        let (project, queue) = manual_audio_fixture("imported_ok");
        save_queue(&project, &queue).unwrap();
        std::fs::write(project.join("game/bgm/bgm_theme.mp3"), b"theme").unwrap();

        let bound = bind_imported_audio(&project, "bgm_theme", "bgm_theme.mp3").unwrap();
        let task = &bound.tasks[0];
        assert_eq!(task.status, AssetTaskStatus::Succeeded);
        assert_eq!(task.asset_file.as_deref(), Some("bgm_theme.mp3"));
        assert!(task.error.is_none());
        assert_eq!(task.attempts.len(), 1);
        assert_eq!(
            task.attempts[0].imported_file.as_deref(),
            Some("bgm_theme.mp3")
        );
        assert!(task.attempts[0].artifact.is_none());
        let scene = std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap();
        assert!(scene.contains("bgm:bgm_theme.mp3;"), "{scene}");
        assert_eq!(load_queue(&project).unwrap(), bound);

        let rebind = bind_imported_audio(&project, "bgm_theme", "bgm_theme.mp3").unwrap();
        assert_eq!(rebind.tasks[0].attempts.len(), 1);
        assert_eq!(
            std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            scene,
            "rebinding must not duplicate scene commands"
        );
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn imported_audio_binding_failure_leaves_scene_and_metadata_untouched() {
        let (project, queue) = manual_audio_fixture("imported_missing");
        save_queue(&project, &queue).unwrap();
        let original_scene = std::fs::read(project.join("game/scene/start.txt")).unwrap();

        // The file is absent, so binding fails without touching the scene and
        // without burning an attempt the user has not caused yet.
        assert!(bind_imported_audio(&project, "bgm_theme", "bgm_theme.mp3")
            .unwrap_err()
            .starts_with("imported audio file is missing"));
        assert_eq!(
            std::fs::read(project.join("game/scene/start.txt")).unwrap(),
            original_scene
        );
        assert!(!project.join("game/config/asset-metadata.json").exists());
        assert!(!pending_path(&project).exists());
        assert_eq!(load_queue(&project).unwrap(), queue);

        // Once the user imports the file the very same call succeeds.
        std::fs::write(project.join("game/bgm/bgm_theme.mp3"), b"theme").unwrap();
        let bound = bind_imported_audio(&project, "bgm_theme", "bgm_theme.mp3").unwrap();
        assert_eq!(bound.tasks[0].status, AssetTaskStatus::Succeeded);
        assert_eq!(bound.tasks[0].attempts.len(), 1);
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn imported_audio_binding_rejects_non_manual_tasks_and_unsafe_paths() {
        let (project, queue) = manual_audio_fixture("imported_guards");
        save_queue(&project, &queue).unwrap();
        std::fs::write(project.join("game/bgm/bgm_theme.mp3"), b"theme").unwrap();

        assert!(
            bind_imported_audio(&project, "missing_task", "bgm_theme.mp3")
                .unwrap_err()
                .contains("asset task not found")
        );
        assert!(bind_imported_audio(&project, "bgm_theme", "../secret.mp3")
            .unwrap_err()
            .contains("invalid imported asset filename"));
        assert!(bind_imported_audio(&project, "bgm_theme", "bgm\\theme.mp3")
            .unwrap_err()
            .contains("invalid imported asset filename"));
        assert_eq!(load_queue(&project).unwrap(), queue);
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn imported_audio_binding_rolls_back_scene_when_metadata_write_fails() {
        let (project, queue) = manual_audio_fixture("imported_rollback");
        save_queue(&project, &queue).unwrap();
        std::fs::write(project.join("game/bgm/bgm_theme.mp3"), b"theme").unwrap();
        let original_scene = std::fs::read(project.join("game/scene/start.txt")).unwrap();
        // A directory in place of the metadata file makes the metadata write
        // fail after the scene command was already rewritten.
        std::fs::create_dir_all(project.join("game/config/asset-metadata.json")).unwrap();

        let failed = bind_imported_audio(&project, "bgm_theme", "bgm_theme.mp3").unwrap();
        assert_eq!(failed.tasks[0].status, AssetTaskStatus::Failed);
        assert!(failed.tasks[0].asset_file.is_none());
        assert_eq!(
            std::fs::read(project.join("game/scene/start.txt")).unwrap(),
            original_scene,
            "a failed binding must restore the scene"
        );
        assert!(!pending_path(&project).exists());
        let persisted = load_queue(&project).unwrap();
        assert_eq!(persisted.tasks[0].status, AssetTaskStatus::Failed);
        assert!(persisted.tasks[0].asset_file.is_none());
        assert_eq!(persisted.tasks[0].attempts.len(), 1);
        assert!(!failed.tasks[0].attempts[0]
            .error
            .as_deref()
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn queue_save_failure_rolls_back_binding_files() {
        let (project, queue, _) = fixture("bind_rollback");
        save_queue(&project, &queue).unwrap();
        let original_scene = std::fs::read(project.join("game/scene/start.txt")).unwrap();

        let error = crate::project_lock::with_project_lock_unrecovered(&project, || {
            persist_binding_locked_with(&project, &queue, 0, &queue.tasks[0], |_, _| {
                Err("injected queue save failure".to_string())
            })
        })
        .err()
        .map(binding_commit_error)
        .unwrap();

        assert!(error.contains("injected queue save failure"));
        assert_eq!(
            std::fs::read(project.join("game/scene/start.txt")).unwrap(),
            original_scene
        );
        assert!(!project.join("game/background/bg_start.png").exists());
        assert!(!project.join("game/config/asset-metadata.json").exists());
        assert_eq!(load_queue(&project).unwrap(), queue);
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn queue_save_failure_restores_deleted_artifact() {
        let (project, queue, artifact) = fixture("delete_rollback");
        save_queue(&project, &queue).unwrap();
        let expected_queue = queue.clone();

        let error = crate::project_lock::with_project_lock(&project, || {
            delete_artifact_locked_with(&project, queue, "bg_start", 1, |_, _| {
                Err("injected queue save failure".to_string())
            })
        })
        .unwrap_err();

        assert!(error.contains("injected queue save failure"));
        assert_eq!(std::fs::read(&artifact).unwrap(), b"png");
        assert_eq!(load_queue(&project).unwrap(), expected_queue);
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn recovery_rolls_back_crash_after_binding_before_queue_save() {
        let (project, queue, _) = fixture("bind_crash");
        save_queue(&project, &queue).unwrap();
        let original_scene = std::fs::read(project.join("game/scene/start.txt")).unwrap();

        crate::project_lock::with_project_lock_unrecovered(&project, || {
            begin_binding_transaction_locked(&project, &queue).unwrap();
            BindingTransaction::apply_locked(&project, &queue.tasks[0])
                .unwrap()
                .commit();
        });
        assert!(project.join("game/background/bg_start.png").is_file());
        assert!(pending_path(&project).is_file());

        recover_pending(&project).unwrap();

        assert_eq!(
            std::fs::read(project.join("game/scene/start.txt")).unwrap(),
            original_scene
        );
        assert!(!project.join("game/background/bg_start.png").exists());
        assert_eq!(load_queue(&project).unwrap(), queue);
        assert!(!pending_path(&project).exists());
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn project_lock_recovers_before_running_the_next_project_write() {
        let (project, queue, _) = fixture("lock_recovery_order");
        save_queue(&project, &queue).unwrap();

        crate::project_lock::with_project_lock_unrecovered(&project, || {
            begin_binding_transaction_locked(&project, &queue).unwrap();
            BindingTransaction::apply_locked(&project, &queue.tasks[0])
                .unwrap()
                .commit();
        });

        crate::project_lock::with_project_lock(&project, || {
            std::fs::write(project.join("game/scene/start.txt"), ":new AI edit;\n")
                .map_err(|error| error.to_string())
        })
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            ":new AI edit;\n"
        );
        assert_eq!(load_queue(&project).unwrap(), queue);
        assert!(!pending_path(&project).exists());
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn recovery_rolls_back_crash_after_artifact_was_staged() {
        let (project, queue, artifact) = fixture("delete_crash");
        save_queue(&project, &queue).unwrap();

        crate::project_lock::with_project_lock_unrecovered(&project, || {
            let pending = begin_artifact_deletion_locked(&project, &queue, &artifact).unwrap();
            let staged = checked_transaction_path(
                &project,
                &pending.staged_artifact.as_ref().unwrap().staged,
            )
            .unwrap();
            std::fs::rename(&artifact, staged).unwrap();
        });
        assert!(!artifact.exists());
        assert!(pending_path(&project).is_file());

        recover_pending(&project).unwrap();

        assert_eq!(std::fs::read(&artifact).unwrap(), b"png");
        assert_eq!(load_queue(&project).unwrap(), queue);
        assert!(!pending_path(&project).exists());
        let _ = std::fs::remove_dir_all(project);
    }
}
