use super::project_paths::ProjectPaths;
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportDestination {
    path: PathBuf,
}

impl ExportDestination {
    pub fn validate(project: &ProjectPaths, destination: impl AsRef<Path>) -> Result<Self, String> {
        let requested = destination.as_ref();
        if !requested.is_absolute() {
            return Err("Export destination must be an absolute path".into());
        }
        let path = resolve_with_existing_ancestor(requested)?;
        let project_root = project.root();
        if path == project_root || path.starts_with(project_root) || project_root.starts_with(&path)
        {
            return Err(format!(
                "Export destination overlaps source project: {}",
                requested.display()
            ));
        }
        Ok(Self { path })
    }

    pub fn as_path(&self) -> &Path {
        &self.path
    }
}

fn resolve_with_existing_ancestor(requested: &Path) -> Result<PathBuf, String> {
    let mut existing = requested.to_path_buf();
    let mut missing = Vec::<OsString>::new();
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let name = existing.file_name().ok_or_else(|| {
                    format!(
                        "Export destination has no existing ancestor: {}",
                        requested.display()
                    )
                })?;
                missing.push(name.to_os_string());
                existing = existing
                    .parent()
                    .ok_or_else(|| {
                        format!(
                            "Export destination has no existing ancestor: {}",
                            requested.display()
                        )
                    })?
                    .to_path_buf();
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect export destination {}: {error}",
                    requested.display()
                ))
            }
        }
    }

    let mut resolved = existing.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve export destination ancestor {}: {error}",
            existing.display()
        )
    })?;
    for component in missing.into_iter().rev() {
        if component == "." {
            continue;
        }
        if component == ".." {
            if !resolved.pop() {
                return Err(format!(
                    "Invalid export destination: {}",
                    requested.display()
                ));
            }
        } else {
            resolved.push(component);
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webgal::project_paths::ProjectPaths;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ollaic_export_destination_{label}_{nonce}"))
    }

    fn project_at(path: &PathBuf) -> ProjectPaths {
        fs::create_dir_all(path.join("game/scene")).unwrap();
        ProjectPaths::open(path).unwrap()
    }

    #[test]
    fn export_destination_rejects_equal_child_parent_and_nonexistent_child() {
        let workspace = temp_root("overlap");
        let project_root = workspace.join("project");
        let project = project_at(&project_root);

        assert!(ExportDestination::validate(&project, &project_root).is_err());
        assert!(ExportDestination::validate(&project, project_root.join("exports")).is_err());
        assert!(ExportDestination::validate(&project, &workspace).is_err());
        assert!(
            ExportDestination::validate(&project, project_root.join("missing/nested/export"))
                .is_err()
        );

        let sibling = workspace.join("sibling");
        assert_eq!(
            ExportDestination::validate(&project, &sibling)
                .unwrap()
                .as_path(),
            sibling
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn export_destination_resolves_symlink_aliases_before_overlap_check() {
        use std::os::unix::fs::symlink;

        let workspace = temp_root("symlink");
        let project_root = workspace.join("project");
        let project = project_at(&project_root);
        let child = project_root.join("exports");
        fs::create_dir_all(&child).unwrap();
        let alias = workspace.join("alias");
        symlink(&child, &alias).unwrap();

        assert!(ExportDestination::validate(&project, &alias).is_err());
        fs::remove_dir_all(workspace).unwrap();
    }
}
