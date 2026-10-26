use super::project::{init_project_at, open_project, ProjectInfo};
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct ProjectStorage {
    managed: bool,
}

#[tauri::command]
pub fn get_project_storage() -> ProjectStorage {
    ProjectStorage {
        managed: cfg!(mobile),
    }
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects");
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create project library: {e}"))?;
    Ok(path)
}

// A failed create/import must not leave a partial project in private storage.
struct PendingDirectory {
    path: PathBuf,
    keep: bool,
}

impl PendingDirectory {
    fn new(parent: &Path, prefix: &str) -> Result<Self, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        loop {
            let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!("{prefix}-{timestamp}-{sequence}"));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path, keep: false }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("Failed to create project directory: {e}")),
            }
        }
    }
}

impl Drop for PendingDirectory {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[tauri::command]
pub fn create_managed_project(app: AppHandle, name: String) -> Result<ProjectInfo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name is required".into());
    }
    let mut directory = PendingDirectory::new(&projects_dir(&app)?, "project")?;
    let info = init_project_at(&app, &directory.path, name)?;
    directory.keep = true;
    Ok(info)
}

#[tauri::command]
pub async fn import_project_archive(app: AppHandle, path: FilePath) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parent = projects_dir(&app)?;
        let staging = PendingDirectory::new(&parent, ".import")?;
        let mut options = OpenOptions::new();
        options.read(true);
        let source = app
            .fs()
            .open(path.clone(), options)
            .map_err(|e| format!("Failed to read project archive: {e}"))?;
        // Content providers can return non-seekable descriptors; ZIP needs a local file.
        let archive_path = staging.path.join("archive.zip");
        let copy_result = (|| {
            let mut archive = fs::File::create(&archive_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut source.take(MAX_ARCHIVE_BYTES + 1), &mut archive)
                .map_err(|e| format!("Failed to copy project archive: {e}"))
        })();
        #[cfg(target_os = "ios")]
        if matches!(&path, FilePath::Url(_)) {
            app.fs()
                .stop_accessing_security_scoped_resource(path)
                .map_err(|e| e.to_string())?;
        }
        let copied = copy_result?;
        if copied > MAX_ARCHIVE_BYTES {
            return Err("Project archive exceeds the 512 MiB limit".into());
        }
        let archive = fs::File::open(&archive_path).map_err(|e| e.to_string())?;
        let extracted = staging.path.join("contents");
        extract_archive(archive, &extracted)?;
        let source_root = find_project_root(&extracted)?;
        let mut target = PendingDirectory::new(&parent, "project")?;
        for entry in fs::read_dir(&source_root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            fs::rename(entry.path(), target.path.join(entry.file_name()))
                .map_err(|e| format!("Failed to import project file: {e}"))?;
        }
        let info = open_project(app, target.path.to_string_lossy().into_owned())?;
        target.keep = true;
        Ok(info)
    })
    .await
    .map_err(|e| format!("Project import failed: {e}"))?
}

fn extract_archive(reader: impl Read + Seek, destination: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Invalid project ZIP archive: {e}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Project archive contains too many files".into());
    }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or("Project archive contains an unsafe path")?;
        if entry.name().contains('\\')
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Project archive contains an unsupported path or symbolic link".into());
        }
        if entry.size() > MAX_EXTRACTED_BYTES.saturating_sub(total) {
            return Err("Extracted project exceeds the 2 GiB limit".into());
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)
                .map_err(|e| format!("Failed to extract project file: {e}"))?;
            total += std::io::copy(&mut entry.take(MAX_EXTRACTED_BYTES - total + 1), &mut file)
                .map_err(|e| format!("Failed to extract project file: {e}"))?;
            if total > MAX_EXTRACTED_BYTES {
                return Err("Extracted project exceeds the 2 GiB limit".into());
            }
        }
    }
    Ok(())
}

fn is_project_root(path: &Path) -> bool {
    path.join("game/config.txt").is_file() && path.join("game/scene").is_dir()
}

fn find_project_root(extracted: &Path) -> Result<PathBuf, String> {
    if is_project_root(extracted) {
        return Ok(extracted.to_owned());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(extracted).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if is_project_root(&path) {
            candidates.push(path);
        }
    }
    if candidates.len() == 1 {
        Ok(candidates.remove(0))
    } else {
        Err("ZIP must contain one WebGAL project with game/config.txt and game/scene/".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    fn archive(files: &[(&str, &str)]) -> Cursor<Vec<u8>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap()
    }

    #[test]
    fn imports_exported_and_wrapped_projects_with_editor_data() {
        for prefix in ["", "My Story/"] {
            let temp = PendingDirectory::new(&std::env::temp_dir(), "ollaic-import-test").unwrap();
            let config = format!("{prefix}game/config.txt");
            let scene = format!("{prefix}game/scene/start.txt");
            let memory = format!("{prefix}.ollaic/memory.json");
            extract_archive(
                archive(&[
                    (&config, "Game_name:Story;"),
                    (&scene, "hello;"),
                    (&memory, "{}"),
                ]),
                &temp.path,
            )
            .unwrap();
            let root = find_project_root(&temp.path).unwrap();
            assert_eq!(
                fs::read_to_string(root.join("game/scene/start.txt")).unwrap(),
                "hello;"
            );
            assert!(root.join(".ollaic/memory.json").is_file());
        }
    }

    #[test]
    fn rejects_traversal_and_symlinks() {
        for files in [
            vec![("../outside.txt", "bad")],
            vec![("/absolute.txt", "bad")],
            vec![("game\\..\\outside.txt", "bad")],
        ] {
            let temp = PendingDirectory::new(&std::env::temp_dir(), "ollaic-import-test").unwrap();
            assert!(extract_archive(archive(&files), &temp.path).is_err());
        }
        let temp = PendingDirectory::new(&std::env::temp_dir(), "ollaic-import-test").unwrap();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("game/link", "../../outside", SimpleFileOptions::default())
            .unwrap();
        assert!(extract_archive(writer.finish().unwrap(), &temp.path).is_err());
    }

    #[test]
    fn rejects_invalid_and_ambiguous_projects_and_removes_partial_imports() {
        let directory = PendingDirectory::new(&std::env::temp_dir(), "ollaic-import-test").unwrap();
        let path = directory.path.clone();
        extract_archive(archive(&[("readme.txt", "not a project")]), &path).unwrap();
        assert!(find_project_root(&path).is_err());
        for name in ["one", "two"] {
            fs::create_dir_all(path.join(name).join("game/scene")).unwrap();
            fs::write(path.join(name).join("game/config.txt"), "").unwrap();
        }
        assert!(find_project_root(&path).is_err());
        drop(directory);
        assert!(!path.exists());
    }
}
