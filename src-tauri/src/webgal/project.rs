use super::references;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;

/// WebGAL game/ subdirectory structure.
const GAME_DIRS: &[&str] = &[
    "animation",
    "background",
    "figure",
    "scene",
    "bgm",
    "vocal",
    "video",
    "tex",
];

/// Metadata about a WebGAL project on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Absolute path to the project root (parent of game/).
    pub path: String,
    /// Config values from game/config.txt.
    pub config: HashMap<String, String>,
    /// Scene file names found in game/scene/.
    pub scenes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub world_setting: String,
    pub writing_style: String,
    pub user_preferences: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub synopsis: String,
    pub description: String,
    pub cover_path: String,
    pub tags: Vec<String>,
    pub version: String,
    pub release_notes: String,
    pub last_export_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub path: String,
    #[serde(default = "default_snapshot_kind")]
    pub kind: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub includes_editor_state: bool,
    #[serde(default)]
    pub metadata_included: Option<bool>,
    #[serde(default)]
    pub story_plan_included: Option<bool>,
    #[serde(default)]
    pub file_count: Option<usize>,
}

// ---------------------------------------------------------------------------
// config.txt helpers
// ---------------------------------------------------------------------------

fn parse_config(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        // Format: Key:Value;
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_string();
            let mut val = line[colon + 1..].trim().to_string();
            // Strip trailing semicolon
            if val.ends_with(';') {
                val.pop();
            }
            map.insert(key, val);
        }
    }
    map
}

fn serialize_config(config: &HashMap<String, String>) -> String {
    let mut lines: Vec<String> = config
        .iter()
        .map(|(k, v)| format!("{}:{};", k, v))
        .collect();
    lines.sort(); // deterministic output
    lines.push(String::new());
    lines.join("\n")
}

fn default_project_config(name: &str) -> HashMap<String, String> {
    let mut config = HashMap::new();
    config.insert("Game_name".to_string(), name.to_string());
    config.insert("Game_key".to_string(), format!("{:x}", rand_u64()));
    config.insert(
        "Title_img".to_string(),
        "WebGAL_New_Enter_Image.webp".to_string(),
    );
    config.insert("Title_bgm".to_string(), String::new());
    config.insert("Enable_Appreciation".to_string(), "true".to_string());
    config
}

fn ensure_appreciation_enabled(config: &mut HashMap<String, String>) -> bool {
    if config.contains_key("Enable_Appreciation") {
        return false;
    }
    config.insert("Enable_Appreciation".to_string(), "true".to_string());
    true
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Initialize a new WebGAL project at `base_dir/name/`.
/// Creates the full game/ directory structure and config.txt.
#[tauri::command]
pub fn init_project(app: AppHandle, base_dir: String, name: String) -> Result<ProjectInfo, String> {
    let root = PathBuf::from(&base_dir).join(&name);
    let game = root.join("game");

    // Create all subdirectories
    for dir in GAME_DIRS {
        fs::create_dir_all(game.join(dir))
            .map_err(|e| format!("Failed to create {}: {}", dir, e))?;
    }

    // Write default config.txt
    let config = default_project_config(&name);

    let config_path = game.join("config.txt");
    fs::write(&config_path, serialize_config(&config))
        .map_err(|e| format!("Failed to write config.txt: {}", e))?;

    // Write default start.txt
    let start_path = game.join("scene").join("start.txt");
    fs::write(&start_path, "; 在这里开始你的故事\n")
        .map_err(|e| format!("Failed to write start.txt: {}", e))?;

    app.asset_protocol_scope()
        .allow_directory(&game, true)
        .map_err(|e| format!("Failed to allow asset directory {}: {}", game.display(), e))?;

    Ok(ProjectInfo {
        path: root.to_string_lossy().to_string(),
        config,
        scenes: vec!["start.txt".to_string()],
    })
}

/// Open an existing WebGAL project by its root directory path.
/// Reads config.txt and lists scene files.
#[tauri::command]
pub fn open_project(app: AppHandle, path: String) -> Result<ProjectInfo, String> {
    let root = PathBuf::from(&path);
    let game = root.join("game");

    if !game.is_dir() {
        return Err(format!(
            "Not a valid WebGAL project: {}/game/ not found",
            root.display()
        ));
    }

    // Read config
    let config_path = game.join("config.txt");
    let config = if config_path.exists() {
        let text = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config.txt: {}", e))?;
        let mut config = parse_config(&text);
        if ensure_appreciation_enabled(&mut config) {
            fs::write(&config_path, serialize_config(&config))
                .map_err(|e| format!("Failed to update config.txt: {}", e))?;
        }
        config
    } else {
        HashMap::new()
    };

    // List scenes
    let scenes = list_txt_files(&game.join("scene"))?;

    app.asset_protocol_scope()
        .allow_directory(&game, true)
        .map_err(|e| format!("Failed to allow asset directory {}: {}", game.display(), e))?;

    Ok(ProjectInfo {
        path: root.to_string_lossy().to_string(),
        config,
        scenes,
    })
}

/// Update config.txt for a project.
#[tauri::command]
pub fn save_config(project_path: String, config: HashMap<String, String>) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || save_config_locked(&project_path, config))
}

fn save_config_locked(project_path: &str, config: HashMap<String, String>) -> Result<(), String> {
    let config_path = PathBuf::from(&project_path).join("game").join("config.txt");
    fs::write(&config_path, serialize_config(&config))
        .map_err(|e| format!("Failed to write config.txt: {}", e))
}

/// Get the full path for a scene file within a project.
#[tauri::command]
pub fn get_scene_path(project_path: String, scene_name: String) -> Result<String, String> {
    let path = PathBuf::from(&project_path)
        .join("game")
        .join("scene")
        .join(&scene_name);
    Ok(path.to_string_lossy().to_string())
}

/// Create a new scene file in the project.
#[tauri::command]
pub fn create_scene(project_path: String, scene_name: String) -> Result<String, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || create_scene_locked(&project_path, scene_name))
}

pub(crate) fn create_scene_locked(
    project_path: &str,
    scene_name: String,
) -> Result<String, String> {
    let scene_dir = PathBuf::from(&project_path).join("game").join("scene");
    fs::create_dir_all(&scene_dir).map_err(|e| format!("Failed to create scene dir: {}", e))?;

    let name = if scene_name.ends_with(".txt") {
        scene_name
    } else {
        format!("{}.txt", scene_name)
    };

    let path = scene_dir.join(&name);
    if path.exists() {
        return Err(format!("Scene {} already exists", name));
    }

    crate::json_store::write_crash_safe(&path, format!("; {}\n", name).as_bytes())
        .map_err(|e| format!("Failed to create scene: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_project_memory(project_path: String) -> Result<Option<ProjectMemory>, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || read_project_memory_locked(&project_path))
}

pub(crate) fn read_project_memory_locked(
    project_path: &str,
) -> Result<Option<ProjectMemory>, String> {
    let path = PathBuf::from(&project_path)
        .join("game")
        .join("ai-memory.json");
    if !path.exists() && !crate::json_store::backup_path(&path).exists() {
        return Ok(None);
    }
    let text = crate::json_store::read_to_string_recovering(&path)
        .map_err(|e| format!("Failed to read ai-memory.json: {}", e))?;
    let memory = serde_json::from_str::<ProjectMemory>(&text)
        .map_err(|e| format!("Failed to parse ai-memory.json: {}", e))?;
    Ok(Some(memory))
}

#[tauri::command]
pub fn save_project_memory(project_path: String, memory: ProjectMemory) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        save_project_memory_locked(&project_path, memory)
    })
}

pub(crate) fn save_project_memory_locked(
    project_path: &str,
    memory: ProjectMemory,
) -> Result<(), String> {
    let game_dir = PathBuf::from(&project_path).join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }
    let path = game_dir.join("ai-memory.json");
    let text = serde_json::to_string_pretty(&memory)
        .map_err(|e| format!("Failed to serialize ai-memory.json: {}", e))?;
    crate::json_store::write_crash_safe(&path, text.as_bytes())
        .map_err(|e| format!("Failed to write ai-memory.json: {}", e))
}

