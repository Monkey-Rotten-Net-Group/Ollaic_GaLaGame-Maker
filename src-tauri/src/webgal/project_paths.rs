use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SceneName(String);

impl SceneName {
    pub fn parse(value: &str) -> Result<Self, String> {
        if value.is_empty() || value.trim() != value {
            return Err(format!("Invalid scene name: {value}"));
        }
        let raw = Path::new(value);
        if raw.is_absolute()
            || !matches!(
                raw.components().collect::<Vec<_>>().as_slice(),
                [Component::Normal(_)]
            )
            || value.contains(['/', '\\'])
            || value.chars().any(char::is_control)
            || value
                .chars()
                .any(|character| r#"<>:"|?*"#.contains(character))
        {
            return Err(format!("Invalid scene name: {value}"));
        }

        let normalized = match raw.extension().and_then(|extension| extension.to_str()) {
            None => format!("{value}.txt"),
            Some(extension) if extension.eq_ignore_ascii_case("txt") => {
                format!("{}.txt", raw.with_extension("").to_string_lossy())
            }
            Some(_) => return Err(format!("Scene name must use the .txt extension: {value}")),
        };
        let stem = Path::new(&normalized)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(|| format!("Invalid scene name: {value}"))?;
        if stem.is_empty() || stem.ends_with(['.', ' ']) || is_reserved_stem(stem) {
            return Err(format!("Invalid or reserved scene name: {value}"));
        }
        Ok(Self(normalized))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn case_key(&self) -> String {
        self.0.to_lowercase()
    }
}

#[derive(Debug, Clone)]
pub struct ProjectPaths {
    root: PathBuf,
    scene_dir: PathBuf,
    write_guard: Arc<Mutex<()>>,
}

impl ProjectPaths {
    pub fn open(project_root: impl AsRef<Path>) -> Result<Self, String> {
        let requested_root = project_root.as_ref();
        let root = requested_root
            .canonicalize()
            .map_err(|error| format!("Invalid project {}: {error}", requested_root.display()))?;
        if !root.is_dir() {
            return Err(format!(
                "Invalid project {}: not a directory",
                root.display()
            ));
        }

        let game = canonical_domain_dir(&root, &root.join("game"), "game")?;
        let scene_dir = canonical_domain_dir(&game, &game.join("scene"), "scene")?;
        let write_guard = project_write_guard(&root);
        Ok(Self {
            root,
            scene_dir,
            write_guard,
        })
    }

    pub fn existing_scene(&self, scene_name: &str) -> Result<PathBuf, String> {
        let path = self.scene_candidate(scene_name)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Scene path {} is not accessible: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Scene path {} is a symbolic link; remove it or replace it with a regular project file",
                path.display()
            ));
        }
        if !metadata.is_file() {
            return Err(format!(
                "Scene path {} is not a regular project file; replace it with a regular file",
                path.display()
            ));
        }
        let resolved = path
            .canonicalize()
            .map_err(|error| format!("Scene path {} is not accessible: {error}", path.display()))?;
        if !resolved.starts_with(&self.scene_dir) {
            return Err(format!(
                "Scene path {} resolves outside {}; move it back into the project scene directory",
                path.display(),
                self.scene_dir.display()
            ));
        }
        Ok(path)
    }

    pub fn scene_candidate(&self, scene_name: &str) -> Result<PathBuf, String> {
        let scene_name = SceneName::parse(scene_name)?;
        let path = self.scene_dir.join(scene_name.as_str());
        if path.parent() != Some(self.scene_dir.as_path()) {
            return Err(format!("Invalid scene identifier: {}", scene_name.as_str()));
        }
        Ok(path)
    }

    pub fn create_scene(&self, scene_name: &str, content: &[u8]) -> Result<SceneName, String> {
        let scene_name = SceneName::parse(scene_name)?;
        let _guard = self
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.has_case_insensitive_scene(&scene_name)? {
            return Err(format!("Scene {} already exists", scene_name.as_str()));
        }
        let path = self.scene_dir.join(scene_name.as_str());
        crate::json_store::write_new_crash_safe(&path, content)
            .map_err(|error| format!("Failed to create scene {}: {error}", scene_name.as_str()))?;
        Ok(scene_name)
    }

    pub fn rename_scene(&self, scene_name: &str, new_name: &str) -> Result<SceneName, String> {
        let normalized_name = SceneName::parse(new_name)?;
        let _guard = self
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let path = self.existing_scene(scene_name)?;
        if normalized_name.as_str() == scene_name {
            return Ok(normalized_name);
        }
        if self.has_case_insensitive_scene_except(&normalized_name, Some(scene_name))? {
            return Err(format!("Scene {} already exists", normalized_name.as_str()));
        }
        let new_path = self.scene_candidate(normalized_name.as_str())?;
        rename_regular_file_without_replace(&path, &new_path).map_err(|error| {
            format!(
                "Failed to rename {} -> {}: {error}",
                path.display(),
                new_path.display()
            )
        })?;
        Ok(normalized_name)
    }

    pub fn has_case_insensitive_scene(&self, scene_name: &SceneName) -> Result<bool, String> {
        self.has_case_insensitive_scene_except(scene_name, None)
    }

    fn has_case_insensitive_scene_except(
        &self,
        scene_name: &SceneName,
        excluded_name: Option<&str>,
    ) -> Result<bool, String> {
        let expected = scene_name.case_key();
        for entry in fs::read_dir(&self.scene_dir)
            .map_err(|error| format!("Failed to inspect project scenes: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("Failed to inspect project scenes: {error}"))?;
            let entry_name = entry.file_name();
            if excluded_name.is_some_and(|excluded| entry_name == excluded) {
                continue;
            }
            if entry_name.to_string_lossy().to_lowercase() == expected {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn list_scenes(&self) -> Result<Vec<String>, String> {
        let mut scenes = Vec::new();
        for entry in fs::read_dir(&self.scene_dir)
            .map_err(|error| format!("Failed to list project scenes: {error}"))?
        {
            let entry = entry.map_err(|error| format!("Failed to list project scenes: {error}"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if validate_scene_identifier(&name).is_err() {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| format!("Failed to inspect scene {name}: {error}"))?;
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                scenes.push(name);
            }
        }
        scenes.sort();
        Ok(scenes)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn lock_for_write(&self) -> MutexGuard<'_, ()> {
        self.write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

#[cfg(windows)]
fn rename_regular_file_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn rename_regular_file_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    if destination.exists() && same_file::is_same_file(source, destination)? {
        return fs::rename(source, destination);
    }
    fs::hard_link(source, destination)?;
    if let Err(error) = fs::remove_file(source) {
        return Err(std::io::Error::new(
            error.kind(),
            format!(
                "created {}, but failed to remove {}; both names were preserved: {error}",
                destination.display(),
                source.display()
            ),
        ));
    }
    Ok(())
}

fn canonical_domain_dir(owner: &Path, requested: &Path, label: &str) -> Result<PathBuf, String> {
    let resolved = requested
        .canonicalize()
        .map_err(|error| {
            format!(
                "Invalid project {label} directory {}: {error}; create a regular directory at this path",
                requested.display()
            )
        })?;
    if !resolved.is_dir() || !resolved.starts_with(owner) {
        return Err(format!(
            "Invalid project {label} directory {}: it resolves outside {}; remove the symbolic link and create a regular directory",
            requested.display(),
            owner.display()
        ));
    }
    Ok(resolved)
}

fn validate_scene_identifier(scene_name: &str) -> Result<(), String> {
    let normalized = SceneName::parse(scene_name)?;
    if normalized.as_str() != scene_name {
        return Err(format!("Invalid scene identifier: {scene_name}"));
    }
    Ok(())
}

fn is_reserved_stem(stem: &str) -> bool {
    let device = stem.split('.').next().unwrap_or(stem).to_ascii_uppercase();
    matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device
            .strip_prefix("COM")
            .or_else(|| device.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                suffix.len() == 1
                    && suffix
                        .as_bytes()
                        .first()
                        .is_some_and(|digit| (b'1'..=b'9').contains(digit))
            })
}

fn project_write_guard(project: &Path) -> Arc<Mutex<()>> {
    static GUARDS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let guards = GUARDS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guards = guards.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(guard) = guards.get(project).and_then(Weak::upgrade) {
        return guard;
    }
    guards.retain(|_, guard| guard.strong_count() > 0);
    let guard = Arc::new(Mutex::new(()));
    guards.insert(project.to_path_buf(), Arc::downgrade(&guard));
    guard
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ollaic_project_paths_{label}_{nonce}"))
    }

    #[test]
    fn project_paths_rejects_scene_identifiers_outside_the_scene_domain() {
        let workspace = temp_root("scene_escape");
        let project = workspace.join("project");
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::write(workspace.join("outside.txt"), "secret").unwrap();

        let paths = ProjectPaths::open(&project).unwrap();
        assert!(paths.existing_scene("../../../outside.txt").is_err());
        assert!(paths
            .existing_scene(&workspace.join("outside.txt").to_string_lossy())
            .is_err());

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn project_paths_accepts_unicode_scene_names_and_rejects_extension_case_variants() {
        let workspace = temp_root("unicode");
        let project = workspace.join("project");
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::write(project.join("game/scene/雨夜.txt"), "content").unwrap();
        fs::write(project.join("game/scene/upper.TXT"), "content").unwrap();

        let paths = ProjectPaths::open(&project).unwrap();
        assert!(paths.existing_scene("雨夜.txt").is_ok());
        assert!(paths.existing_scene("upper.TXT").is_err());
        assert_eq!(paths.list_scenes().unwrap(), vec!["雨夜.txt"]);

        fs::remove_dir_all(workspace).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn project_paths_rejects_symlinked_domains_and_scene_files() {
        use std::os::unix::fs::symlink;

        let workspace = temp_root("symlink");
        let outside = workspace.join("outside");
        let project = workspace.join("project");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(
            outside.join("secret.txt"),
            project.join("game/scene/link.txt"),
        )
        .unwrap();

        let paths = ProjectPaths::open(&project).unwrap();
        assert!(paths.existing_scene("link.txt").is_err());

        let escaped_project = workspace.join("escaped-project");
        fs::create_dir_all(escaped_project.join("game")).unwrap();
        symlink(&outside, escaped_project.join("game/scene")).unwrap();
        assert!(ProjectPaths::open(&escaped_project).is_err());

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn scene_name_normalizes_extension_and_preserves_unicode() {
        assert_eq!(SceneName::parse("雨夜").unwrap().as_str(), "雨夜.txt");
        assert_eq!(SceneName::parse("雨夜.TXT").unwrap().as_str(), "雨夜.txt");
        assert_eq!(SceneName::parse("雨夜.txt").unwrap().as_str(), "雨夜.txt");
    }

    #[test]
    fn scene_name_rejects_traversal_separators_extensions_and_reserved_names() {
        for invalid in [
            "../escape",
            "nested/scene",
            r"nested\scene",
            "/absolute",
            "chapter.md",
            "CON",
            "lpt1.txt",
            "trailing. ",
        ] {
            assert!(
                SceneName::parse(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[test]
    fn atomic_scene_create_rejects_case_insensitive_collisions() {
        let workspace = temp_root("case_collision");
        let project = workspace.join("project");
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::write(project.join("game/scene/Chapter.txt"), "existing").unwrap();
        let paths = ProjectPaths::open(&project).unwrap();

        assert!(paths.create_scene("chapter", b"replacement").is_err());
        assert_eq!(
            fs::read_to_string(project.join("game/scene/Chapter.txt")).unwrap(),
            "existing"
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn concurrent_same_name_scene_creates_have_exactly_one_winner() {
        let workspace = temp_root("concurrent_create");
        let project = workspace.join("project");
        fs::create_dir_all(project.join("game/scene")).unwrap();
        let paths = ProjectPaths::open(&project).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let paths = paths.clone();
                std::thread::spawn(move || {
                    paths.create_scene("chapter", format!("writer-{index}").as_bytes())
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let content = fs::read_to_string(project.join("game/scene/chapter.txt")).unwrap();
        assert!(content.starts_with("writer-"));
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn rename_scene_never_overwrites_an_existing_destination() {
        let workspace = temp_root("rename_collision");
        let project = workspace.join("project");
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::write(project.join("game/scene/old.txt"), "old content").unwrap();
        fs::write(project.join("game/scene/new.txt"), "new content").unwrap();
        let paths = ProjectPaths::open(&project).unwrap();

        assert!(paths.rename_scene("old.txt", "new.txt").is_err());
        assert_eq!(
            fs::read_to_string(project.join("game/scene/old.txt")).unwrap(),
            "old content"
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/new.txt")).unwrap(),
            "new content"
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn case_only_scene_rename_succeeds_without_changing_content() {
        let workspace = temp_root("case_only_rename");
        let project = workspace.join("project");
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::write(project.join("game/scene/chapter.txt"), "chapter content").unwrap();
        let paths = ProjectPaths::open(&project).unwrap();

        paths.rename_scene("chapter.txt", "Chapter.txt").unwrap();

        assert!(!project.join("game/scene/chapter.txt").exists());
        assert_eq!(
            fs::read_to_string(project.join("game/scene/Chapter.txt")).unwrap(),
            "chapter content"
        );
        fs::remove_dir_all(workspace).unwrap();
    }
}
