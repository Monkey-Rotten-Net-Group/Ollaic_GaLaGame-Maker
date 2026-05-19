use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetInfo {
    pub name: String,
    pub path: String,
    pub category: String,
    pub size: u64,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUsage {
    pub scene_file: String,
    pub line_number: usize,
    pub line_content: String,
    pub command: String,
}

fn category_to_dir(category: &str) -> Option<String> {
    match category {
        "scene" | "background" => Some("background".to_string()),
        "character" | "figure" => Some("figure".to_string()),
        "music" | "bgm" => Some("bgm".to_string()),
        "sfx" => Some("sfx".to_string()),
        "vocal" => Some("vocal".to_string()),
        "video" => Some("video".to_string()),
        "animation" => Some("animation".to_string()),
        "tex" => Some("tex".to_string()),
        "reference" => Some("config/references".to_string()),
        _ if category.starts_with("reference/") => {
            let tail = category.trim_start_matches("reference/");
            if tail
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
            {
                None
            } else {
                Some(format!("config/references/{tail}"))
            }
        }
        _ => None,
    }
}

fn is_media_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    let exts = [
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp3", ".ogg", ".wav", ".flac", ".aac",
        ".mp4", ".webm", ".avi",
    ];
    exts.iter().any(|e| lower.ends_with(e))
}

fn list_dir_files(dir: &PathBuf) -> Result<Vec<AssetInfo>, String> {
    let mut result = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}: {e}", dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !is_media_file(&name) {
            continue;
        }
        let metadata = path.metadata().map_err(|e| e.to_string())?;
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        result.push(AssetInfo {
            name,
            path: path.to_string_lossy().to_string(),
            category: String::new(),
            size: metadata.len(),
            extension: ext,
        });
    }
    Ok(result)
}

/// List all media files in a project's asset subdirectory.
/// `category` maps to one of the `game/` subdirs: background, figure, bgm, vocal, video, animation, tex.
#[tauri::command]
pub fn list_assets(project_path: String, category: String) -> Result<Vec<AssetInfo>, String> {
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let dir = PathBuf::from(&project_path).join("game").join(&subdir);

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut assets = list_dir_files(&dir)?;
    for a in &mut assets {
        a.category = subdir.to_string();
    }
    Ok(assets)
}

/// List assets across all subdirectories (used for "all" view).
#[tauri::command]
pub fn list_all_assets(project_path: String) -> Result<Vec<AssetInfo>, String> {
    let dirs = [
        "background",
        "figure",
        "bgm",
        "sfx",
        "vocal",
        "video",
        "animation",
        "tex",
    ];
    let mut all = Vec::new();
    for d in &dirs {
        let dir = PathBuf::from(&project_path).join("game").join(d);
        if !dir.exists() {
            continue;
        }
        let mut assets = list_dir_files(&dir)?;
        for a in &mut assets {
            a.category = d.to_string();
        }
        all.append(&mut assets);
    }
    Ok(all)
}

/// Copy an external file into the project's asset directory.
#[tauri::command]
pub fn import_asset(
    source_path: String,
    project_path: String,
    category: String,
) -> Result<AssetInfo, String> {
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let target_dir = PathBuf::from(&project_path).join("game").join(&subdir);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let source = PathBuf::from(&source_path);
    let filename = source
        .file_name()
        .ok_or_else(|| "无效的文件路径".to_string())?
        .to_string_lossy()
        .to_string();
    let target = target_dir.join(&filename);

    // Avoid overwriting — append (1), (2), etc.
    let target = unique_path(target);

    fs::copy(&source, &target).map_err(|e| format!("复制文件失败: {e}"))?;

    let metadata = target.metadata().map_err(|e| e.to_string())?;
    let ext = target
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(AssetInfo {
        name: target
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        path: target.to_string_lossy().to_string(),
        category: subdir.to_string(),
        size: metadata.len(),
        extension: ext,
    })
}

/// Delete an asset file from the project.
#[tauri::command]
pub fn delete_asset(
    project_path: String,
    category: String,
    filename: String,
) -> Result<(), String> {
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let path = PathBuf::from(&project_path)
        .join("game")
        .join(subdir)
        .join(&filename);

    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }

    // Safety check: ensure path is still within the project
    let canonical_project = PathBuf::from(&project_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&project_path));
    let canonical_target = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_target.starts_with(&canonical_project) {
        return Err("不允许删除项目目录外的文件".to_string());
    }

    fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    Ok(())
}

/// Rename an asset file.
#[tauri::command]
pub fn rename_asset(
    project_path: String,
    category: String,
    old_name: String,
    new_name: String,
) -> Result<AssetInfo, String> {
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let old_path = PathBuf::from(&project_path)
        .join("game")
        .join(&subdir)
        .join(&old_name);
    let new_path = PathBuf::from(&project_path)
        .join("game")
        .join(&subdir)
        .join(&new_name);

    if !old_path.exists() {
        return Err(format!("文件不存在: {}", old_path.display()));
    }
    if new_path.exists() {
        return Err(format!("目标文件已存在: {}", new_path.display()));
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("重命名失败: {e}"))?;

    let metadata = new_path.metadata().map_err(|e| e.to_string())?;
    let ext = new_path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(AssetInfo {
        name: new_name,
        path: new_path.to_string_lossy().to_string(),
        category: subdir.to_string(),
        size: metadata.len(),
        extension: ext,
    })
}

#[tauri::command]
pub async fn find_asset_usages(
    project_path: String,
    filename: String,
) -> Result<Vec<AssetUsage>, String> {
    let scene_dir = PathBuf::from(&project_path).join("game").join("scene");
    if !scene_dir.exists() {
        return Ok(Vec::new());
    }

    let mut usages = Vec::new();
    let commands = [
        "changeBg",
        "changeFigure",
        "bgm",
        "playEffect",
        "vocal",
        "miniAvatar",
        "changeScene",
    ];

    let entries = fs::read_dir(&scene_dir)
        .map_err(|e| format!("无法读取场景目录 {}: {e}", scene_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }

        let scene_file = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("无法读取场景文件 {}: {e}", path.display()))?;

        for (line_index, line) in content.lines().enumerate() {
            if !line.contains(&filename) {
                continue;
            }
            let command = commands
                .iter()
                .find(|cmd| line.contains(&format!("{cmd}:")))
                .unwrap_or(&"unknown")
                .to_string();
            usages.push(AssetUsage {
                scene_file: scene_file.clone(),
                line_number: line_index + 1,
                line_content: line.trim().to_string(),
                command,
            });
        }
    }

    usages.sort_by(|a, b| {
        a.scene_file
            .cmp(&b.scene_file)
            .then(a.line_number.cmp(&b.line_number))
    });
    Ok(usages)
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path.extension().unwrap_or_default().to_string_lossy();
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new(""));

    for i in 1..100u32 {
        let new_name = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let candidate = parent.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    path // fallback — should never reach here
}