#[tauri::command]
pub fn read_project_metadata(project_path: String) -> Result<Option<ProjectMetadata>, String> {
    let path = project_metadata_path(&project_path);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

#[tauri::command]
pub fn save_project_metadata(
    project_path: String,
    metadata: ProjectMetadata,
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        write_project_metadata(&project_path, &metadata)
    })
}

#[tauri::command]
pub fn create_project_snapshot(
    project_path: String,
    label: Option<String>,
    kind: Option<String>,
    description: Option<String>,
) -> Result<SnapshotInfo, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        create_project_snapshot_locked(&project_path, label, kind, description)
    })
}

pub(crate) fn create_project_snapshot_locked(
    project_path: &str,
    label: Option<String>,
    kind: Option<String>,
    description: Option<String>,
) -> Result<SnapshotInfo, String> {
    let root = PathBuf::from(&project_path);
    let game_dir = root.join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }

    let created_at = now_millis().to_string();
    let label = normalize_snapshot_label(label);
    let kind = normalize_snapshot_kind(kind);
    let description = normalize_snapshot_description(description);
    let id_label = snapshot_id_label(&label);
    let (id, snapshot_dir) = unique_snapshot_dir(project_path, &format!("{created_at}-{id_label}"));
    fs::create_dir_all(&snapshot_dir)
        .map_err(|e| format!("Failed to create snapshot directory: {e}"))?;

    let snapshot_result = (|| {
        copy_dir_recursive(&game_dir, &snapshot_dir.join("game"))?;
        let metadata_included = copy_project_metadata_to_snapshot(&root, &snapshot_dir)?;
        let story_plan_included = copy_story_plan_to_snapshot(&root, &snapshot_dir)?;
        let copied_editor_state = copy_editor_state_to_snapshot(&root, &snapshot_dir)?;
        let file_count = count_files_recursive(&snapshot_dir)?;

        let info = SnapshotInfo {
            id,
            label,
            created_at,
            path: snapshot_dir.to_string_lossy().to_string(),
            kind,
            description,
            includes_editor_state: copied_editor_state,
            metadata_included: Some(metadata_included),
            story_plan_included: Some(story_plan_included),
            file_count: Some(file_count),
        };
        let manifest = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
        fs::write(snapshot_dir.join("snapshot.json"), manifest)
            .map_err(|e| format!("Failed to write snapshot manifest: {e}"))?;
        Ok(info)
    })();

    if snapshot_result.is_err() {
        let _ = fs::remove_dir_all(&snapshot_dir);
    }
    snapshot_result
}

#[tauri::command]
pub fn list_project_snapshots(project_path: String) -> Result<Vec<SnapshotInfo>, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || list_project_snapshots_locked(&project_path))
}

fn list_project_snapshots_locked(project_path: &str) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshots_dir(project_path);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("Failed to read snapshots: {e}"))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("snapshot.json");
        if !manifest.exists() {
            continue;
        }
        let text = fs::read_to_string(&manifest)
            .map_err(|e| format!("Failed to read {}: {e}", manifest.display()))?;
        if let Ok(info) = serde_json::from_str::<SnapshotInfo>(&text) {
            snapshots.push(info);
        }
    }
    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

#[tauri::command]
pub fn rename_project_snapshot(
    project_path: String,
    snapshot_id: String,
    label: String,
) -> Result<SnapshotInfo, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        rename_project_snapshot_locked(&project_path, &snapshot_id, label)
    })
}

fn rename_project_snapshot_locked(
    project_path: &str,
    snapshot_id: &str,
    label: String,
) -> Result<SnapshotInfo, String> {
    validate_snapshot_id(snapshot_id)?;
    let snapshot_dir = snapshots_dir(project_path).join(snapshot_id);
    if !snapshot_dir.is_dir() {
        return Err(format!("Snapshot not found: {snapshot_id}"));
    }
    let manifest_path = snapshot_dir.join("snapshot.json");
    let text = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read {}: {e}", manifest_path.display()))?;
    let mut info = serde_json::from_str::<SnapshotInfo>(&text)
        .map_err(|e| format!("Failed to parse {}: {e}", manifest_path.display()))?;
    info.label = normalize_snapshot_label(Some(label));
    let manifest = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    crate::json_store::write_crash_safe(&manifest_path, manifest.as_bytes())
        .map_err(|e| format!("Failed to write {}: {e}", manifest_path.display()))?;
    Ok(info)
}

#[tauri::command]
pub fn delete_project_snapshot(project_path: String, snapshot_id: String) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        delete_project_snapshot_locked(&project_path, &snapshot_id)
    })
}

pub(crate) fn delete_project_snapshot_locked(
    project_path: &str,
    snapshot_id: &str,
) -> Result<(), String> {
    validate_snapshot_id(snapshot_id)?;
    let snapshot_dir = snapshots_dir(project_path).join(snapshot_id);
    if !snapshot_dir.is_dir() {
        return Err(format!("Snapshot not found: {snapshot_id}"));
    }
    fs::remove_dir_all(&snapshot_dir)
        .map_err(|e| format!("Failed to delete snapshot {snapshot_id}: {e}"))
}

#[tauri::command]
pub fn restore_project_snapshot(project_path: String, snapshot_id: String) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        crate::flow_edit_lock::ensure_editable(
            &root,
            crate::flow_edit_lock::FlowResource::StoryPlan,
        )?;
        restore_project_snapshot_locked(&project_path, &snapshot_id)
    })
}

