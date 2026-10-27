use crate::{json_store, Error, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

pub const GAME_DIRS: &[&str] = &[
    "animation",
    "background",
    "figure",
    "scene",
    "bgm",
    "vocal",
    "video",
    "tex",
];
pub const MAX_SCRIPT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const EDITOR_STATE: &str = ".ollaic/mobile-editor.json";
const PENDING: &str = ".ollaic/mobile-pending.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub config: HashMap<String, String>,
    pub scenes: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SceneSource {
    pub file_name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceDocument {
    pub scenes: Vec<SceneSource>,
    pub notes: String,
    pub editor_state: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSnapshot {
    pub document: WorkspaceDocument,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct EditorState {
    notes: String,
    editor_state: String,
}

#[derive(Serialize, Deserialize)]
struct PendingWorkspace {
    previous_files: Vec<String>,
    document: WorkspaceDocument,
}

type ProjectLocks = Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>;
static LOCKS: OnceLock<ProjectLocks> = OnceLock::new();

pub fn with_project<T>(root: &Path, operation: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let canonical = root.canonicalize()?;
    let lock = {
        let mut locks = LOCKS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| Error::Invalid("Project lock poisoned".into()))?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        match locks.get(&canonical).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(canonical.clone(), Arc::downgrade(&lock));
                lock
            }
        }
    };
    let _guard = lock
        .lock()
        .map_err(|_| Error::Invalid("Project lock poisoned".into()))?;
    recover_workspace(&canonical)?;
    crate::asset_operations::recover(&canonical)?;
    operation(&canonical)
}

pub fn parse_config(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with(';') {
                return None;
            }
            let (key, value) = line.split_once(':')?;
            Some((
                key.trim().to_owned(),
                value
                    .trim()
                    .strip_suffix(';')
                    .unwrap_or(value.trim())
                    .to_owned(),
            ))
        })
        .collect()
}

pub fn serialize_config(config: &HashMap<String, String>) -> String {
    let mut lines: Vec<_> = config
        .iter()
        .map(|(key, value)| format!("{key}:{value};"))
        .collect();
    lines.sort();
    lines.push(String::new());
    lines.join("\n")
}

pub fn default_project_config(name: &str) -> HashMap<String, String> {
    HashMap::from([
        ("Game_name".into(), name.into()),
        (
            "Game_key".into(),
            format!(
                "{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos() as u64
            ),
        ),
        ("Title_img".into(), "WebGAL_New_Enter_Image.webp".into()),
        ("Title_bgm".into(), String::new()),
        ("Enable_Appreciation".into(), "true".into()),
    ])
}

pub fn ensure_appreciation_enabled(config: &mut HashMap<String, String>) -> bool {
    if config.contains_key("Enable_Appreciation") {
        return false;
    }
    config.insert("Enable_Appreciation".into(), "true".into());
    true
}

pub fn initialize_at(root: &Path, name: &str) -> Result<ProjectInfo> {
    if name.trim().is_empty() || name.contains(['\r', '\n', ';']) {
        return Err(Error::Invalid("Invalid project name".into()));
    }
    for dir in GAME_DIRS {
        fs::create_dir_all(root.join("game").join(dir))?;
    }
    json_store::write_crash_safe(
        &root.join("game/config.txt"),
        serialize_config(&default_project_config(name)).as_bytes(),
    )?;
    json_store::write_crash_safe(
        &root.join("game/scene/start.txt"),
        "; 在这里开始你的故事\n".as_bytes(),
    )?;
    open_project(root)
}

pub fn create_project(root: &Path, name: &str) -> Result<ProjectInfo> {
    if root.exists() {
        return Err(Error::Invalid("Project already exists".into()));
    }
    let parent = root
        .parent()
        .ok_or_else(|| Error::Invalid("Missing project library".into()))?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".create-")
        .tempdir_in(parent)?;
    initialize_at(staging.path(), name)?;
    fs::rename(staging.path(), root)?;
    open_project(root)
}

pub fn open_project(root: &Path) -> Result<ProjectInfo> {
    with_project(root, |root| {
        checked_directory(root, "game")?;
        checked_directory(root, "game/scene")?;
        let config_path = checked_file(root, "game/config.txt")?;
        if fs::metadata(&config_path)?.len() > MAX_METADATA_BYTES {
            return Err(Error::Invalid(
                "Project configuration exceeds the size limit".into(),
            ));
        }
        let mut config = parse_config(&json_store::read_to_string_recovering(&config_path)?);
        if ensure_appreciation_enabled(&mut config) {
            json_store::write_crash_safe(&config_path, serialize_config(&config).as_bytes())?;
        }
        Ok(ProjectInfo {
            path: root.to_string_lossy().into_owned(),
            config,
            scenes: scene_names(root)?,
        })
    })
}

pub fn scene_file_name(name: &str) -> Result<String> {
    let name = name.trim();
    let file = if name.ends_with(".txt") {
        name.to_owned()
    } else {
        format!("{name}.txt")
    };
    validate_file_name(&file)?;
    if file == ".txt" {
        return Err(Error::Invalid("Scene name is empty".into()));
    }
    Ok(file)
}

