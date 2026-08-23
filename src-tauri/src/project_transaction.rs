use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

const TRANSACTIONS_DIR: &str = ".ollaic/transactions";
const MANIFEST_FILE: &str = "manifest.json";
const COMMITTED_FILE: &str = "COMMITTED";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionManifest {
    entries: Vec<TransactionEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionEntry {
    path: String,
    existed: bool,
    was_directory: bool,
}

/// Durable Project-scoped filesystem transaction for related playable writes.
pub struct ProjectFileTransaction {
    project_root: PathBuf,
    journal_dir: PathBuf,
    manifest: TransactionManifest,
    _guard: OwnedMutexGuard<()>,
    active: bool,
}

impl ProjectFileTransaction {
    pub async fn begin(
        project_root: &Path,
        label: &str,
        paths: impl IntoIterator<Item = PathBuf>,
    ) -> Result<Self, String> {
        let project_root = canonical_project_root(project_root)?;
        let mut relative_paths = paths
            .into_iter()
            .map(|path| validate_relative_path(&path))
            .collect::<Result<Vec<_>, _>>()?;
        relative_paths.sort();
        relative_paths.dedup();
        let guard = project_guard(&project_root).lock_owned().await;
        validate_snapshot_path(&project_root, Path::new(TRANSACTIONS_DIR))?;
        recover_pending_locked(&project_root)?;
        validate_snapshot_paths_at(&project_root, &relative_paths)?;

        let journal_dir = project_root
            .join(TRANSACTIONS_DIR)
            .join(unique_transaction_id(label));
        let backup_root = journal_dir.join("backup");
        fs::create_dir_all(&backup_root).map_err(|error| {
            format!(
                "failed to create transaction journal {}: {error}",
                journal_dir.display()
            )
        })?;

        let snapshot_result = (|| {
            let mut entries = Vec::with_capacity(relative_paths.len());
            for relative in relative_paths {
                let source = project_root.join(&relative);
                let source_metadata = match fs::symlink_metadata(&source) {
                    Ok(metadata) => Some(metadata),
                    Err(error) if error.kind() == ErrorKind::NotFound => None,
                    Err(error) => {
                        return Err(format!(
                            "failed to inspect transaction path {}: {error}",
                            source.display()
                        ));
                    }
                };
                if source_metadata
                    .as_ref()
                    .is_some_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(format!(
                        "transaction snapshot refuses symbolic link: {}",
                        source.display()
                    ));
                }
                let existed = source_metadata.is_some();
                let was_directory = source_metadata.as_ref().is_some_and(fs::Metadata::is_dir);
                if existed {
                    let backup = backup_root.join(&relative);
                    if was_directory {
                        copy_dir_recursive(&source, &backup)?;
                    } else {
                        if let Some(parent) = backup.parent() {
                            fs::create_dir_all(parent).map_err(|error| {
                                format!(
                                    "failed to create transaction backup {}: {error}",
                                    parent.display()
                                )
                            })?;
                        }
                        fs::copy(&source, &backup).map_err(|error| {
                            format!(
                                "failed to snapshot {} to {}: {error}",
                                source.display(),
                                backup.display()
                            )
                        })?;
                    }
                }
                entries.push(TransactionEntry {
                    path: path_to_manifest(&relative)?,
                    existed,
                    was_directory,
                });
            }
            let manifest = TransactionManifest { entries };
            let bytes = serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("failed to serialize transaction manifest: {error}"))?;
            crate::json_store::write_crash_safe(&journal_dir.join(MANIFEST_FILE), &bytes)
                .map_err(|error| format!("failed to write transaction manifest: {error}"))?;
            Ok(manifest)
        })();

        let manifest = match snapshot_result {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = fs::remove_dir_all(&journal_dir);
                return Err(error);
            }
        };

        Ok(Self {
            project_root,
            journal_dir,
            manifest,
            _guard: guard,
            active: true,
        })
    }

    /// Mark complete output before the owning run-state save. A crash after
    /// this point keeps the complete output and the still-Running step replays.
    pub fn prepare_commit(&mut self) -> Result<(), String> {
        crate::json_store::write_crash_safe(&self.journal_dir.join(COMMITTED_FILE), b"committed\n")
            .map_err(|error| format!("failed to prepare transaction commit: {error}"))
    }

    pub fn rollback(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        let result = restore_manifest(&self.project_root, &self.journal_dir, &self.manifest);
        if result.is_ok() {
            self.active = false;
            let _ = fs::remove_dir_all(&self.journal_dir);
        }
        result
    }

    pub fn commit(mut self) {
        self.active = false;
        let _ = fs::remove_dir_all(&self.journal_dir);
    }

    #[cfg(test)]
    fn abandon_for_recovery_test(mut self) {
        self.active = false;
    }

    #[cfg(test)]
    pub(crate) fn remove_backup_for_test(&self, relative_path: &Path) -> Result<(), String> {
        remove_path_if_exists(&self.journal_dir.join("backup").join(relative_path))
    }
}

