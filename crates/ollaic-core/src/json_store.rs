use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn backup_path(path: &Path) -> PathBuf {
    suffixed_path(path, ".bak")
}

/// Read the formal path, restoring a backup left by the legacy two-rename
/// writer when the formal path is missing.
pub fn read_to_string_recovering(path: &Path) -> std::io::Result<String> {
    recover_missing_primary(path)?;
    std::fs::read_to_string(path)
}

pub fn read_candidates(path: &Path) -> std::io::Result<Vec<String>> {
    validate_store_paths(path)?;
    let backup = backup_path(path);
    if !path.exists() && !backup.exists() {
        return Ok(Vec::new());
    }

    let mut candidates = vec![read_to_string_recovering(path)?];
    if backup.exists() {
        candidates.push(std::fs::read_to_string(backup)?);
    }
    Ok(candidates)
}

pub fn write_crash_safe(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    write_crash_safe_inner(path, contents, None)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CrashPoint {
    AfterTempSync,
    AfterReplace,
}

fn write_crash_safe_inner(
    path: &Path,
    contents: &[u8],
    crash_point: Option<CrashPoint>,
) -> std::io::Result<()> {
    recover_missing_primary(path)?;
    // Never truncate a pre-existing temporary path: it may alias an external file.
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(contents)?;
    file.as_file().sync_all()?;
    let temporary = file.into_temp_path();

    if crash_point == Some(CrashPoint::AfterTempSync) {
        return Err(injected_crash(CrashPoint::AfterTempSync));
    }

    // The temporary file lives beside the destination, so replacement stays
    // on one filesystem and is observed as either the complete old file or the
    // complete new file, never a missing/partially-written formal path.
    atomic_replace(&temporary, path)?;

    if crash_point == Some(CrashPoint::AfterReplace) {
        return Err(injected_crash(CrashPoint::AfterReplace));
    }

    sync_parent_directory(path)?;

    // A .bak can only be residue from the old writer now. The formal file is
    // already durable before this cleanup, so a crash here remains readable.
    let backup = backup_path(path);
    if backup.exists() {
        std::fs::remove_file(backup)?;
        sync_parent_directory(path)?;
    }
    Ok(())
}

#[cfg(test)]
fn write_crash_safe_with_fault(
    path: &Path,
    contents: &[u8],
    crash_point: Option<CrashPoint>,
) -> std::io::Result<()> {
    write_crash_safe_inner(path, contents, crash_point)
}

fn recover_missing_primary(path: &Path) -> std::io::Result<()> {
    validate_store_paths(path)?;
    if path.exists() {
        return Ok(());
    }
    let backup = backup_path(path);
    if !backup.exists() {
        return Ok(());
    }
    match std::fs::rename(&backup, path) {
        Ok(()) => sync_parent_directory(path),
        Err(_) if path.exists() => Ok(()),
        Err(error) => Err(error),
    }
}

fn validate_store_paths(path: &Path) -> std::io::Result<()> {
    for candidate in [
        path.to_owned(),
        backup_path(path),
        suffixed_path(path, ".tmp"),
    ] {
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("Symbolic links are not supported: {}", candidate.display()),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary, path)
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
        fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let temporary = wide(temporary);
    let path_wide = wide(path);
    let result = unsafe {
        if path.exists() {
            ReplaceFileW(
                path_wide.as_ptr(),
                temporary.as_ptr(),
                null(),
                0,
                null_mut(),
                null_mut(),
            )
        } else {
            MoveFileExW(
                temporary.as_ptr(),
                path_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
pub(crate) fn sync_parent_directory(_path: &Path) -> std::io::Result<()> {
    // Windows has no std API for syncing directory entries. Existing files use
    // the journaled ReplaceFileW operation; first creation uses MoveFileExW
    // with WRITE_THROUGH. The temporary file data itself was synced above.
    Ok(())
}

fn injected_crash(point: CrashPoint) -> std::io::Error {
    std::io::Error::other(format!("injected crash at {point:?}"))
}

fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);

    fn test_path(label: &str) -> PathBuf {
        let nonce = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "ollaic_json_store_{}_{}_{}",
            label,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("value.json")
    }

    #[test]
    fn crash_after_temp_sync_preserves_complete_old_value() {
        let path = test_path("after_temp_sync");
        std::fs::write(&path, br#"{"value":"old"}"#).unwrap();

        assert!(write_crash_safe_with_fault(
            &path,
            br#"{"value":"new"}"#,
            Some(CrashPoint::AfterTempSync),
        )
        .is_err());

        assert_eq!(
            read_to_string_recovering(&path).unwrap(),
            r#"{"value":"old"}"#
        );
    }

    #[test]
    fn crash_after_atomic_replace_exposes_complete_new_value() {
        let path = test_path("after_replace");
        std::fs::write(&path, br#"{"value":"old"}"#).unwrap();

        assert!(write_crash_safe_with_fault(
            &path,
            br#"{"value":"new"}"#,
            Some(CrashPoint::AfterReplace),
        )
        .is_err());

        assert_eq!(
            read_to_string_recovering(&path).unwrap(),
            r#"{"value":"new"}"#
        );
    }

    #[test]
    fn missing_primary_is_restored_from_legacy_backup() {
        let path = test_path("legacy_backup");
        std::fs::write(backup_path(&path), br#"{"value":"old"}"#).unwrap();

        assert_eq!(
            read_to_string_recovering(&path).unwrap(),
            r#"{"value":"old"}"#
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"value":"old"}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_store_paths_are_rejected_without_modifying_external_files() {
        use std::os::unix::fs::symlink;

        for suffix in ["", ".tmp", ".bak"] {
            for primary_exists in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let path = directory.path().join("value.json");
                let outside = directory.path().join("outside.json");
                std::fs::write(&outside, "external data").unwrap();
                if primary_exists && !suffix.is_empty() {
                    std::fs::write(&path, "original data").unwrap();
                }
                let linked = suffixed_path(&path, suffix);
                symlink(&outside, &linked).unwrap();

                assert!(
                    write_crash_safe(&path, b"replacement").is_err(),
                    "{linked:?}"
                );
                assert!(read_to_string_recovering(&path).is_err(), "{linked:?}");
                assert!(read_candidates(&path).is_err(), "{linked:?}");
                assert_eq!(std::fs::read_to_string(&outside).unwrap(), "external data");
                assert!(std::fs::symlink_metadata(&linked)
                    .unwrap()
                    .file_type()
                    .is_symlink());
                if primary_exists && !suffix.is_empty() {
                    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original data");
                } else if !suffix.is_empty() {
                    assert!(!path.exists());
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn dangling_store_symlinks_cannot_create_external_files() {
        use std::os::unix::fs::symlink;

        for suffix in ["", ".tmp", ".bak"] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("value.json");
            let outside = directory.path().join("missing.json");
            let linked = suffixed_path(&path, suffix);
            symlink(&outside, &linked).unwrap();

            assert!(read_candidates(&path).is_err(), "{linked:?}");
            assert!(read_to_string_recovering(&path).is_err(), "{linked:?}");
            assert!(
                write_crash_safe(&path, b"replacement").is_err(),
                "{linked:?}"
            );
            assert!(!outside.exists());
            assert!(std::fs::symlink_metadata(&linked)
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn stale_temporary_hard_links_cannot_modify_external_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("value.json");
        let outside = directory.path().join("outside.json");
        std::fs::write(&outside, "external data").unwrap();
        std::fs::hard_link(&outside, suffixed_path(&path, ".tmp")).unwrap();

        write_crash_safe(&path, b"replacement").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "replacement");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "external data");
    }
}
