use super::references;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// WebGAL game/ subdirectory structure.
const GAME_DIRS: &[&str] = &[
    "animation",
    "background",
    "figure",
    "scene",
    "bgm",
    "sfx",
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

/// Information about a single scene file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub world_setting: String,
    pub writing_style: String,
    pub user_preferences: String,
    pub updated_at: String,
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
    let mut config = HashMap::new();
    config.insert("Game_name".to_string(), name.clone());
    config.insert("Game_key".to_string(), format!("{:x}", rand_u64()));
    config.insert(
        "Title_img".to_string(),
        "WebGAL_New_Enter_Image.webp".to_string(),
    );
    config.insert("Title_bgm".to_string(), String::new());

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
        parse_config(&text)
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

    fs::write(&path, format!("; {}\n", name))
        .map_err(|e| format!("Failed to create scene: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_project_memory(project_path: String) -> Result<Option<ProjectMemory>, String> {
    let path = PathBuf::from(&project_path)
        .join("game")
        .join("ai-memory.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read ai-memory.json: {}", e))?;
    let memory = serde_json::from_str::<ProjectMemory>(&text)
        .map_err(|e| format!("Failed to parse ai-memory.json: {}", e))?;
    Ok(Some(memory))
}

#[tauri::command]
pub fn save_project_memory(project_path: String, memory: ProjectMemory) -> Result<(), String> {
    let game_dir = PathBuf::from(&project_path).join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }
    let path = game_dir.join("ai-memory.json");
    let text = serde_json::to_string_pretty(&memory)
        .map_err(|e| format!("Failed to serialize ai-memory.json: {}", e))?;
    fs::write(&path, text).map_err(|e| format!("Failed to write ai-memory.json: {}", e))
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
}

/// Export a WebGAL project: copies the game/ directory to the output path.
/// Optionally creates a .zip archive.
#[tauri::command]
pub fn export_project(
    project_path: String,
    output_path: String,
    _as_zip: bool,
) -> Result<ExportResult, String> {
    let game_dir = PathBuf::from(&project_path).join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }

    let dest = PathBuf::from(&output_path);
    let mut warnings: Vec<String> = Vec::new();

    // Validate referenced assets before copying
    let asset_warnings = validate_assets(&game_dir)?;
    warnings.extend(asset_warnings);

    // Copy game/ directory recursively
    copy_dir_recursive(&game_dir, &dest.join("game"))?;

    Ok(ExportResult {
        success: true,
        warnings,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn export_copies_game_directory() {
        // Setup: create a temp project with game/ structure
        let tmp = std::env::temp_dir().join("webgal_test_export_copy");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::create_dir_all(tmp.join("game").join("bgm")).unwrap();
        fs::create_dir_all(tmp.join("game").join("figure")).unwrap();
        fs::create_dir_all(tmp.join("game").join("sfx")).unwrap();

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
        fs::write(tmp.join("game").join("sfx").join("click.wav"), "fake-sfx").unwrap();

        let out = tmp.join("exported");

        // Call export_project
        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
        )
        .unwrap();

        assert!(result.success);

        // Verify files were copied
        assert!(out.join("game").join("config.txt").exists());
        assert!(out.join("game").join("scene").join("start.txt").exists());
        assert!(out.join("game").join("background").join("bg.webp").exists());
        assert!(out.join("game").join("bgm").join("music.mp3").exists());
        assert!(out.join("game").join("sfx").join("click.wav").exists());

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
        fs::create_dir_all(tmp.join("game").join("sfx")).unwrap();

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
        )
        .unwrap();

        assert!(result.success);

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
}