pub fn validate_file_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0'])
        || name.chars().any(char::is_control)
        || name.ends_with(['.', ' '])
    {
        return Err(Error::Invalid(format!("Invalid file name: {name}")));
    }
    Ok(())
}

fn scene_names(root: &Path) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(checked_directory(root, "game/scene")?)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "txt")
        {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| Error::Invalid("Scene name is not UTF-8".into()))?;
            validate_file_name(&name)?;
            checked_file(root, &format!("game/scene/{name}"))?;
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

pub fn load_workspace(root: &Path) -> Result<WorkspaceSnapshot> {
    with_project(root, load_workspace_unlocked)
}

pub(crate) fn load_workspace_unlocked(root: &Path) -> Result<WorkspaceSnapshot> {
    checked_file(root, "game/config.txt")?;
    let mut script_bytes = 0u64;
    let scenes = scene_names(root)?
        .into_iter()
        .map(|file_name| {
            let path = checked_file(root, &format!("game/scene/{file_name}"))?;
            let size = fs::metadata(&path)?.len();
            script_bytes = script_bytes.saturating_add(size);
            if size > MAX_SCRIPT_BYTES || script_bytes > 128 * 1024 * 1024 {
                return Err(Error::Invalid("Scene exceeds the 32 MiB limit".into()));
            }
            Ok(SceneSource {
                file_name,
                source: json_store::read_to_string_recovering(&path)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let state_path = root.join(EDITOR_STATE);
    let state: EditorState = if state_path.exists() {
        if fs::metadata(&state_path)?.len() > MAX_SCRIPT_BYTES {
            return Err(Error::Invalid("Editor state exceeds the size limit".into()));
        }
        serde_json::from_str(&json_store::read_to_string_recovering(&checked_file(
            root,
            EDITOR_STATE,
        )?)?)?
    } else {
        EditorState::default()
    };
    let document = WorkspaceDocument {
        scenes,
        notes: state.notes,
        editor_state: state.editor_state,
    };
    let revision = revision(&document)?;
    Ok(WorkspaceSnapshot { document, revision })
}

pub fn save_workspace(
    root: &Path,
    document: WorkspaceDocument,
    expected_revision: &str,
) -> Result<String> {
    validate_document(&document)?;
    with_project(root, |root| {
        let current = load_workspace_unlocked(root)?;
        if current.revision != expected_revision {
            return Err(Error::Conflict);
        }
        let pending = PendingWorkspace {
            previous_files: current
                .document
                .scenes
                .into_iter()
                .map(|scene| scene.file_name)
                .collect(),
            document,
        };
        let journal = reserved_file(root, PENDING)?;
        validate_workspace_paths(root, &pending)?;
        let bytes = serde_json::to_vec(&pending)?;
        if bytes.len() as u64 > MAX_SCRIPT_BYTES {
            return Err(Error::Invalid(
                "Workspace transaction exceeds the 32 MiB limit".into(),
            ));
        }
        json_store::write_crash_safe(&journal, &bytes)?;
        apply_workspace(root, &pending)?;
        fs::remove_file(journal)?;
        revision(&pending.document)
    })
}

fn validate_document(document: &WorkspaceDocument) -> Result<()> {
    if document.scenes.is_empty() {
        return Err(Error::Invalid(
            "A project must contain at least one scene".into(),
        ));
    }
    let mut names = HashSet::new();
    let mut total = 0usize;
    for scene in &document.scenes {
        validate_file_name(&scene.file_name)?;
        if !scene.file_name.ends_with(".txt") || !names.insert(scene.file_name.to_lowercase()) {
            return Err(Error::Invalid(
                "Duplicate or invalid scene file name".into(),
            ));
        }
        total = total.saturating_add(scene.source.len());
        if scene.source.len() as u64 > MAX_SCRIPT_BYTES || total > 128 * 1024 * 1024 {
            return Err(Error::Invalid(
                "Project scripts exceed the size limit".into(),
            ));
        }
    }
    if document.notes.len() + document.editor_state.len() > 32 * 1024 * 1024 {
        return Err(Error::Invalid("Editor state exceeds the size limit".into()));
    }
    Ok(())
}

fn revision(document: &WorkspaceDocument) -> Result<String> {
    let mut sorted = document.clone();
    sorted.scenes.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&sorted)?)
    ))
}

