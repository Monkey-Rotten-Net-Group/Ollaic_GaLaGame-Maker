use super::parser;
use super::project_paths::ProjectPaths;
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
pub fn load_scene(project_path: String, scene_name: String) -> Result<Vec<WebGalNode>, String> {
    let path = ProjectPaths::open(project_path)?.existing_scene(&scene_name)?;
    let source = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    Ok(parser::parse_script(&source))
}

/// Serialize nodes and write to a .txt scene file on disk.
#[tauri::command]
pub fn save_scene(
    project_path: String,
    scene_name: String,
    nodes: Vec<WebGalNode>,
) -> Result<(), String> {
    let text = serializer::serialize_script(&nodes);
    let paths = ProjectPaths::open(project_path)?;
    let _guard = paths.lock_for_write();
    let path = paths.existing_scene(&scene_name)?;

    crate::json_store::write_crash_safe(&path, text.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

/// Read the raw text content of any file (used to extract scene header comments).
#[tauri::command]
pub fn read_file_text(project_path: String, scene_name: String) -> Result<String, String> {
    let path = ProjectPaths::open(project_path)?.existing_scene(&scene_name)?;
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

/// Write raw text content to a file (used to persist scene header comment edits).
#[tauri::command]
pub fn write_file_text(
    project_path: String,
    scene_name: String,
    content: String,
) -> Result<(), String> {
    let paths = ProjectPaths::open(project_path)?;
    let _guard = paths.lock_for_write();
    let path = paths.existing_scene(&scene_name)?;
    crate::json_store::write_crash_safe(&path, content.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// List all project-owned .txt scene files.
#[tauri::command]
pub fn list_scenes(project_path: String) -> Result<Vec<String>, String> {
    ProjectPaths::open(project_path)?.list_scenes()
}

/// Delete a scene file.
#[tauri::command]
pub fn delete_scene(project_path: String, scene_name: String) -> Result<(), String> {
    let paths = ProjectPaths::open(project_path)?;
    let _guard = paths.lock_for_write();
    let path = paths.existing_scene(&scene_name)?;
    fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path.display(), e))
}

/// Rename a scene file.
#[tauri::command]
pub fn rename_scene(
    project_path: String,
    scene_name: String,
    new_name: String,
) -> Result<String, String> {
    let paths = ProjectPaths::open(project_path)?;
    paths
        .rename_scene(&scene_name, &new_name)
        .map(|normalized| normalized.as_str().to_string())
}

/// Write a user-selected standalone scene export. This is intentionally not a
/// project Scene command; the OS save dialog owns authorization for the path.
#[tauri::command]
pub fn export_scene_file(path: String, nodes: Vec<WebGalNode>) -> Result<(), String> {
    let path = PathBuf::from(path);
    let text = serializer::serialize_script(&nodes);
    crate::json_store::write_crash_safe(&path, text.as_bytes())
        .map_err(|error| format!("Failed to export {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ollaic_webgal_commands_{label}_{nonce}"))
    }

    #[test]
    fn write_file_text_round_trips_and_leaves_no_atomic_residue() {
        let project = std::env::temp_dir().join("ollaic_write_text_test");
        let dir = project.join("game/scene");
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("start.txt");
        std::fs::write(&path, "initial").unwrap();
        let project_path = project.to_string_lossy().to_string();

        write_file_text(project_path.clone(), "start.txt".into(), "A:hello;".into()).unwrap();
        assert_eq!(
            read_file_text(project_path.clone(), "start.txt".into()).unwrap(),
            "A:hello;"
        );

        // Overwriting an existing file must not corrupt it.
        write_file_text(project_path.clone(), "start.txt".into(), "B:world;".into()).unwrap();
        assert_eq!(
            read_file_text(project_path, "start.txt".into()).unwrap(),
            "B:world;"
        );

        // The crash-safe writer leaves no .tmp/.bak residue.
        let mut residue: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        residue.sort();
        assert_eq!(residue, vec!["start.txt".to_string()]);

        let _ = std::fs::remove_dir_all(&project);
    }

    #[cfg(unix)]
    #[test]
    fn scene_write_does_not_follow_a_preexisting_temporary_symlink() {
        use std::os::unix::fs::symlink;

        let workspace = temp_project("temporary_symlink");
        let project = workspace.join("project");
        let scene_dir = project.join("game/scene");
        let scene = scene_dir.join("start.txt");
        let outside = workspace.join("outside.txt");
        std::fs::create_dir_all(&scene_dir).unwrap();
        std::fs::write(&scene, "original scene").unwrap();
        std::fs::write(&outside, "outside sentinel").unwrap();
        symlink(&outside, scene_dir.join("start.txt.tmp")).unwrap();

        write_file_text(
            project.to_string_lossy().into_owned(),
            "start.txt".into(),
            "updated scene".into(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "outside sentinel"
        );
        assert_eq!(std::fs::read_to_string(&scene).unwrap(), "updated scene");
        assert!(!std::fs::symlink_metadata(&scene)
            .unwrap()
            .file_type()
            .is_symlink());
        std::fs::remove_dir_all(workspace).unwrap();
    }
}
