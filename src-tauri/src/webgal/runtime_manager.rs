use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub installed: bool,
    pub path: String,
    pub version: Option<String>,
}

pub fn read_info(dir: &Path) -> RuntimeInfo {
    let installed = dir.join("index.html").is_file();
    let version = if installed {
        std::fs::read_to_string(dir.join("webgal-engine.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("webgalVersion").and_then(|x| x.as_str()).map(String::from))
    } else {
        None
    };
    RuntimeInfo {
        installed,
        path: dir.to_string_lossy().to_string(),
        version,
    }
}

/// Download and extract `WebGAL-<version>-web.zip` into `target_dir`.
///
/// The current contents of `target_dir` are removed first. Extraction is performed
/// into a temporary sibling directory and then atomically renamed into place, so
/// a running runtime never sees partial files.
pub async fn install(version: &str, target_dir: &Path) -> Result<(), String> {
    let url = format!(
        "https://github.com/OpenWebGAL/WebGAL/releases/download/{ver}/WebGAL-{ver}-web.zip",
        ver = version
    );
    eprintln!("[runtime_manager] downloading {url}");

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body failed: {e}"))?;

    let parent = target_dir
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("create parent failed: {e}"))?;

    let staging = parent.join(format!(
        ".WebGAL_Template.staging-{}",
        std::process::id()
    ));
    if staging.exists() {
        tokio::fs::remove_dir_all(&staging)
            .await
            .map_err(|e| format!("clear staging failed: {e}"))?;
    }
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|e| format!("create staging failed: {e}"))?;

    let staging_clone = staging.clone();
    let extract_result = tokio::task::spawn_blocking(move || extract_zip(&bytes, &staging_clone))
        .await
        .map_err(|e| format!("extract task panicked: {e}"))?;

    if let Err(e) = extract_result {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(e);
    }

    if !staging.join("index.html").is_file() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err("extraction missing index.html".into());
    }

    // Atomic swap: move existing aside, install staging, drop old.
    let backup = parent.join(format!(
        ".WebGAL_Template.old-{}",
        std::process::id()
    ));
    if target_dir.exists() {
        tokio::fs::rename(target_dir, &backup)
            .await
            .map_err(|e| format!("backup existing failed: {e}"))?;
    }
    if let Err(e) = tokio::fs::rename(&staging, target_dir).await {
        if backup.exists() {
            let _ = tokio::fs::rename(&backup, target_dir).await;
        }
        return Err(format!("install rename failed: {e}"));
    }
    if backup.exists() {
        let _ = tokio::fs::remove_dir_all(&backup).await;
    }

    eprintln!("[runtime_manager] installed at {}", target_dir.display());
    Ok(())
}

fn extract_zip(bytes: &[u8], target: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("zip open failed: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        let Some(rel) = entry.enclosed_name() else {
            // Skip entries with absolute or traversing paths.
            continue;
        };
        let outpath: PathBuf = target.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("mkdir {}: {e}", outpath.display()))?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut out =
            std::fs::File::create(&outpath).map_err(|e| format!("create {}: {e}", outpath.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("write {}: {e}", outpath.display()))?;
    }
    Ok(())
}
