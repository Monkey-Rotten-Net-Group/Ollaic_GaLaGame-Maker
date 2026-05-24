use super::parser;
use super::serializer;
use super::types::WebGalNode;
use std::fs;
use std::path::PathBuf;

/// Parse a WebGAL script string into structured nodes.
#[tauri::command]
pub fn parse_scene(source: String) -> Result<Vec<WebGalNode>, String> {
    Ok(parser::parse_script(&source))
}

/// Serialize structured nodes back to a WebGAL script string.
#[tauri::command]
pub fn serialize_scene(nodes: Vec<WebGalNode>) -> Result<String, String> {
    Ok(serializer::serialize_script(&nodes))
}

/// Read a .txt scene file from disk, parse it, and return nodes.
#[tauri::command]
pub fn load_scene(path: String) -> Result<Vec<WebGalNode>, String> {
    let path = PathBuf::from(&path);
    let source = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    Ok(parser::parse_script(&source))
}

/// Serialize nodes and write to a .txt scene file on disk.
#[tauri::command]
pub fn save_scene(path: String, nodes: Vec<WebGalNode>) -> Result<(), String> {
    let text = serializer::serialize_script(&nodes);
    let path = PathBuf::from(&path);

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&path, text).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

/// Read the raw text content of any file (used to extract scene header comments).
#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

/// Write raw text content to a file (used to persist scene header comment edits).
#[tauri::command]
pub fn write_file_text(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&path, content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// List all .txt scene files in a directory.
#[tauri::command]
pub fn list_scenes(dir: String) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(&dir);
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }

    let mut scenes = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read entry error: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("txt") {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                scenes.push(name.to_string());
            }
        }
    }

    scenes.sort();
    Ok(scenes)
}
