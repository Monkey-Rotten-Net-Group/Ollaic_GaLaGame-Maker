use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_ENGINE_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub installed: bool,
    pub path: String,
    pub version: Option<String>,
}

pub fn read_info(dir: &Path) -> RuntimeInfo {
    let installed = dir.join("index.html").is_file();
    let metadata_path = dir.join("webgal-engine.json");
    let version = if installed {
        fs::metadata(&metadata_path)
            .ok()
            .filter(|metadata| metadata.len() <= 64 * 1024)
            .and_then(|_| fs::read(metadata_path).ok())
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| value["webgalVersion"].as_str().map(str::to_owned))
    } else {
        None
    };
    RuntimeInfo {
        installed,
        path: dir.to_string_lossy().into_owned(),
        version,
    }
}

fn backup_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or("Missing engine directory")?;
    let name = target.file_name().ok_or("Missing engine directory name")?;
    Ok(parent.join(format!(".{}.previous", name.to_string_lossy())))
}

fn recover(target: &Path) -> Result<(), String> {
    let backup = backup_path(target)?;
    if !target.exists() && backup.exists() {
        fs::rename(backup, target).map_err(|error| format!("Restore previous engine: {error}"))?;
    }
    Ok(())
}

pub fn validate(dir: &Path) -> Result<RuntimeInfo, String> {
    let info = read_info(dir);
    if !info.installed || !dir.join("assets").is_dir() {
        return Err("Engine ZIP must contain index.html and assets/".into());
    }
    if fs::metadata(dir.join("index.html"))
        .map_err(|error| error.to_string())?
        .len()
        > 2 * 1024 * 1024
    {
        return Err("Engine index.html exceeds the 2 MiB limit".into());
    }
    if info.version.as_deref() != Some(crate::engine_version()) {
        return Err(format!(
            "Expected WebGAL {}, found {}",
            crate::engine_version(),
            info.version.as_deref().unwrap_or("unknown version")
        ));
    }
    Ok(info)
}

pub fn installed_info(target: &Path) -> Result<RuntimeInfo, String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| "Engine installer is unavailable")?;
    recover(target)?;
    let mut info = read_info(target);
    info.installed = validate(target).is_ok();
    Ok(info)
}

pub fn install_archive(archive: &Path, target: &Path) -> Result<RuntimeInfo, String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| "Engine installer is unavailable")?;
    let parent = target.parent().ok_or("Missing engine directory")?;
    fs::create_dir_all(parent).map_err(|error| format!("Create engine directory: {error}"))?;
    recover(target)?;
    if fs::metadata(archive)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_ENGINE_ARCHIVE_BYTES
    {
        return Err("Engine ZIP exceeds the 256 MiB limit".into());
    }
    let staging = tempfile::Builder::new()
        .prefix(".engine-")
        .tempdir_in(parent)
        .map_err(|error| format!("Create engine staging directory: {error}"))?;
    let contents = staging.path().join("contents");
    let reader = fs::File::open(archive).map_err(|error| format!("Open engine ZIP: {error}"))?;
    ollaic_core::archive::extract_archive(reader, &contents).map_err(|error| error.to_string())?;
    let source = if contents.join("index.html").is_file() {
        contents
    } else {
        let entries = fs::read_dir(&contents)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let candidates: Vec<_> = entries
            .into_iter()
            .map(|entry| entry.path())
            .filter(|path| path.join("index.html").is_file())
            .collect();
        if candidates.len() != 1 {
            return Err("Engine ZIP must contain one WebGAL runtime".into());
        }
        candidates[0].clone()
    };
    validate(&source)?;
    let backup = backup_path(target)?;
    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("Remove previous engine backup: {error}"))?;
    }
    if target.exists() {
        fs::rename(target, &backup).map_err(|error| format!("Back up engine: {error}"))?;
    }
    if let Err(error) = fs::rename(&source, target) {
        recover(target)?;
        return Err(format!("Install engine: {error}"));
    }
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Sync engine installation: {error}"))?;
    // Retain a recovery copy until the replacement has been validated and published.
    let info = validate(target)?;
    if backup.exists() {
        fs::remove_dir_all(backup).map_err(|error| format!("Remove engine backup: {error}"))?;
    }
    Ok(info)
}
