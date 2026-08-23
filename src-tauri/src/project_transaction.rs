use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
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
        let project_root = normalized_project_root(project_root);
        let guard = project_guard(&project_root).lock_owned().await;
        recover_pending_locked(&project_root)?;

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

        let mut relative_paths = paths
            .into_iter()
            .map(|path| validate_relative_path(&path))
            .collect::<Result<Vec<_>, _>>()?;
        relative_paths.sort();
        relative_paths.dedup();

        let snapshot_result = (|| {
            let mut entries = Vec::with_capacity(relative_paths.len());
            for relative in relative_paths {
                let source = project_root.join(&relative);
                let existed = source.exists();
                let was_directory = source.is_dir();
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
}

impl Drop for ProjectFileTransaction {
    fn drop(&mut self) {
        if self.active {
            let _ = self.rollback();
        }
    }
}

pub async fn recover_pending(project_root: &Path) -> Result<(), String> {
    let project_root = normalized_project_root(project_root);
    let _guard = project_guard(&project_root).lock_owned().await;
    recover_pending_locked(&project_root)
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
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("failed to remove directory {}: {error}", path.display()))
    } else if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("failed to remove file {}: {error}", path.display()))
    } else {
        Ok(())
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
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
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

fn normalized_project_root(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn project_guard(project_root: &Path) -> Arc<AsyncMutex<()>> {
    static GUARDS: OnceLock<Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    let guards = GUARDS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guards = guards.lock().expect("project transaction guards poisoned");
    if let Some(guard) = guards.get(project_root).and_then(Weak::upgrade) {
        return guard;
    }
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
}
