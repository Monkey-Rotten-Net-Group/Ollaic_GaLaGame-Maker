use super::parser;
use super::serializer;
use super::types::WebGalNode;
use std::fs;
use std::path::{Path, PathBuf};

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
    let scene_path = PathBuf::from(&path);
    crate::project_lock::with_game_path_lock(&scene_path, || load_scene_locked(&scene_path))
}

fn load_scene_locked(path: &Path) -> Result<Vec<WebGalNode>, String> {
    let source = crate::json_store::read_to_string_recovering(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    Ok(parser::parse_script(&source))
}

/// Serialize nodes and write to a .txt scene file on disk.
#[tauri::command]
pub fn save_scene(path: String, nodes: Vec<WebGalNode>) -> Result<(), String> {
    let scene_path = PathBuf::from(&path);
    crate::project_lock::with_game_path_lock(&scene_path, || save_scene_locked(&scene_path, nodes))
}

fn save_scene_locked(path: &Path, nodes: Vec<WebGalNode>) -> Result<(), String> {
    let text = serializer::serialize_script(&nodes);

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    crate::json_store::write_crash_safe(path, text.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

/// Read the raw text content of any file (used to extract scene header comments).
#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    crate::project_lock::with_game_path_lock(&file_path, || read_file_text_locked(&file_path))
}

fn read_file_text_locked(path: &Path) -> Result<String, String> {
    crate::json_store::read_to_string_recovering(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

/// Write raw text content to a file (used to persist scene header comment edits).
#[tauri::command]
pub fn write_file_text(path: String, content: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    crate::project_lock::with_game_path_lock(&file_path, || {
        write_file_text_locked(&file_path, content)
    })
}

fn write_file_text_locked(path: &Path, content: String) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    crate::json_store::write_crash_safe(path, content.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// List all .txt scene files in a directory.
#[tauri::command]
pub fn list_scenes(dir: String) -> Result<Vec<String>, String> {
    let scene_dir = PathBuf::from(&dir);
    crate::project_lock::with_game_path_lock(&scene_dir, || list_scenes_locked(&scene_dir))
}

fn list_scenes_locked(dir: &Path) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }

    let mut scenes = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

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

/// Delete a scene file.
#[tauri::command]
pub fn delete_scene(path: String) -> Result<(), String> {
    let scene_path = PathBuf::from(&path);
    crate::project_lock::with_game_path_lock(&scene_path, || delete_scene_locked(&scene_path))
}

fn delete_scene_locked(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Scene file not found: {}", path.display()));
    }
    fs::remove_file(path).map_err(|e| format!("Failed to delete {}: {}", path.display(), e))
}

/// Rename a scene file.
#[tauri::command]
pub fn rename_scene(path: String, new_name: String) -> Result<String, String> {
    let scene_path = PathBuf::from(&path);
    crate::project_lock::with_game_path_lock(&scene_path, || {
        rename_scene_locked(&scene_path, new_name)
    })
}

fn rename_scene_locked(path: &Path, new_name: String) -> Result<String, String> {
    if !path.exists() {
        return Err(format!("Scene file not found: {}", path.display()));
    }
    let parent = path.parent().ok_or("Invalid scene path")?;
    let new_path = parent.join(&new_name);
    fs::rename(path, &new_path).map_err(|e| {
        format!(
            "Failed to rename {} -> {}: {}",
            path.display(),
            new_path.display(),
            e
        )
    })?;
    Ok(new_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_file_text_round_trips_and_leaves_no_atomic_residue() {
        let dir = std::env::temp_dir().join("ollaic_write_text_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("start.txt");
        let path_str = path.to_string_lossy().to_string();

        write_file_text(path_str.clone(), "A:hello;".to_string()).unwrap();
        assert_eq!(read_file_text(path_str.clone()).unwrap(), "A:hello;");

        // Overwriting an existing file must not corrupt it.
        write_file_text(path_str.clone(), "B:world;".to_string()).unwrap();
        assert_eq!(read_file_text(path_str.clone()).unwrap(), "B:world;");

        // The crash-safe writer leaves no .tmp/.bak residue.
        let mut residue: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        residue.sort();
        assert_eq!(residue, vec!["start.txt".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scene_read_restores_a_missing_primary_from_backup() {
        let dir =
            std::env::temp_dir().join(format!("ollaic_scene_backup_read_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("start.txt");
        std::fs::write(crate::json_store::backup_path(&path), "A:old;").unwrap();

        assert_eq!(
            read_file_text(path.to_string_lossy().into_owned()).unwrap(),
            "A:old;"
        );
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