pub(crate) fn restore_project_snapshot_locked(
    project_path: &str,
    snapshot_id: &str,
) -> Result<(), String> {
    validate_snapshot_id(snapshot_id)?;
    let root = PathBuf::from(&project_path);
    let snapshot_dir = snapshots_dir(project_path).join(snapshot_id);
    let snapshot_game = snapshot_dir.join("game");
    if !snapshot_game.is_dir() {
        return Err(format!("Snapshot not found: {snapshot_id}"));
    }

    let staging_dir = editor_dir(&root).join(format!("restore-staging-{}", now_millis()));
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)
            .map_err(|e| format!("Failed to clear restore staging directory: {e}"))?;
    }
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create restore staging directory: {e}"))?;

    let manifest = read_snapshot_manifest(&snapshot_dir)?;
    let restore_result = (|| {
        copy_dir_recursive(&snapshot_game, &staging_dir.join("game"))?;
        copy_snapshot_metadata_to_staging(&snapshot_dir, &staging_dir)?;
        copy_snapshot_story_plan_to_staging(&snapshot_dir, &staging_dir)?;
        copy_snapshot_editor_state_to_staging(&snapshot_dir, &staging_dir)?;
        validate_staged_restore(manifest.as_ref(), &staging_dir)?;
        activate_staged_project_state(&root, &staging_dir, manifest.as_ref())?;
        Ok(())
    })();

    let _ = fs::remove_dir_all(&staging_dir);
    restore_result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn list_txt_files(dir: &Path) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Read entry error: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("txt") {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                files.push(name.to_string());
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Simple deterministic-enough u64 for game keys.
fn rand_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    d.as_nanos() as u64
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Result of exporting a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub success: bool,
    pub warnings: Vec<String>,
    pub output_path: String,
    pub issues: Vec<ExportValidationIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportValidationIssue {
    pub level: ExportValidationLevel,
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportValidationLevel {
    Warning,
    Error,
}

/// Export a WebGAL project: copies the game/ directory to the output path.
/// Optionally creates a .zip archive.
#[tauri::command]
pub fn export_project(
    project_path: String,
    output_path: String,
    as_zip: bool,
    metadata: Option<ProjectMetadata>,
) -> Result<ExportResult, String> {
    let game_dir = PathBuf::from(&project_path).join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }

    let dest = PathBuf::from(&output_path);
    let mut warnings: Vec<String> = Vec::new();
    let mut issues =
        validate_export_source(&PathBuf::from(&project_path), &game_dir, metadata.as_ref())?;

    // Validate referenced assets before copying
    let asset_warnings = validate_assets(&game_dir)?;
    warnings.extend(asset_warnings);
    warnings.extend(
        issues
            .iter()
            .filter(|issue| issue.level == ExportValidationLevel::Warning)
            .map(|issue| issue.message.clone()),
    );

    if has_export_errors(&issues) {
        return Ok(ExportResult {
            success: false,
            warnings,
            output_path: String::new(),
            issues,
        });
    }

    if let Some(metadata) = metadata.as_ref() {
        write_project_metadata(&project_path, metadata)?;
    }

    let final_output = if as_zip {
        fs::create_dir_all(&dest).map_err(|e| {
            format!(
                "Failed to create export directory {}: {}",
                dest.display(),
                e
            )
        })?;
        let zip_path = dest.join(export_zip_name(&project_path, metadata.as_ref()));
        write_export_zip(&game_dir, metadata.as_ref(), &zip_path)?;
        zip_path
    } else {
        let game_dest = dest.join("game");
        if game_dest.exists() {
            fs::remove_dir_all(&game_dest)
                .map_err(|e| format!("Failed to clear existing export game directory: {e}"))?;
        }
        copy_dir_recursive(&game_dir, &game_dest)?;
        if let Some(metadata) = metadata.as_ref() {
            let metadata_path = dest.join("project-metadata.json");
            let text = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
            fs::write(&metadata_path, text)
                .map_err(|e| format!("Failed to write {}: {e}", metadata_path.display()))?;
        }
        dest
    };

    issues.extend(validate_export_output(
        &final_output,
        as_zip,
        metadata.is_some(),
    )?);
    let success = !has_export_errors(&issues);

    Ok(ExportResult {
        success,
        warnings,
        output_path: final_output.to_string_lossy().to_string(),
        issues,
    })
}

fn validate_export_source(
    project_root: &Path,
    game_dir: &Path,
    metadata: Option<&ProjectMetadata>,
) -> Result<Vec<ExportValidationIssue>, String> {
    let mut issues = Vec::new();

    let config_path = game_dir.join("config.txt");
    if !config_path.is_file() {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "missing_config",
            "导出失败：缺少 game/config.txt",
            Some(&config_path),
        ));
    }

    let scene_dir = game_dir.join("scene");
    let scene_count = list_txt_files(&scene_dir)?.len();
    if scene_count == 0 {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "missing_scene",
            "导出失败：game/scene/ 下至少需要一个 .txt 场景文件",
            Some(&scene_dir),
        ));
    }

    match metadata {
        Some(metadata) => {
            if metadata.version.trim().is_empty() {
                issues.push(export_issue(
                    ExportValidationLevel::Warning,
                    "missing_metadata_version",
                    "项目元信息缺少版本号，导出仍会继续",
                    Some(&project_metadata_path(&project_root.to_string_lossy())),
                ));
            }
            let cover_path = metadata.cover_path.trim();
            if cover_path.is_empty() {
                issues.push(export_issue(
                    ExportValidationLevel::Warning,
                    "missing_cover_path",
                    "项目元信息未设置封面路径，导出仍会继续",
                    Some(&project_metadata_path(&project_root.to_string_lossy())),
                ));
            } else {
                let cover = PathBuf::from(cover_path);
                let resolved = if cover.is_absolute() {
                    cover
                } else {
                    project_root.join(cover)
                };
                if !resolved.exists() {
                    issues.push(export_issue(
                        ExportValidationLevel::Warning,
                        "missing_cover_file",
                        "项目元信息中的封面文件不存在，导出仍会继续",
                        Some(&resolved),
                    ));
                }
            }
        }
        None => issues.push(export_issue(
            ExportValidationLevel::Warning,
            "missing_metadata",
            "未提供项目元信息，导出产物不会包含 project-metadata.json",
            Some(&project_metadata_path(&project_root.to_string_lossy())),
        )),
    }

    Ok(issues)
}

fn validate_export_output(
    output_path: &Path,
    as_zip: bool,
    expect_metadata: bool,
) -> Result<Vec<ExportValidationIssue>, String> {
    if as_zip {
        validate_zip_export_output(output_path, expect_metadata)
    } else {
        Ok(validate_directory_export_output(
            output_path,
            expect_metadata,
        ))
    }
}

fn validate_directory_export_output(
    output_path: &Path,
    expect_metadata: bool,
) -> Vec<ExportValidationIssue> {
    let mut issues = Vec::new();
    let config_path = output_path.join("game").join("config.txt");
    if !config_path.is_file() {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_config",
            "导出产物缺少 game/config.txt",
            Some(&config_path),
        ));
    }

    let scene_dir = output_path.join("game").join("scene");
    let has_scene = list_txt_files(&scene_dir)
        .map(|files| !files.is_empty())
        .unwrap_or(false);
    if !has_scene {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_scene",
            "导出产物缺少 game/scene/*.txt",
            Some(&scene_dir),
        ));
    }

    if expect_metadata {
        let metadata_path = output_path.join("project-metadata.json");
        if !metadata_path.is_file() {
            issues.push(export_issue(
                ExportValidationLevel::Error,
                "export_missing_metadata",
                "导出产物缺少 project-metadata.json",
                Some(&metadata_path),
            ));
        }
    }

    issues
}

fn validate_zip_export_output(
    output_path: &Path,
    expect_metadata: bool,
) -> Result<Vec<ExportValidationIssue>, String> {
    let file = fs::File::open(output_path)
        .map_err(|e| format!("Failed to open export zip {}: {e}", output_path.display()))?;
    let archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "Failed to inspect export zip {}: {e}",
            output_path.display()
        )
    })?;
    let names: Vec<String> = archive.file_names().map(|name| name.to_string()).collect();
    let mut issues = Vec::new();

    if !names.iter().any(|name| name == "game/config.txt") {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_config",
            "导出 zip 缺少 game/config.txt",
            Some(output_path),
        ));
    }

    if !names
        .iter()
        .any(|name| name.starts_with("game/scene/") && name.ends_with(".txt"))
    {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_scene",
            "导出 zip 缺少 game/scene/*.txt",
            Some(output_path),
        ));
    }

    if expect_metadata && !names.iter().any(|name| name == "project-metadata.json") {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_metadata",
            "导出 zip 缺少 project-metadata.json",
            Some(output_path),
        ));
    }

    Ok(issues)
}

fn export_issue(
    level: ExportValidationLevel,
    code: &str,
    message: &str,
    path: Option<&Path>,
) -> ExportValidationIssue {
    ExportValidationIssue {
        level,
        code: code.to_string(),
        message: message.to_string(),
        path: path.map(|p| p.to_string_lossy().to_string()),
    }
}

fn has_export_errors(issues: &[ExportValidationIssue]) -> bool {
    issues
        .iter()
        .any(|issue| issue.level == ExportValidationLevel::Error)
}

