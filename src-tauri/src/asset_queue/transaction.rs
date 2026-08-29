use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::binder::BindingTransaction;
use super::store::{load_queue, queue_path, save_queue};
use super::types::{AssetQueue, AssetTask, AssetTaskStatus};

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
    let original = artifact
        .strip_prefix(&root)
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