fn apply_workspace(root: &Path, pending: &PendingWorkspace) -> Result<()> {
    validate_document(&pending.document)?;
    validate_workspace_paths(root, pending)?;
    let directory = checked_directory(root, "game/scene")?;
    for name in &pending.previous_files {
        validate_file_name(name)?;
    }
    // Remove obsolete names first: a case-only rename can address the same file.
    // The durable journal retains every replacement source if publication is interrupted.
    for name in &pending.previous_files {
        if !pending
            .document
            .scenes
            .iter()
            .any(|scene| &scene.file_name == name)
        {
            let path = directory.join(name);
            reject_symlink(&path)?;
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    for scene in &pending.document.scenes {
        let path = directory.join(&scene.file_name);
        reject_symlink(&path)?;
        json_store::write_crash_safe(&path, scene.source.as_bytes())?;
    }
    let state = EditorState {
        notes: pending.document.notes.clone(),
        editor_state: pending.document.editor_state.clone(),
    };
    json_store::write_crash_safe(
        &reserved_file(root, EDITOR_STATE)?,
        &serde_json::to_vec(&state)?,
    )?;
    Ok(())
}

fn validate_workspace_paths(root: &Path, pending: &PendingWorkspace) -> Result<()> {
    let directory = checked_directory(root, "game/scene")?;
    for name in pending
        .previous_files
        .iter()
        .chain(pending.document.scenes.iter().map(|scene| &scene.file_name))
    {
        validate_file_name(name)?;
        if !name.ends_with(".txt") {
            return Err(Error::Invalid("Invalid scene file name".into()));
        }
        let path = directory.join(name);
        reject_symlink(&path)?;
        if path.exists() && !path.is_file() {
            return Err(Error::Invalid("Scene path is not a file".into()));
        }
    }
    reserved_file(root, EDITOR_STATE)?;
    Ok(())
}

fn recover_workspace(root: &Path) -> Result<()> {
    let path = root.join(PENDING);
    if !path.exists() {
        return Ok(());
    }
    if fs::metadata(&path)?.len() > MAX_SCRIPT_BYTES {
        return Err(Error::Invalid(
            "Pending workspace exceeds the size limit".into(),
        ));
    }
    let pending = serde_json::from_str(&json_store::read_to_string_recovering(&checked_file(
        root, PENDING,
    )?)?)?;
    apply_workspace(root, &pending)?;
    fs::remove_file(path)?;
    Ok(())
}

pub fn update_metadata(root: &Path, name: &str, description: &str) -> Result<()> {
    if name.trim().is_empty() || name.contains(['\r', '\n', ';']) {
        return Err(Error::Invalid("Invalid project name".into()));
    }
    with_project(root, |root| {
        let path = checked_file(root, "game/config.txt")?;
        let source = fs::read_to_string(&path)?;
        let mut replaced = false;
        let mut output = String::new();
        for line in source.split_inclusive('\n') {
            if line
                .trim()
                .split_once(':')
                .is_some_and(|(key, _)| key == "Game_name")
            {
                output.push_str(&format!("Game_name:{name};\n"));
                replaced = true;
            } else {
                output.push_str(line);
            }
        }
        if !replaced {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&format!("Game_name:{name};\n"));
        }
        let metadata_path = root.join("project-metadata.json");
        reject_symlink(&metadata_path)?;
        let mut metadata = if metadata_path.exists() {
            serde_json::from_slice::<serde_json::Value>(&fs::read(&metadata_path)?)?
        } else {
            serde_json::json!({})
        };
        let fields = metadata
            .as_object_mut()
            .ok_or_else(|| Error::Invalid("Invalid project metadata".into()))?;
        let defaults = serde_json::to_value(ProjectMetadata::default())?;
        for (key, value) in defaults.as_object().unwrap() {
            fields.entry(key.clone()).or_insert_with(|| value.clone());
        }
        fields.insert("synopsis".into(), description.into());
        serde_json::from_value::<ProjectMetadata>(metadata.clone())?;
        json_store::write_crash_safe(&metadata_path, &serde_json::to_vec_pretty(&metadata)?)?;
        json_store::write_crash_safe(&path, output.as_bytes())?;
        Ok(())
    })
}

pub fn project_description(root: &Path) -> Result<String> {
    let path = root.join("project-metadata.json");
    if !path.exists() {
        return Ok(String::new());
    }
    if fs::metadata(&path)?.len() > MAX_METADATA_BYTES {
        return Err(Error::Invalid(
            "Project metadata exceeds the size limit".into(),
        ));
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(checked_file(root, "project-metadata.json")?)?)?;
    Ok(metadata
        .get("synopsis")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_owned())
}

pub fn reject_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(Error::Invalid(format!(
            "Symbolic links are not supported: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn checked_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(Error::Invalid("Invalid relative project path".into()));
        }
        path.push(component);
        reject_symlink(&path)?;
    }
    if !path.is_dir() {
        return Err(Error::Invalid(format!("Missing directory: {relative}")));
    }
    Ok(path)
}

pub fn checked_file(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    let parent = relative.parent().unwrap_or(Path::new(""));
    let directory = checked_directory(
        root,
        parent
            .to_str()
            .ok_or_else(|| Error::Invalid("Invalid path".into()))?,
    )?;
    let name = relative
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::Invalid("Invalid file name".into()))?;
    let path = directory.join(name);
    reject_symlink(&path)?;
    if !path.is_file() {
        return Err(Error::Invalid(format!(
            "Missing project file: {}",
            relative.display()
        )));
    }
    Ok(path)
}

fn reserved_file(root: &Path, relative: &str) -> Result<PathBuf> {
    let editor = root.join(".ollaic");
    reject_symlink(&editor)?;
    fs::create_dir_all(&editor)?;
    let path = root.join(relative);
    reject_symlink(&path)?;
    Ok(path)
}