impl Drop for ProjectFileTransaction {
    fn drop(&mut self) {
        if self.active {
            let _ = self.rollback();
        }
    }
}

pub async fn recover_pending(project_root: &Path) -> Result<(), String> {
    let project_root = canonical_project_root(project_root)?;
    let _guard = project_guard(&project_root).lock_owned().await;
    validate_snapshot_path(&project_root, Path::new(TRANSACTIONS_DIR))?;
    recover_pending_locked(&project_root)
}

pub(crate) fn validate_snapshot_paths(
    project_root: &Path,
    relative_paths: &[PathBuf],
) -> Result<(), String> {
    let project_root = canonical_project_root(project_root)?;
    let relative_paths = relative_paths
        .iter()
        .map(|path| validate_relative_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    validate_snapshot_paths_at(&project_root, &relative_paths)
}

fn recover_pending_locked(project_root: &Path) -> Result<(), String> {
    let root = project_root.join(TRANSACTIONS_DIR);
    if !root.is_dir() {
        return Ok(());
    }
    let mut journals = fs::read_dir(&root)
        .map_err(|error| format!("failed to read transaction journals: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    journals.sort();

    let mut errors = Vec::new();
    for journal in journals {
        if journal.join(COMMITTED_FILE).is_file() {
            if let Err(error) = fs::remove_dir_all(&journal) {
                errors.push(format!("{}: {error}", journal.display()));
            }
            continue;
        }
        let manifest_path = journal.join(MANIFEST_FILE);
        if !manifest_path.is_file() {
            let _ = fs::remove_dir_all(&journal);
            continue;
        }
        let result = fs::read(&manifest_path)
            .map_err(|error| format!("failed to read {}: {error}", manifest_path.display()))
            .and_then(|bytes| {
                serde_json::from_slice::<TransactionManifest>(&bytes).map_err(|error| {
                    format!("failed to parse {}: {error}", manifest_path.display())
                })
            })
            .and_then(|manifest| restore_manifest(project_root, &journal, &manifest));
        match result {
            Ok(()) => {
                let _ = fs::remove_dir_all(&journal);
            }
            Err(error) => errors.push(format!("{}: {error}", journal.display())),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "transaction recovery left residual paths: {}",
            errors.join("; ")
        ))
    }
}

fn restore_manifest(
    project_root: &Path,
    journal_dir: &Path,
    manifest: &TransactionManifest,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for entry in manifest.entries.iter().rev() {
        let relative = match validate_relative_path(Path::new(&entry.path)) {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("{}: {error}", entry.path));
                continue;
            }
        };
        let target = project_root.join(&relative);
        let backup = journal_dir.join("backup").join(&relative);
        if let Err(error) = validate_snapshot_path(project_root, &relative) {
            errors.push(format!("{}: {error}", target.display()));
            continue;
        }
        let result = if entry.existed {
            remove_path_if_exists(&target).and_then(|()| {
                if entry.was_directory {
                    copy_dir_recursive(&backup, &target)
                } else {
                    let bytes = fs::read(&backup).map_err(|error| {
                        format!("failed to read backup {}: {error}", backup.display())
                    })?;
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|error| {
                            format!("failed to create {}: {error}", parent.display())
                        })?;
                    }
                    crate::json_store::write_crash_safe(&target, &bytes)
                        .map_err(|error| format!("failed to restore {}: {error}", target.display()))
                }
            })
        } else {
            remove_path_if_exists(&target)
        };
        if let Err(error) = result {
            errors.push(format!("{}: {error}", target.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "rollback left residual paths: {}",
            errors.join("; ")
        ))
    }
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
                .map_err(|error| format!("failed to remove directory {}: {error}", path.display()))
        }
        Ok(_) => fs::remove_file(path)
            .map_err(|error| format!("failed to remove file {}: {error}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
    }
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "failed to create transaction directory {}: {error}",
            destination.display()
        )
    })?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("failed to inspect {}: {error}", source_path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "transaction snapshot refuses symbolic link: {}",
                source_path.display()
            ));
        }
        if metadata.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        } else {
            return Err(format!(
                "transaction snapshot requires regular files or directories: {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "transaction path must be Project-relative: {}",
            path.display()
        ));
    }
    Ok(path.to_path_buf())
}