/// Scan all scene files and check that referenced assets exist.
fn validate_assets(game_dir: &Path) -> Result<Vec<String>, String> {
    let mut warnings: Vec<String> = Vec::new();
    let scene_dir = game_dir.join("scene");

    if !scene_dir.is_dir() {
        return Ok(warnings);
    }

    let entries =
        fs::read_dir(&scene_dir).map_err(|e| format!("Failed to read scene dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read entry error: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }

        let scene_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        for reference in references::find_asset_references(&content) {
            let asset_path = game_dir.join(reference.category).join(&reference.filename);
            if !asset_path.exists() {
                warnings.push(format!(
                    "[{}] 引用不存在的素材: {} ({}: {})",
                    scene_name, reference.filename, reference.command, reference.filename
                ));
            }
        }
    }

    Ok(warnings)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create directory {}: {}", dst.display(), e))?;

    let entries = fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {}: {}", src.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read entry error: {}", e))?;
        let path = entry.path();
        let dest_path = dst.join(path.file_name().unwrap_or_default());

        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path).map_err(|e| {
                format!(
                    "Failed to copy {} -> {}: {}",
                    path.display(),
                    dest_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

fn project_metadata_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join("project-metadata.json")
}

fn write_project_metadata(project_path: &str, metadata: &ProjectMetadata) -> Result<(), String> {
    let path = project_metadata_path(project_path);
    let text = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn snapshots_dir(project_path: &str) -> PathBuf {
    editor_dir(&PathBuf::from(project_path)).join("snapshots")
}

fn editor_dir(project_root: &Path) -> PathBuf {
    project_root.join(".webgal-editor")
}

fn unique_snapshot_dir(project_path: &str, base_id: &str) -> (String, PathBuf) {
    let dir = snapshots_dir(project_path);
    let mut id = base_id.to_string();
    let mut path = dir.join(&id);
    let mut suffix = 2;
    while path.exists() {
        id = format!("{base_id}-{suffix}");
        path = dir.join(&id);
        suffix += 1;
    }
    (id, path)
}

fn copy_project_metadata_to_snapshot(
    project_root: &Path,
    snapshot_dir: &Path,
) -> Result<bool, String> {
    let src = project_root.join("project-metadata.json");
    if !src.exists() {
        return Ok(false);
    }
    fs::copy(&src, snapshot_dir.join("project-metadata.json")).map_err(|e| {
        format!(
            "Failed to copy project metadata {} -> {}: {e}",
            src.display(),
            snapshot_dir.display()
        )
    })?;
    Ok(true)
}

fn copy_story_plan_to_snapshot(project_root: &Path, snapshot_dir: &Path) -> Result<bool, String> {
    let Some(plan) = crate::story_plan::load_plan(project_root)
        .map_err(|e| format!("Failed to load StoryPlan for snapshot: {e}"))?
    else {
        return Ok(false);
    };
    crate::story_plan::save_plan(snapshot_dir, &plan)
        .map_err(|e| format!("Failed to write StoryPlan snapshot: {e}"))?;
    Ok(true)
}

fn copy_editor_state_to_snapshot(project_root: &Path, snapshot_dir: &Path) -> Result<bool, String> {
    let src = editor_dir(project_root);
    if !src.is_dir() {
        return Ok(false);
    }
    let dst = snapshot_dir.join(".webgal-editor");
    let mut copied = false;
    for entry in fs::read_dir(&src)
        .map_err(|e| format!("Failed to read editor state {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if should_skip_editor_state_entry(&name.to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        let dest_path = dst.join(&name);
        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            fs::create_dir_all(&dst)
                .map_err(|e| format!("Failed to create editor snapshot dir: {e}"))?;
            fs::copy(&path, &dest_path).map_err(|e| {
                format!(
                    "Failed to copy editor state {} -> {}: {e}",
                    path.display(),
                    dest_path.display()
                )
            })?;
        }
        copied = true;
    }
    Ok(copied)
}

fn should_skip_editor_state_entry(name: &str) -> bool {
    name == "snapshots"
        || name.starts_with("restore-staging-")
        || name.starts_with("restore-backup-")
}

fn normalize_snapshot_label(label: Option<String>) -> String {
    let label = label
        .unwrap_or_else(|| "snapshot".to_string())
        .trim()
        .to_string();
    if label.is_empty() {
        "snapshot".to_string()
    } else {
        label
    }
}

fn default_snapshot_kind() -> String {
    "manual".to_string()
}

fn normalize_snapshot_kind(kind: Option<String>) -> String {
    let kind = kind
        .unwrap_or_else(default_snapshot_kind)
        .trim()
        .to_string();
    match kind.as_str() {
        "manual" | "beforeRestore" | "exportCandidate" | "auto" => kind,
        _ => default_snapshot_kind(),
    }
}

fn normalize_snapshot_description(description: Option<String>) -> Option<String> {
    description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn snapshot_id_label(label: &str) -> String {
    let clean_label = label
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if clean_label.is_empty() {
        "snapshot".to_string()
    } else {
        clean_label
    }
}

fn count_files_recursive(dir: &Path) -> Result<usize, String> {
    let mut count = 0;
    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read {}: {e}", dir.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            count += count_files_recursive(&path)?;
        } else {
            count += 1;
        }
    }
    Ok(count)
}

fn copy_snapshot_metadata_to_staging(
    snapshot_dir: &Path,
    staging_dir: &Path,
) -> Result<(), String> {
    let src = snapshot_dir.join("project-metadata.json");
    if src.exists() {
        fs::copy(&src, staging_dir.join("project-metadata.json")).map_err(|e| {
            format!(
                "Failed to stage snapshot metadata {} -> {}: {e}",
                src.display(),
                staging_dir.display()
            )
        })?;
    }
    Ok(())
}

fn copy_snapshot_story_plan_to_staging(
    snapshot_dir: &Path,
    staging_dir: &Path,
) -> Result<(), String> {
    let src = snapshot_dir.join(".ollaic").join("plan.json");
    if src.exists() {
        let dst = staging_dir.join(".ollaic").join("plan.json");
        fs::create_dir_all(dst.parent().expect("staged StoryPlan has a parent"))
            .map_err(|e| format!("Failed to create staged StoryPlan directory: {e}"))?;
        fs::copy(&src, &dst).map_err(|e| {
            format!(
                "Failed to stage snapshot StoryPlan {} -> {}: {e}",
                src.display(),
                dst.display()
            )
        })?;
    }
    Ok(())
}

fn copy_snapshot_editor_state_to_staging(
    snapshot_dir: &Path,
    staging_dir: &Path,
) -> Result<(), String> {
    let src = snapshot_dir.join(".webgal-editor");
    if src.is_dir() {
        copy_dir_recursive(&src, &staging_dir.join(".webgal-editor"))?;
    }
    Ok(())
}

fn validate_staged_restore(
    manifest: Option<&SnapshotInfo>,
    staging_dir: &Path,
) -> Result<(), String> {
    if !staging_dir.join("game").is_dir() {
        return Err("Snapshot game directory was not staged".to_string());
    }
    let staged_metadata = staging_dir.join("project-metadata.json");
    if manifest.and_then(|info| info.metadata_included) == Some(true) && !staged_metadata.is_file()
    {
        return Err("Snapshot manifest says metadata exists, but it is missing".to_string());
    }
    let staged_story_plan = staging_dir.join(".ollaic").join("plan.json");
    match (
        manifest.and_then(|info| info.story_plan_included),
        staged_story_plan.is_file(),
    ) {
        (Some(true), false) => {
            return Err("Snapshot manifest says StoryPlan exists, but it is missing".to_string())
        }
        (Some(false), true) => {
            return Err(
                "Snapshot manifest says StoryPlan is absent, but the snapshot contains one"
                    .to_string(),
            )
        }
        (_, true) => {
            let plan = crate::story_plan::load_plan(staging_dir)
                .map_err(|e| format!("Snapshot StoryPlan is invalid: {e}"))?
                .ok_or_else(|| "Snapshot StoryPlan disappeared during validation".to_string())?;
            crate::story_plan::save_plan(staging_dir, &plan)
                .map_err(|e| format!("Failed to normalize snapshot StoryPlan: {e}"))?;
        }
        (_, false) => {}
    }
    Ok(())
}

fn activate_staged_project_state(
    project_root: &Path,
    staging_dir: &Path,
    manifest: Option<&SnapshotInfo>,
) -> Result<(), String> {
    let editor = editor_dir(project_root);
    fs::create_dir_all(&editor)
        .map_err(|e| format!("Failed to create editor state directory: {e}"))?;

    let game_dir = project_root.join("game");
    let staged_game = staging_dir.join("game");
    let game_backup = editor.join(format!("restore-backup-game-{}", now_millis()));
    if game_backup.exists() {
        fs::remove_dir_all(&game_backup)
            .map_err(|e| format!("Failed to clear restore backup: {e}"))?;
    }

    if game_dir.exists() {
        fs::rename(&game_dir, &game_backup)
            .map_err(|e| format!("Failed to move current game directory to backup: {e}"))?;
    }

    if let Err(e) = fs::rename(&staged_game, &game_dir) {
        if game_backup.exists() {
            let _ = fs::rename(&game_backup, &game_dir);
        }
        return Err(format!("Failed to activate restored game directory: {e}"));
    }

    let metadata_backup = backup_current_metadata(project_root, staging_dir, manifest)?;
    let metadata_result = restore_staged_metadata(project_root, staging_dir, manifest);
    if let Err(e) = metadata_result {
        rollback_metadata_backup(project_root, metadata_backup.as_ref());
        rollback_game_restore(&game_dir, &game_backup);
        return Err(e);
    }

    let story_plan_backup = match backup_current_story_plan(project_root, staging_dir, manifest) {
        Ok(backup) => backup,
        Err(e) => {
            rollback_metadata_backup(project_root, metadata_backup.as_ref());
            rollback_game_restore(&game_dir, &game_backup);
            return Err(e);
        }
    };
    let story_plan_result = restore_staged_story_plan(project_root, staging_dir, manifest);
    if let Err(e) = story_plan_result {
        rollback_story_plan_backup(project_root, story_plan_backup.as_ref());
        rollback_metadata_backup(project_root, metadata_backup.as_ref());
        rollback_game_restore(&game_dir, &game_backup);
        return Err(e);
    }

    let editor_result = restore_staged_editor_state(project_root, staging_dir, manifest);
    if let Err(e) = editor_result {
        rollback_story_plan_backup(project_root, story_plan_backup.as_ref());
        rollback_metadata_backup(project_root, metadata_backup.as_ref());
        rollback_game_restore(&game_dir, &game_backup);
        return Err(e);
    }

    // Activation is already committed. Cleanup failures leave recoverable
    // backup files behind, but must not report that the restore itself failed.
    let _ = cleanup_story_plan_backup(story_plan_backup);
    let _ = cleanup_metadata_backup(metadata_backup);
    if game_backup.exists() {
        let _ = fs::remove_dir_all(&game_backup);
    }
    Ok(())
}

fn restore_staged_metadata(
    project_root: &Path,
    staging_dir: &Path,
    manifest: Option<&SnapshotInfo>,
) -> Result<(), String> {
    let staged_metadata = staging_dir.join("project-metadata.json");
    let current = project_root.join("project-metadata.json");
    match (
        manifest.and_then(|info| info.metadata_included),
        staged_metadata.exists(),
    ) {
        (Some(true), false) => {
            return Err("Snapshot manifest says metadata exists, but it is missing".to_string())
        }
        (_, true) => {
            fs::copy(&staged_metadata, &current)
                .map_err(|e| format!("Failed to restore project metadata: {e}"))?;
        }
        (Some(false), false) => {
            if current.exists() {
                fs::remove_file(&current)
                    .map_err(|e| format!("Failed to remove project metadata: {e}"))?;
            }
        }
        (None, false) => {}
    }
    Ok(())
}

struct MetadataBackup {
    path: PathBuf,
    had_metadata: bool,
}

fn backup_current_metadata(
    project_root: &Path,
    staging_dir: &Path,
    manifest: Option<&SnapshotInfo>,
) -> Result<Option<MetadataBackup>, String> {
    let should_touch = staging_dir.join("project-metadata.json").exists()
        || manifest.and_then(|info| info.metadata_included).is_some();
    if !should_touch {
        return Ok(None);
    }

    let current = project_root.join("project-metadata.json");
    let backup = editor_dir(project_root).join(format!("restore-backup-metadata-{}", now_millis()));
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|e| format!("Failed to clear metadata restore backup: {e}"))?;
    }
    if current.exists() {
        fs::copy(&current, &backup)
            .map_err(|e| format!("Failed to backup project metadata: {e}"))?;
    }
    Ok(Some(MetadataBackup {
        path: backup,
        had_metadata: current.exists(),
    }))
}

