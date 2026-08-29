use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const TRANSACTION_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetMutationJournal {
    version: u32,
    rollback_snapshot: String,
}

pub(crate) fn run_locked<T>(
    project_path: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let project = Path::new(project_path);
    let journal = begin_locked(project_path)?;
    match operation() {
        Ok(value) => match commit_locked(project_path, journal) {
            Ok(()) => Ok(value),
            Err(error) => {
                let recovery = recover_pending_locked(project);
                Err(format!("{error}{}", recovery_suffix(recovery)))
            }
        },
        Err(error) => {
            let recovery = recover_pending_locked(project);
            Err(format!("{error}{}", recovery_suffix(recovery)))
        }
    }
}

pub(crate) fn recover_pending_locked(project_path: &Path) -> Result<(), String> {
    let Some(journal) = read_journal(project_path)? else {
        return Ok(());
    };
    if journal.version != TRANSACTION_VERSION {
        return Err(format!(
            "unsupported asset mutation transaction version {}",
            journal.version
        ));
    }
    let project = project_path.to_string_lossy().into_owned();
    crate::webgal::project::restore_project_snapshot_locked(&project, &journal.rollback_snapshot)
        .map_err(|error| format!("failed to restore asset mutation snapshot: {error}"))?;
    commit_locked(&project, journal)
}

fn begin_locked(project_path: &str) -> Result<AssetMutationJournal, String> {
    let snapshot = crate::webgal::project::create_project_snapshot_locked(
        project_path,
        Some("Asset mutation rollback".to_string()),
        Some("auto".to_string()),
        Some("Automatic rollback point before changing an asset".to_string()),
    )?;
    let journal = AssetMutationJournal {
        version: TRANSACTION_VERSION,
        rollback_snapshot: snapshot.id.clone(),
    };
    if let Err(error) = write_journal(Path::new(project_path), &journal) {
        let _ = crate::webgal::project::delete_project_snapshot_locked(project_path, &snapshot.id);
        return Err(error);
    }
    Ok(journal)
}

fn commit_locked(project_path: &str, journal: AssetMutationJournal) -> Result<(), String> {
    let path = journal_path(Path::new(project_path));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| {
            format!(
                "failed to clear asset mutation journal {}: {error}",
                path.display()
            )
        })?;
    }
    let _ = crate::webgal::project::delete_project_snapshot_locked(
        project_path,
        &journal.rollback_snapshot,
    );
    Ok(())
}

fn write_journal(project_path: &Path, journal: &AssetMutationJournal) -> Result<(), String> {
    let path = journal_path(project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create asset mutation journal directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("failed to serialize asset mutation journal: {error}"))?;
    crate::json_store::write_crash_safe(&path, &bytes).map_err(|error| {
        format!(
            "failed to write asset mutation journal {}: {error}",
            path.display()
        )
    })
}

fn read_journal(project_path: &Path) -> Result<Option<AssetMutationJournal>, String> {
    let path = journal_path(project_path);
    if !path.exists() {
        return Ok(None);
    }
    let source = crate::json_store::read_to_string_recovering(&path).map_err(|error| {
        format!(
            "failed to read asset mutation journal {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&source)
        .map(Some)
        .map_err(|error| format!("invalid asset mutation journal {}: {error}", path.display()))
}

fn journal_path(project_path: &Path) -> PathBuf {
    project_path.join(".ollaic/assets/file-mutation.json")
}

fn recovery_suffix(result: Result<(), String>) -> String {
    result
        .err()
        .map(|error| format!("; rollback failed: {error}"))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn project_lock_recovers_crashed_asset_mutation_before_next_write() {
        let project = std::env::temp_dir().join("webgal_test_asset_mutation_crash_recovery");
        let _ = std::fs::remove_dir_all(&project);
        let scene = project.join("game/scene/start.txt");
        std::fs::create_dir_all(scene.parent().unwrap()).unwrap();
        std::fs::write(&scene, ":original;\n").unwrap();
        let project_string = project.to_string_lossy().into_owned();

        crate::project_lock::with_project_lock_unrecovered(&project, || {
            begin_locked(&project_string).unwrap();
            std::fs::write(&scene, ":interrupted;\n").unwrap();
        });

        crate::project_lock::with_project_lock(&project, || {
            std::fs::write(&scene, ":next write;\n").map_err(|error| error.to_string())
        })
        .unwrap();

        assert_eq!(std::fs::read_to_string(&scene).unwrap(), ":next write;\n");
        assert!(!journal_path(&project).exists());
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn recovery_failure_is_returned_without_running_the_operation() {
        let project = std::env::temp_dir().join("webgal_test_asset_recovery_failure_boundary");
        let _ = std::fs::remove_dir_all(&project);
        let journal = journal_path(&project);
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        std::fs::write(&journal, "not json").unwrap();
        let executed = AtomicBool::new(false);

        let error = crate::project_lock::with_project_lock(&project, || {
            executed.store(true, Ordering::SeqCst);
            Ok::<(), String>(())
        })
        .unwrap_err();

        assert!(error.contains("invalid asset mutation journal"));
        assert!(!executed.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(project);
    }
}