fn path_to_manifest(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("transaction path is not UTF-8: {}", path.display()))
}

fn canonical_project_root(path: &Path) -> Result<PathBuf, String> {
    let root = path
        .canonicalize()
        .map_err(|error| format!("invalid Project root {}: {error}", path.display()))?;
    if !root.is_dir() {
        return Err(format!(
            "invalid Project root {}: not a directory",
            root.display()
        ));
    }
    Ok(root)
}

fn validate_snapshot_paths_at(project_root: &Path, paths: &[PathBuf]) -> Result<(), String> {
    for relative in paths {
        validate_snapshot_path(project_root, relative)?;
    }
    Ok(())
}

fn validate_snapshot_path(project_root: &Path, relative: &Path) -> Result<(), String> {
    let relative = validate_relative_path(relative)?;
    let mut current = project_root.to_path_buf();
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            unreachable!("relative path was validated")
        };
        current.push(part);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "failed to inspect transaction path {}: {error}",
                    current.display()
                ));
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "transaction snapshot refuses symbolic link: {}",
                current.display()
            ));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err(format!(
                "transaction path ancestor is not a directory: {}",
                current.display()
            ));
        }
        if index + 1 == components.len() {
            if metadata.is_dir() {
                validate_snapshot_tree(&current)?;
            } else if !metadata.is_file() {
                return Err(format!(
                    "transaction snapshot requires a regular file or directory: {}",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

fn validate_snapshot_tree(directory: &Path) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("failed to inspect {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "transaction snapshot refuses symbolic link: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            validate_snapshot_tree(&path)?;
        } else if !metadata.is_file() {
            return Err(format!(
                "transaction snapshot requires regular files or directories: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

pub(crate) fn project_guard(project_root: &Path) -> Arc<AsyncMutex<()>> {
    static GUARDS: OnceLock<Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    let guards = GUARDS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guards = guards.lock().expect("project transaction guards poisoned");
    if let Some(guard) = guards.get(project_root).and_then(Weak::upgrade) {
        return guard;
    }
    guards.retain(|_, guard| guard.strong_count() > 0);
    let guard = Arc::new(AsyncMutex::new(()));
    guards.insert(project_root.to_path_buf(), Arc::downgrade(&guard));
    guard
}

fn unique_transaction_id(label: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let label = label
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("{timestamp}-{label}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ollaic_project_transaction_{}_{}",
            name,
            unique_transaction_id("test")
        ));
        fs::create_dir_all(path.join("game/scene")).unwrap();
        path
    }

    #[tokio::test]
    async fn project_transaction_rollback_restores_files_and_removes_creates() {
        let root = project("rollback");
        fs::write(root.join("game/scene/start.txt"), "before").unwrap();
        let mut transaction = ProjectFileTransaction::begin(
            &root,
            "test",
            [
                PathBuf::from("game/scene"),
                PathBuf::from(".ollaic/plan.json"),
            ],
        )
        .await
        .unwrap();
        fs::write(root.join("game/scene/start.txt"), "after").unwrap();
        fs::create_dir_all(root.join(".ollaic")).unwrap();
        fs::write(root.join(".ollaic/plan.json"), "new").unwrap();
        transaction.rollback().unwrap();
        assert_eq!(
            fs::read_to_string(root.join("game/scene/start.txt")).unwrap(),
            "before"
        );
        assert!(!root.join(".ollaic/plan.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_transaction_recovery_restores_uncommitted_journal() {
        let root = project("recovery");
        fs::write(root.join("game/scene/start.txt"), "before").unwrap();
        let transaction =
            ProjectFileTransaction::begin(&root, "test", [PathBuf::from("game/scene")])
                .await
                .unwrap();
        fs::write(root.join("game/scene/start.txt"), "after").unwrap();
        transaction.abandon_for_recovery_test();
        recover_pending(&root).await.unwrap();
        assert_eq!(
            fs::read_to_string(root.join("game/scene/start.txt")).unwrap(),
            "before"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_transaction_recovery_keeps_prepared_output() {
        let root = project("prepared");
        fs::write(root.join("game/scene/start.txt"), "before").unwrap();
        let mut transaction =
            ProjectFileTransaction::begin(&root, "test", [PathBuf::from("game/scene")])
                .await
                .unwrap();
        fs::write(root.join("game/scene/start.txt"), "after").unwrap();
        transaction.prepare_commit().unwrap();
        transaction.abandon_for_recovery_test();

        recover_pending(&root).await.unwrap();

        assert_eq!(
            fs::read_to_string(root.join("game/scene/start.txt")).unwrap(),
            "after"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_transaction_reports_rollback_residual_paths() {
        let root = project("residual");
        fs::write(root.join("game/scene/start.txt"), "before").unwrap();
        let mut transaction =
            ProjectFileTransaction::begin(&root, "test", [PathBuf::from("game/scene")])
                .await
                .unwrap();
        fs::write(root.join("game/scene/start.txt"), "after").unwrap();
        fs::remove_dir_all(transaction.journal_dir.join("backup/game/scene")).unwrap();

        let error = transaction.rollback().unwrap_err();

        assert!(error.contains("rollback left residual paths"));
        assert!(error.contains("game/scene"));
        transaction.abandon_for_recovery_test();
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn project_transaction_rejects_snapshot_symlinks_outside_project() {
        use std::os::unix::fs::symlink;

        let root = project("snapshot_symlink");
        let outside = root.parent().unwrap().join(format!(
            "ollaic_project_transaction_outside_{}",
            unique_transaction_id("test")
        ));
        fs::write(&outside, "outside-secret").unwrap();
        symlink(&outside, root.join("game/scene/linked.txt")).unwrap();

        let result =
            ProjectFileTransaction::begin(&root, "test", [PathBuf::from("game/scene")]).await;
        let error = match result {
            Ok(transaction) => {
                transaction.commit();
                panic!("snapshotting a symbolic link must fail")
            }
            Err(error) => error,
        };

        assert!(error.contains("symbolic link"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside-secret");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[tokio::test]
    async fn project_transaction_serializes_concurrent_scene_save() {
        use std::sync::mpsc;
        use std::time::Duration;

        let root = project("scene_save_lock");
        let scene = root.join("game/scene/start.txt");
        fs::write(&scene, "before").unwrap();
        let mut transaction =
            ProjectFileTransaction::begin(&root, "test", [PathBuf::from("game/scene")])
                .await
                .unwrap();
        fs::write(&scene, "transaction-write").unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let project_path = root.to_string_lossy().to_string();
        let writer = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = crate::webgal::commands::write_file_text(
                project_path,
                "start.txt".to_string(),
                "concurrent-save".to_string(),
            );
            done_tx.send(result).unwrap();
        });
        started_rx.recv().unwrap();

        assert!(
            matches!(
                done_rx.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "scene save must wait for the Project transaction lock"
        );
        transaction.rollback().unwrap();
        drop(transaction);
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        writer.join().unwrap();

        assert_eq!(fs::read_to_string(&scene).unwrap(), "concurrent-save");
        let _ = fs::remove_dir_all(root);
    }
}