fn rollback_metadata_backup(project_root: &Path, backup: Option<&MetadataBackup>) {
    let Some(backup) = backup else {
        return;
    };
    let current = project_root.join("project-metadata.json");
    if current.exists() {
        let _ = fs::remove_file(&current);
    }
    if backup.had_metadata && backup.path.exists() {
        let _ = fs::copy(&backup.path, &current);
    }
    if backup.path.exists() {
        let _ = fs::remove_file(&backup.path);
    }
}

fn cleanup_metadata_backup(backup: Option<MetadataBackup>) -> Result<(), String> {
    if let Some(backup) = backup {
        if backup.path.exists() {
            fs::remove_file(&backup.path)
                .map_err(|e| format!("Failed to remove metadata restore backup: {e}"))?;
        }
    }
    Ok(())
}

struct StoryPlanBackup {
    directory: PathBuf,
    had_primary: bool,
    had_legacy_backup: bool,
}

fn backup_current_story_plan(
    project_root: &Path,
    staging_dir: &Path,
    manifest: Option<&SnapshotInfo>,
) -> Result<Option<StoryPlanBackup>, String> {
    let should_touch = staging_dir.join(".ollaic").join("plan.json").exists()
        || manifest.and_then(|info| info.story_plan_included).is_some();
    if !should_touch {
        return Ok(None);
    }

    let current = crate::story_plan::plan_path(project_root);
    let current_backup = crate::json_store::backup_path(&current);
    let backup_dir = editor_dir(project_root).join(format!("restore-backup-plan-{}", now_millis()));
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed to create StoryPlan restore backup: {e}"))?;

    let had_primary = current.exists();
    let had_legacy_backup = current_backup.exists();
    if had_primary {
        if let Err(e) = fs::rename(&current, backup_dir.join("plan.json")) {
            let _ = fs::remove_dir_all(&backup_dir);
            return Err(format!("Failed to backup current StoryPlan: {e}"));
        }
    }
    if had_legacy_backup {
        if let Err(e) = fs::rename(&current_backup, backup_dir.join("plan.json.bak")) {
            if had_primary {
                let _ = fs::rename(backup_dir.join("plan.json"), &current);
            }
            let _ = fs::remove_dir_all(&backup_dir);
            return Err(format!("Failed to backup current StoryPlan fallback: {e}"));
        }
    }

    Ok(Some(StoryPlanBackup {
        directory: backup_dir,
        had_primary,
        had_legacy_backup,
    }))
}

fn restore_staged_story_plan(
    project_root: &Path,
    staging_dir: &Path,
    manifest: Option<&SnapshotInfo>,
) -> Result<(), String> {
    let staged = staging_dir.join(".ollaic").join("plan.json");
    if !staged.exists() {
        if manifest.and_then(|info| info.story_plan_included) == Some(true) {
            return Err("Snapshot manifest says StoryPlan exists, but it is missing".to_string());
        }
        return Ok(());
    }

    let current = crate::story_plan::plan_path(project_root);
    fs::create_dir_all(current.parent().expect("StoryPlan has a parent"))
        .map_err(|e| format!("Failed to create StoryPlan directory: {e}"))?;
    fs::rename(&staged, &current).map_err(|e| format!("Failed to activate restored StoryPlan: {e}"))
}

fn rollback_story_plan_backup(project_root: &Path, backup: Option<&StoryPlanBackup>) {
    let Some(backup) = backup else {
        return;
    };
    let current = crate::story_plan::plan_path(project_root);
    let current_backup = crate::json_store::backup_path(&current);
    if current.exists() {
        let _ = fs::remove_file(&current);
    }
    if current_backup.exists() {
        let _ = fs::remove_file(&current_backup);
    }
    if backup.had_primary {
        let _ = fs::rename(backup.directory.join("plan.json"), &current);
    }
    if backup.had_legacy_backup {
        let _ = fs::rename(backup.directory.join("plan.json.bak"), &current_backup);
    }
    if backup.directory.exists() {
        let _ = fs::remove_dir_all(&backup.directory);
    }
}

fn cleanup_story_plan_backup(backup: Option<StoryPlanBackup>) -> Result<(), String> {
    if let Some(backup) = backup {
        if backup.directory.exists() {
            fs::remove_dir_all(&backup.directory)
                .map_err(|e| format!("Failed to remove StoryPlan restore backup: {e}"))?;
        }
    }
    Ok(())
}

fn restore_staged_editor_state(
    project_root: &Path,
    staging_dir: &Path,
    manifest: Option<&SnapshotInfo>,
) -> Result<(), String> {
    let staged_editor = staging_dir.join(".webgal-editor");
    let should_replace =
        staged_editor.is_dir() || manifest.and_then(|info| info.metadata_included).is_some();
    if !should_replace {
        return Ok(());
    }

    let editor = editor_dir(project_root);
    fs::create_dir_all(&editor)
        .map_err(|e| format!("Failed to create editor state directory: {e}"))?;
    let backup_dir = editor.join(format!("restore-backup-editor-{}", now_millis()));
    move_current_editor_state_to_backup(&editor, &backup_dir)?;

    let copy_result = if staged_editor.is_dir() {
        copy_dir_recursive(&staged_editor, &editor)
    } else {
        Ok(())
    };
    if let Err(e) = copy_result {
        let _ = rollback_editor_state(&editor, &backup_dir);
        return Err(e);
    }

    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    Ok(())
}

