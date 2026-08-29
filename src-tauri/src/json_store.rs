use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

pub fn backup_path(path: &Path) -> PathBuf {
    suffixed_path(path, ".bak")
}

pub fn read_candidates(path: &Path) -> std::io::Result<Vec<String>> {
    let mut candidates = Vec::new();
    for candidate in [path.to_path_buf(), backup_path(path)] {
        if candidate.exists() {
            candidates.push(std::fs::read_to_string(candidate)?);
        }
    }
    Ok(candidates)
}

pub fn write_crash_safe(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut temporary = sibling_temporary_file(path)?;
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;

    let backup = backup_path(path);
    if std::fs::symlink_metadata(&backup).is_ok() {
        std::fs::remove_file(backup)?;
    }
    persist_temporary_file(temporary, path)?;
    Ok(())
}

pub(crate) fn write_new_crash_safe(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut temporary = sibling_temporary_file(path)?;
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    Ok(())
}

pub(crate) fn sibling_temporary_file(path: &Path) -> std::io::Result<NamedTempFile> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    NamedTempFile::new_in(parent)
}

pub(crate) fn persist_temporary_file(temporary: NamedTempFile, path: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "Destination {} is a symbolic link; choose a regular file path",
                path.display()
            ),
        ));
    }
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_new_preserves_an_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scene.txt");
        std::fs::write(&path, "concurrent writer").unwrap();

        assert!(write_new_crash_safe(&path, b"replacement").is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "concurrent writer");
    }
}