fn move_current_editor_state_to_backup(editor: &Path, backup_dir: &Path) -> Result<(), String> {
    if backup_dir.exists() {
        fs::remove_dir_all(backup_dir)
            .map_err(|e| format!("Failed to clear editor state restore backup: {e}"))?;
    }
    fs::create_dir_all(backup_dir)
        .map_err(|e| format!("Failed to create editor state restore backup: {e}"))?;

    for entry in fs::read_dir(editor)
        .map_err(|e| format!("Failed to read editor state {}: {e}", editor.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if should_skip_editor_state_entry(&name.to_string_lossy()) {
            continue;
        }
        fs::rename(entry.path(), backup_dir.join(&name)).map_err(|e| {
            format!(
                "Failed to move editor state {} to restore backup: {e}",
                name.to_string_lossy()
            )
        })?;
    }
    Ok(())
}

fn rollback_editor_state(editor: &Path, backup_dir: &Path) -> Result<(), String> {
    if editor.is_dir() {
        for entry in fs::read_dir(editor)
            .map_err(|e| format!("Failed to read editor state {}: {e}", editor.display()))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            if should_skip_editor_state_entry(&name.to_string_lossy()) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|e| format!("Failed to remove restored editor state: {e}"))?;
            } else {
                fs::remove_file(&path)
                    .map_err(|e| format!("Failed to remove restored editor state: {e}"))?;
            }
        }
    }

    if backup_dir.is_dir() {
        for entry in fs::read_dir(backup_dir).map_err(|e| {
            format!(
                "Failed to read editor state restore backup {}: {e}",
                backup_dir.display()
            )
        })? {
            let entry = entry.map_err(|e| e.to_string())?;
            fs::rename(entry.path(), editor.join(entry.file_name()))
                .map_err(|e| format!("Failed to restore editor state backup: {e}"))?;
        }
        fs::remove_dir_all(backup_dir)
            .map_err(|e| format!("Failed to remove editor state restore backup: {e}"))?;
    }
    Ok(())
}

fn rollback_game_restore(game_dir: &Path, game_backup: &Path) {
    if game_dir.exists() {
        let _ = fs::remove_dir_all(game_dir);
    }
    if game_backup.exists() {
        let _ = fs::rename(game_backup, game_dir);
    }
}

fn read_snapshot_manifest(snapshot_dir: &Path) -> Result<Option<SnapshotInfo>, String> {
    let path = snapshot_dir.join("snapshot.json");
    if !path.exists() {
        return Ok(None);
    }
    let text =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str::<SnapshotInfo>(&text)
        .map(Some)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn validate_snapshot_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id == "."
        || id == ".."
        || id.contains("..")
    {
        return Err("Invalid snapshot id".to_string());
    }
    Ok(())
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn export_zip_name(project_path: &str, metadata: Option<&ProjectMetadata>) -> String {
    let name = PathBuf::from(project_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("webgal-project")
        .to_string();
    let version = metadata
        .map(|m| m.version.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("export");
    let clean = |value: &str| {
        value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                    ch
                } else {
                    '_'
                }
            })
            .collect::<String>()
    };
    format!("{}-{}.zip", clean(&name), clean(version))
}

fn write_export_zip(
    game_dir: &Path,
    metadata: Option<&ProjectMetadata>,
    zip_path: &Path,
) -> Result<(), String> {
    let file = fs::File::create(zip_path)
        .map_err(|e| format!("Failed to create zip {}: {e}", zip_path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    add_dir_to_zip(&mut zip, game_dir, Path::new("game"), options)?;
    if let Some(metadata) = metadata {
        let text = serde_json::to_vec_pretty(metadata).map_err(|e| e.to_string())?;
        zip.start_file("project-metadata.json", options)
            .map_err(|e| format!("Failed to add metadata to zip: {e}"))?;
        zip.write_all(&text)
            .map_err(|e| format!("Failed to write metadata to zip: {e}"))?;
    }
    zip.finish()
        .map(|_| ())
        .map_err(|e| format!("Failed to finish zip: {e}"))
}

fn add_dir_to_zip<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    src: &Path,
    zip_base: &Path,
    options: SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = zip_base.join(entry.file_name());
        let name = name.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zip.add_directory(format!("{name}/"), options)
                .map_err(|e| format!("Failed to add zip directory {name}: {e}"))?;
            add_dir_to_zip(zip, &path, Path::new(&name), options)?;
        } else {
            zip.start_file(&name, options)
                .map_err(|e| format!("Failed to add zip file {name}: {e}"))?;
            let mut file = fs::File::open(&path)
                .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            zip.write_all(&buffer)
                .map_err(|e| format!("Failed to write zip file {name}: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::story_plan::{ChapterPlan, StoryPlan};
    use std::fs;

    fn save_test_plan(project: &Path, prompt: &str) {
        crate::story_plan::save_plan(project, &StoryPlan::new(prompt)).unwrap();
    }

    fn load_test_plan(project: &Path) -> StoryPlan {
        crate::story_plan::load_plan(project).unwrap().unwrap()
    }

    #[test]
    fn project_memory_read_restores_a_missing_primary_from_backup() {
        let tmp =
            std::env::temp_dir().join(format!("ollaic_memory_backup_read_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game")).unwrap();
        let path = tmp.join("game/ai-memory.json");
        fs::write(
            crate::json_store::backup_path(&path),
            r#"{"worldSetting":"old","writingStyle":"style","userPreferences":"prefs","updatedAt":"then"}"#,
        )
        .unwrap();

        let memory = read_project_memory(tmp.to_string_lossy().into_owned())
            .unwrap()
            .unwrap();
        assert_eq!(memory.world_setting, "old");
        assert!(path.exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn default_config_enables_appreciation_gallery() {
        let config = default_project_config("Gallery Test");
        assert_eq!(
            config.get("Game_name").map(String::as_str),
            Some("Gallery Test")
        );
        assert_eq!(
            config.get("Enable_Appreciation").map(String::as_str),
            Some("true")
        );

        let serialized = serialize_config(&config);
        assert!(serialized.contains("Enable_Appreciation:true;"));
    }

    #[test]
    fn existing_config_gets_appreciation_default_once() {
        let mut config = parse_config("Game_name:Old Project;\nTitle_bgm:;\n");
        assert!(ensure_appreciation_enabled(&mut config));
        assert_eq!(
            config.get("Enable_Appreciation").map(String::as_str),
            Some("true")
        );
        assert!(!ensure_appreciation_enabled(&mut config));
    }

    #[test]
    fn export_copies_game_directory() {
        // Setup: create a temp project with game/ structure
        let tmp = std::env::temp_dir().join("webgal_test_export_copy");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::create_dir_all(tmp.join("game").join("bgm")).unwrap();
        fs::create_dir_all(tmp.join("game").join("figure")).unwrap();
        fs::create_dir_all(tmp.join("game").join("vocal")).unwrap();

        // Write some content
        fs::write(tmp.join("game").join("config.txt"), "Game_name:Test;").unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            "dialogue:Hello;",
        )
        .unwrap();
        fs::write(
            tmp.join("game").join("background").join("bg.webp"),
            "fake-image",
        )
        .unwrap();
        fs::write(tmp.join("game").join("bgm").join("music.mp3"), "fake-audio").unwrap();
        fs::write(
            tmp.join("game").join("vocal").join("click.wav"),
            "fake-vocal",
        )
        .unwrap();

        let out = tmp.join("exported");

        // Call export_project
        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            None,
        )
        .unwrap();

        assert!(result.success);
        assert!(!has_export_errors(&result.issues));

        // Verify files were copied
        assert!(out.join("game").join("config.txt").exists());
        assert!(out.join("game").join("scene").join("start.txt").exists());
        assert!(out.join("game").join("background").join("bg.webp").exists());
        assert!(out.join("game").join("bgm").join("music.mp3").exists());
        assert!(out.join("game").join("vocal").join("click.wav").exists());

        // Verify content preserved
        assert_eq!(
            fs::read_to_string(out.join("game").join("scene").join("start.txt")).unwrap(),
            "dialogue:Hello;"
        );

        // Cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_warns_missing_assets() {
        // Setup: project with scenes referencing both existing and missing assets
        let tmp = std::env::temp_dir().join("webgal_test_export_missing");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::create_dir_all(tmp.join("game").join("bgm")).unwrap();
        fs::create_dir_all(tmp.join("game").join("figure")).unwrap();
        fs::create_dir_all(tmp.join("game").join("vocal")).unwrap();

        // Only bg.webp exists; peaceful.mp3 and missing_figure.webp are referenced but missing
        fs::write(tmp.join("game").join("background").join("bg.webp"), "img").unwrap();
        fs::write(tmp.join("game").join("config.txt"), "Game_name:Test;").unwrap();

        // Scene referencing existing and missing assets
        let scene = concat!(
            "changeBg:bg.webp;\n",
            "changeFigure:missing_figure.webp -left;\n",
            "bgm:peaceful.mp3;\n",
            "playEffect:click.wav;\n",
            "playVideo:intro.mp4;\n",
        );
        fs::write(tmp.join("game").join("scene").join("start.txt"), scene).unwrap();

        let out = tmp.join("exported");

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            None,
        )
        .unwrap();

        assert!(result.success);
        assert!(!has_export_errors(&result.issues));

        // Should warn about missing_figure.webp and peaceful.mp3 and click.wav
        assert!(
            result.warnings.len() >= 2,
            "expected at least 2 warnings, got {}: {:?}",
            result.warnings.len(),
            result.warnings
        );

        let has_missing_figure = result
            .warnings
            .iter()
            .any(|w| w.contains("missing_figure.webp"));
        let has_missing_bgm = result.warnings.iter().any(|w| w.contains("peaceful.mp3"));
        let has_missing_video = result.warnings.iter().any(|w| w.contains("intro.mp4"));
        assert!(
            has_missing_figure,
            "missing_figure.webp should trigger a warning"
        );
        assert!(has_missing_bgm, "peaceful.mp3 should trigger a warning");
        assert!(has_missing_video, "intro.mp4 should trigger a warning");

        // Should NOT warn about existing asset
        let has_bg = result.warnings.iter().any(|w| w.contains("bg.webp"));
        assert!(!has_bg, "bg.webp exists, should not warn");

        // Cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_writes_metadata_and_zip_when_requested() {
        let tmp = std::env::temp_dir().join("webgal_test_export_metadata_zip");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("config.txt"), "Game_name:ZipTest;").unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Hello;").unwrap();
        let out = tmp.join("exported");
        let metadata = ProjectMetadata {
            description: "Export description".to_string(),
            cover_path: "game/background/cover.webp".to_string(),
            version: "1.2.3".to_string(),
            tags: vec!["demo".to_string()],
            ..ProjectMetadata::default()
        };
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::write(
            tmp.join("game").join("background").join("cover.webp"),
            "cover",
        )
        .unwrap();

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            true,
            Some(metadata),
        )
        .unwrap();

        assert!(result.success);
        assert!(!has_export_errors(&result.issues));
        let zip_path = PathBuf::from(result.output_path);
        assert!(zip_path.exists());
        assert!(tmp.join("project-metadata.json").exists());

        let file = fs::File::open(zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.by_name("game/scene/start.txt").is_ok());
        let mut metadata_file = archive.by_name("project-metadata.json").unwrap();
        let mut metadata_text = String::new();
        metadata_file.read_to_string(&mut metadata_text).unwrap();
        assert!(metadata_text.contains("Export description"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_validation_blocks_missing_required_files() {
        let tmp = std::env::temp_dir().join("webgal_test_export_validation_blocks");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        let out = tmp.join("exported");

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            None,
        )
        .unwrap();

        assert!(!result.success);
        assert!(!out.join("game").exists());
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.level == ExportValidationLevel::Error
                && issue.code == "missing_config"));
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.level == ExportValidationLevel::Error
                && issue.code == "missing_scene"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn directory_export_validation_confirms_required_outputs() {
        let tmp = std::env::temp_dir().join("webgal_test_export_directory_validation");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::write(tmp.join("game").join("config.txt"), "Game_name:DirTest;").unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Hello;").unwrap();
        fs::write(
            tmp.join("game").join("background").join("cover.webp"),
            "cover",
        )
        .unwrap();
        let out = tmp.join("exported");
        let metadata = ProjectMetadata {
            cover_path: "game/background/cover.webp".to_string(),
            version: "2.0.0".to_string(),
            ..ProjectMetadata::default()
        };

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            Some(metadata),
        )
        .unwrap();

        assert!(result.success);
        assert!(out.join("game").join("config.txt").is_file());
        assert!(out.join("game").join("scene").join("start.txt").is_file());
        assert!(out.join("project-metadata.json").is_file());
        assert!(!result
            .issues
            .iter()
            .any(|issue| issue.code.starts_with("export_missing")));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn project_metadata_roundtrips() {
        let tmp = std::env::temp_dir().join("webgal_test_metadata_roundtrip");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let metadata = ProjectMetadata {
            synopsis: "Story synopsis".to_string(),
            description: "Description".to_string(),
            cover_path: "game/background/cover.webp".to_string(),
            tags: vec!["demo".to_string(), "branching".to_string()],
            version: "3.1.4".to_string(),
            release_notes: "Notes".to_string(),
            last_export_dir: "/tmp/export".to_string(),
        };

        save_project_metadata(tmp.to_string_lossy().to_string(), metadata.clone()).unwrap();
        let loaded = read_project_metadata(tmp.to_string_lossy().to_string())
            .unwrap()
            .unwrap();

        assert_eq!(loaded.synopsis, metadata.synopsis);
        assert_eq!(loaded.cover_path, metadata.cover_path);
        assert_eq!(loaded.tags, metadata.tags);
        assert_eq!(loaded.version, metadata.version);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshots_can_restore_previous_game_state() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_restore");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("before".to_string()),
            None,
            None,
        )
        .unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":After;").unwrap();

        let snapshots = list_project_snapshots(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(snapshots.len(), 1);
        restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap();

        let restored =
            fs::read_to_string(tmp.join("game").join("scene").join("start.txt")).unwrap();
        assert_eq!(restored, ":Before;");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshots_restore_previous_story_plan() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_restore_story_plan");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();
        save_test_plan(&tmp, "before");

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("before-plan-change".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();
        save_test_plan(&tmp, "after");

        restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap();

        assert_eq!(load_test_plan(&tmp).prompt, "before");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshot_creation_uses_a_valid_story_plan_backup_when_primary_is_corrupt() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_story_plan_backup");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();
        let plan_path = crate::story_plan::plan_path(&tmp);
        fs::create_dir_all(plan_path.parent().unwrap()).unwrap();
        fs::write(&plan_path, "{not valid json").unwrap();
        fs::write(
            crate::json_store::backup_path(&plan_path),
            serde_json::to_vec_pretty(&StoryPlan::new("valid backup")).unwrap(),
        )
        .unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("recovered-plan".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();

        let snapshotted = crate::story_plan::load_plan(Path::new(&snapshot.path))
            .unwrap()
            .unwrap();
        assert_eq!(snapshotted.prompt, "valid backup");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn legacy_snapshot_manifest_restores_an_embedded_story_plan() {
        let tmp = std::env::temp_dir().join("webgal_test_legacy_snapshot_story_plan");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            ":Snapshot;",
        )
        .unwrap();
        save_test_plan(&tmp, "legacy snapshot plan");
        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("legacy-manifest".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();
        let manifest_path = PathBuf::from(&snapshot.path).join("snapshot.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest
            .as_object_mut()
            .unwrap()
            .remove("storyPlanIncluded");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        save_test_plan(&tmp, "current plan");

        restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap();

        assert_eq!(load_test_plan(&tmp).prompt, "legacy snapshot plan");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshot_restore_persists_the_migrated_story_plan() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_story_plan_migration");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            ":Snapshot;",
        )
        .unwrap();
        let mut plan = StoryPlan::new("legacy plan");
        plan.synopsis = "A synopsis used by the legacy summary migration.".to_string();
        plan.chapters.push(ChapterPlan {
            id: "chapter-1".to_string(),
            title: "Opening".to_string(),
            summary: "Original summary".to_string(),
        });
        crate::story_plan::save_plan(&tmp, &plan).unwrap();
        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("legacy-plan".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();
        let snapshot_plan_path = PathBuf::from(&snapshot.path).join(".ollaic/plan.json");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(&snapshot_plan_path).unwrap()).unwrap();
        legacy["chapters"][0]["summary"] = serde_json::Value::String(String::new());
        fs::write(
            &snapshot_plan_path,
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        save_test_plan(&tmp, "current plan");

        restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap();

        let restored_json: serde_json::Value =
            serde_json::from_slice(&fs::read(crate::story_plan::plan_path(&tmp)).unwrap()).unwrap();
        assert!(!restored_json["chapters"][0]["summary"]
            .as_str()
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn active_flow_story_plan_scope_rejects_public_snapshot_restore() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_restore_flow_guard");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            ":Snapshot;",
        )
        .unwrap();
        save_test_plan(&tmp, "snapshot plan");
        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("guarded-plan".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            ":Current;",
        )
        .unwrap();
        save_test_plan(&tmp, "current plan");
        let guard = crate::flow_edit_lock::FlowEditGuard::acquire(
            &tmp,
            &[crate::flow_edit_lock::FlowResource::StoryPlan],
        )
        .unwrap();

        let error =
            restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap_err();

        assert!(error.contains("故事计划"));
        assert_eq!(
            fs::read_to_string(tmp.join("game").join("scene").join("start.txt")).unwrap(),
            ":Current;"
        );
        assert_eq!(load_test_plan(&tmp).prompt, "current plan");
        drop(guard);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshots_restore_the_absence_of_a_story_plan() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_restore_no_story_plan");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("before-plan-exists".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();
        fs::create_dir_all(tmp.join(".ollaic")).unwrap();
        fs::write(
            tmp.join(".ollaic").join("plan.json"),
            r#"{"version":"new"}"#,
        )
        .unwrap();

        restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap();

        assert!(!tmp.join(".ollaic").join("plan.json").exists());
        assert!(!tmp.join(".ollaic").join("plan.json.bak").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_snapshot_story_plan_does_not_partially_restore_project() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_missing_story_plan_is_safe");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();
        save_test_plan(&tmp, "before");

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("complete-state".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();
        fs::remove_file(
            PathBuf::from(&snapshot.path)
                .join(".ollaic")
                .join("plan.json"),
        )
        .unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":After;").unwrap();
        save_test_plan(&tmp, "after");

        let result = restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id);

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(tmp.join("game").join("scene").join("start.txt")).unwrap(),
            ":After;"
        );
        assert_eq!(load_test_plan(&tmp).prompt, "after");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn corrupt_snapshot_story_plan_does_not_partially_restore_project() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_corrupt_story_plan_is_safe");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            ":Snapshot;",
        )
        .unwrap();
        save_test_plan(&tmp, "snapshot plan");
        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("corrupt-plan".to_string()),
            Some("auto".to_string()),
            None,
        )
        .unwrap();
        fs::write(
            PathBuf::from(&snapshot.path)
                .join(".ollaic")
                .join("plan.json"),
            "{not valid json",
        )
        .unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            ":Current;",
        )
        .unwrap();
        save_test_plan(&tmp, "current plan");

        let result = restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id);

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(tmp.join("game").join("scene").join("start.txt")).unwrap(),
            ":Current;"
        );
        assert_eq!(load_test_plan(&tmp).prompt, "current plan");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshots_restore_metadata_and_editor_state() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_restore_metadata");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join(".webgal-editor")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();
        fs::write(
            tmp.join("project-metadata.json"),
            r#"{"synopsis":"before","description":"","coverPath":"","tags":[],"version":"1.0.0","releaseNotes":"","lastExportDir":""}"#,
        )
        .unwrap();
        fs::write(
            tmp.join(".webgal-editor").join("project-structure.json"),
            r#"{"schemaVersion":1,"status":"before"}"#,
        )
        .unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("full-state".to_string()),
            Some("exportCandidate".to_string()),
            Some("Ready for export".to_string()),
        )
        .unwrap();

        assert!(snapshot.includes_editor_state);
        assert_eq!(snapshot.kind, "exportCandidate");
        assert_eq!(snapshot.description.as_deref(), Some("Ready for export"));
        assert_eq!(snapshot.metadata_included, Some(true));
        assert!(snapshot.file_count.unwrap_or_default() >= 3);
        assert!(PathBuf::from(&snapshot.path)
            .join(".webgal-editor")
            .join("project-structure.json")
            .is_file());

        fs::write(tmp.join("game").join("scene").join("start.txt"), ":After;").unwrap();
        fs::write(
            tmp.join("project-metadata.json"),
            r#"{"synopsis":"after","description":"","coverPath":"","tags":[],"version":"2.0.0","releaseNotes":"","lastExportDir":""}"#,
        )
        .unwrap();
        fs::write(
            tmp.join(".webgal-editor").join("project-structure.json"),
            r#"{"schemaVersion":1,"status":"after"}"#,
        )
        .unwrap();
        fs::write(
            tmp.join(".webgal-editor").join("stale-cache.json"),
            r#"{"status":"stale"}"#,
        )
        .unwrap();

        restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap();

        assert_eq!(
            fs::read_to_string(tmp.join("game").join("scene").join("start.txt")).unwrap(),
            ":Before;"
        );
        assert!(fs::read_to_string(tmp.join("project-metadata.json"))
            .unwrap()
            .contains(r#""version":"1.0.0""#));
        assert!(
            fs::read_to_string(tmp.join(".webgal-editor").join("project-structure.json"))
                .unwrap()
                .contains(r#""status":"before""#)
        );
        assert!(!tmp.join(".webgal-editor").join("stale-cache.json").exists());
        assert!(tmp.join(".webgal-editor").join("snapshots").is_dir());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshot_manifest_separates_metadata_and_editor_state() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_manifest_state_flags");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();
        fs::write(
            tmp.join("project-metadata.json"),
            r#"{"synopsis":"before","description":"","coverPath":"","tags":[],"version":"1.0.0","releaseNotes":"","lastExportDir":""}"#,
        )
        .unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("metadata-only".to_string()),
            None,
            None,
        )
        .unwrap();

        assert!(!snapshot.includes_editor_state);
        assert_eq!(snapshot.metadata_included, Some(true));
        assert!(!PathBuf::from(&snapshot.path)
            .join(".webgal-editor")
            .exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshot_restore_failure_does_not_change_game_state() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_restore_failure_is_safe");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();
        fs::write(
            tmp.join("project-metadata.json"),
            r#"{"synopsis":"before","description":"","coverPath":"","tags":[],"version":"1.0.0","releaseNotes":"","lastExportDir":""}"#,
        )
        .unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("broken-metadata".to_string()),
            None,
            None,
        )
        .unwrap();
        fs::remove_file(PathBuf::from(&snapshot.path).join("project-metadata.json")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":After;").unwrap();

        let result = restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id);

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(tmp.join("game").join("scene").join("start.txt")).unwrap(),
            ":After;"
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshots_can_be_renamed_and_deleted() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_manage");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Hello;").unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("initial".to_string()),
            None,
            None,
        )
        .unwrap();

        let renamed = rename_project_snapshot(
            tmp.to_string_lossy().to_string(),
            snapshot.id.clone(),
            "候选 版本".to_string(),
        )
        .unwrap();
        assert_eq!(renamed.label, "候选 版本");

        let listed = list_project_snapshots(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "候选 版本");

        delete_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id.clone()).unwrap();
        assert!(list_project_snapshots(tmp.to_string_lossy().to_string())
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }
}
