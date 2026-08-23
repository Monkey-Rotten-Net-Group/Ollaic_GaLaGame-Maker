use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangeSetRequest {
    pub project_path: String,
    pub operations: Vec<ChangeSetOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChangeSetOperation {
    Scene {
        file: String,
        baseline: String,
        content: String,
    },
    Characters {
        baseline: serde_json::Value,
        document: serde_json::Value,
    },
    ProjectMemory {
        baseline: serde_json::Value,
        memory: serde_json::Value,
    },
    AssetMetadata {
        baseline: serde_json::Value,
        metadata: serde_json::Value,
    },
    CreateScene {
        file: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ApplyChangeSetResult {
    Committed {
        resources: Vec<ResourceId>,
    },
    Conflict {
        resources: Vec<ResourceId>,
    },
    FailedAndRolledBack {
        failed_resource: ResourceId,
        message: String,
    },
    RollbackFailed {
        failed_resource: ResourceId,
        residual_resources: Vec<ResourceId>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResourceId {
    Project,
    Scene { file: String },
    Characters,
    ProjectMemory,
    AssetMetadata,
}

struct PreparedWrite {
    resource: ResourceId,
    path: PathBuf,
    baseline: Baseline,
    content: Vec<u8>,
    parent_existed: bool,
}

impl PreparedWrite {
    fn new(resource: ResourceId, path: PathBuf, baseline: Baseline, content: Vec<u8>) -> Self {
        let parent_existed = path.parent().is_some_and(Path::is_dir);
        Self {
            resource,
            path,
            baseline,
            content,
            parent_existed,
        }
    }
}

enum Baseline {
    Text(String),
    Json(serde_json::Value),
    Missing,
}

#[tauri::command]
pub fn apply_change_set(request: ApplyChangeSetRequest) -> ApplyChangeSetResult {
    apply_change_set_impl(request, &FailurePlan::default())
}

#[derive(Default)]
struct FailurePlan {
    fail_write: Option<ResourceId>,
    fail_after_create: Option<ResourceId>,
    fail_rollback: Vec<ResourceId>,
}

#[cfg(test)]
impl FailurePlan {
    fn fail_write(resource: ResourceId) -> Self {
        Self {
            fail_write: Some(resource),
            fail_after_create: None,
            fail_rollback: Vec::new(),
        }
    }
}

#[cfg(test)]
fn apply_change_set_with_failures(
    request: ApplyChangeSetRequest,
    failures: FailurePlan,
) -> ApplyChangeSetResult {
    apply_change_set_impl(request, &failures)
}

fn apply_change_set_impl(
    request: ApplyChangeSetRequest,
    failures: &FailurePlan,
) -> ApplyChangeSetResult {
    let project = PathBuf::from(&request.project_path);
    let project_key = match project.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            return ApplyChangeSetResult::FailedAndRolledBack {
                failed_resource: ResourceId::Project,
                message: "invalid project".into(),
            }
        }
    };
    let project_guard = project_write_guard(&project_key);
    let _guard = project_guard
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !project.join("game").is_dir() {
        return ApplyChangeSetResult::FailedAndRolledBack {
            failed_resource: ResourceId::Project,
            message: "invalid project".into(),
        };
    }

    let mut writes = Vec::new();
    for operation in request.operations {
        match prepare_write(&project, operation) {
            Ok(write) => writes.push(write),
            Err((resource, message)) => {
                return ApplyChangeSetResult::FailedAndRolledBack {
                    failed_resource: resource,
                    message,
                };
            }
        }
    }
    for write in &writes {
        if !target_is_project_owned(&project_key, &write.path) {
            return ApplyChangeSetResult::FailedAndRolledBack {
                failed_resource: write.resource.clone(),
                message: "resource path escapes project".into(),
            };
        }
    }
    if let Some(duplicate) = duplicate_resource(&writes) {
        return ApplyChangeSetResult::FailedAndRolledBack {
            failed_resource: duplicate,
            message: "duplicate resource operation".into(),
        };
    }
    let conflicts: Vec<ResourceId> = writes
        .iter()
        .filter(|write| !baseline_matches(write))
        .map(|write| write.resource.clone())
        .collect();
    if !conflicts.is_empty() {
        return ApplyChangeSetResult::Conflict {
            resources: conflicts,
        };
    }

    let mut snapshots = Vec::with_capacity(writes.len());
    for write in &writes {
        match read_snapshot(&write.path) {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(error) => {
                return ApplyChangeSetResult::FailedAndRolledBack {
                    failed_resource: write.resource.clone(),
                    message: format!("failed to snapshot resource: {error}"),
                };
            }
        }
    }

    let mut applied: Vec<(&PreparedWrite, Option<Vec<u8>>)> = Vec::new();
    for (write, previous) in writes.iter().zip(snapshots) {
        let result = if failures.fail_write.as_ref() == Some(&write.resource) {
            Err("injected write failure".to_string())
        } else {
            write_resource(write, failures).map_err(|error| error.to_string())
        };
        if let Err(message) = result {
            applied.push((write, previous));
            let residual_resources = rollback(&mut applied, failures);
            return if residual_resources.is_empty() {
                ApplyChangeSetResult::FailedAndRolledBack {
                    failed_resource: write.resource.clone(),
                    message,
                }
            } else {
                ApplyChangeSetResult::RollbackFailed {
                    failed_resource: write.resource.clone(),
                    residual_resources,
                    message,
                }
            };
        }
        applied.push((write, previous));
    }
    ApplyChangeSetResult::Committed {
        resources: writes.into_iter().map(|write| write.resource).collect(),
    }
}

fn read_snapshot(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write_resource(write: &PreparedWrite, failures: &FailurePlan) -> std::io::Result<()> {
    if let Some(parent) = write.path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match write.baseline {
        Baseline::Missing => {
            write_create_new(&write.path, &write.content)?;
            if failures.fail_after_create.as_ref() == Some(&write.resource) {
                return Err(std::io::Error::other("injected failure after create"));
            }
            Ok(())
        }
        _ => crate::json_store::write_crash_safe(&write.path, &write.content),
    }
}

fn rollback(
    applied: &mut Vec<(&PreparedWrite, Option<Vec<u8>>)>,
    failures: &FailurePlan,
) -> Vec<ResourceId> {
    let mut residual = Vec::new();
    for (write, previous) in applied.drain(..).rev() {
        let result = if failures.fail_rollback.contains(&write.resource) {
            Err(std::io::Error::other("injected rollback failure"))
        } else if let Some(bytes) = previous {
            crate::json_store::write_crash_safe(&write.path, &bytes)
        } else if write.path.exists() {
            std::fs::remove_file(&write.path).and_then(|()| remove_created_parent(write))
        } else {
            remove_created_parent(write)
        };
        if result.is_err() {
            residual.push(write.resource.clone());
        }
    }
    residual
}

fn remove_created_parent(write: &PreparedWrite) -> std::io::Result<()> {
    if write.parent_existed {
        return Ok(());
    }
    let Some(parent) = write.path.parent() else {
        return Ok(());
    };
    match std::fs::remove_dir(parent) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(error) => Err(error),
    }
}

fn target_is_project_owned(project: &Path, target: &Path) -> bool {
    let Some(parent) = target.parent() else {
        return false;
    };
    let mut existing_ancestor = parent;
    while !existing_ancestor.exists() {
        let Some(next) = existing_ancestor.parent() else {
            return false;
        };
        existing_ancestor = next;
    }
    let Ok(parent) = existing_ancestor.canonicalize() else {
        return false;
    };
    if !parent.starts_with(project) {
        return false;
    }
    match std::fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => false,
        Ok(_) => target
            .canonicalize()
            .is_ok_and(|resolved| resolved.starts_with(project)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

fn duplicate_resource(writes: &[PreparedWrite]) -> Option<ResourceId> {
    for (index, write) in writes.iter().enumerate() {
        if writes[..index]
            .iter()
            .any(|previous| previous.resource == write.resource)
        {
            return Some(write.resource.clone());
        }
    }
    None
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

fn prepare_write(
    project: &Path,
    operation: ChangeSetOperation,
) -> Result<PreparedWrite, (ResourceId, String)> {
    Ok(match operation {
        ChangeSetOperation::Scene {
            file,
            baseline,
            content,
        } => {
            if !is_scene_name(&file) {
                return Err((ResourceId::Scene { file }, "invalid scene name".into()));
            }
            PreparedWrite::new(
                ResourceId::Scene { file: file.clone() },
                project.join("game/scene").join(file),
                Baseline::Text(baseline),
                content.into_bytes(),
            )
        }
        ChangeSetOperation::Characters { baseline, document } => PreparedWrite::new(
            ResourceId::Characters,
            project.join("game/config/characters.json"),
            Baseline::Json(baseline),
            serialize_json(ResourceId::Characters, &document)?,
        ),
        ChangeSetOperation::ProjectMemory { baseline, memory } => PreparedWrite::new(
            ResourceId::ProjectMemory,
            project.join("game/ai-memory.json"),
            Baseline::Json(baseline),
            serialize_json(ResourceId::ProjectMemory, &memory)?,
        ),
        ChangeSetOperation::AssetMetadata { baseline, metadata } => PreparedWrite::new(
            ResourceId::AssetMetadata,
            project.join("game/config/asset-metadata.json"),
            Baseline::Json(baseline),
            serialize_json(ResourceId::AssetMetadata, &metadata)?,
        ),
        ChangeSetOperation::CreateScene { file, content } => {
            if !is_scene_name(&file) {
                return Err((ResourceId::Scene { file }, "invalid scene name".into()));
            }
            PreparedWrite::new(
                ResourceId::Scene { file: file.clone() },
                project.join("game/scene").join(file),
                Baseline::Missing,
                content.into_bytes(),
            )
        }
    })
}

fn serialize_json(
    resource: ResourceId,
    value: &serde_json::Value,
) -> Result<Vec<u8>, (ResourceId, String)> {
    serde_json::to_vec_pretty(value)
        .map_err(|error| (resource, format!("failed to serialize resource: {error}")))
}

fn write_create_new(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(content)?;
    file.sync_all()
}

fn baseline_matches(write: &PreparedWrite) -> bool {
    match &write.baseline {
        Baseline::Text(expected) => std::fs::read_to_string(&write.path)
            .map(|current| current == *expected)
            .unwrap_or(false),
        Baseline::Json(expected) => match std::fs::read(&write.path) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
                .is_ok_and(|current| current == *expected),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_json_matches(&write.resource, expected)
            }
            Err(_) => false,
        },
        Baseline::Missing => !write.path.exists(),
    }
}

fn missing_json_matches(resource: &ResourceId, expected: &serde_json::Value) -> bool {
    match resource {
        ResourceId::Characters => serde_json::from_value::<
            crate::characters::types::CharactersDocument,
        >(expected.clone())
        .is_ok_and(|document| document.version == 1 && document.characters.is_empty()),
        ResourceId::ProjectMemory => {
            serde_json::from_value::<crate::webgal::project::ProjectMemory>(expected.clone())
                .is_ok_and(|memory| {
                    memory.world_setting.is_empty()
                        && memory.writing_style.is_empty()
                        && memory.user_preferences.is_empty()
                })
        }
        ResourceId::AssetMetadata => {
            serde_json::from_value::<crate::assets::commands::AssetMetadata>(expected.clone())
                .is_ok_and(|metadata| {
                    metadata.aliases.is_empty()
                        && metadata.descriptions.is_empty()
                        && metadata.tags.is_empty()
                        && metadata.references.is_empty()
                        && metadata.scene_cards.is_empty()
                        && metadata.cg_cards.is_empty()
                        && metadata.voice_cards.is_empty()
                        && metadata.deleted_scene_cards.is_empty()
                        && metadata.deleted_cg_cards.is_empty()
                        && metadata.deleted_voice_cards.is_empty()
                })
        }
        _ => false,
    }
}

fn is_scene_name(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && value.ends_with(".txt")
        && path.components().count() == 1
        && path.file_name().and_then(|name| name.to_str()) == Some(value)
        && value != "."
        && value != ".."
        && !value.contains('\\')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ollaic_change_set_commit_{label}_{nonce}"));
        fs::create_dir_all(root.join("game/scene")).unwrap();
        root
    }

    fn json(value: serde_json::Value) -> serde_json::Value {
        value
    }

    fn setup_all_resources(label: &str) -> PathBuf {
        let project = temp_project(label);
        fs::create_dir_all(project.join("game/config")).unwrap();
        fs::write(project.join("game/scene/start.txt"), "scene-before").unwrap();
        fs::write(
            project.join("game/config/characters.json"),
            r#"{"version":1,"characters":[]}"#,
        )
        .unwrap();
        fs::write(
            project.join("game/ai-memory.json"),
            r#"{"value":"memory-before"}"#,
        )
        .unwrap();
        fs::write(
            project.join("game/config/asset-metadata.json"),
            r#"{"value":"metadata-before"}"#,
        )
        .unwrap();
        project
    }

    fn all_resource_operations() -> Vec<ChangeSetOperation> {
        vec![
            ChangeSetOperation::Scene {
                file: "start.txt".into(),
                baseline: "scene-before".into(),
                content: "scene-after".into(),
            },
            ChangeSetOperation::Characters {
                baseline: serde_json::json!({"version":1,"characters":[]}),
                document: serde_json::json!({"version":1,"characters":[{"id":"hero"}]}),
            },
            ChangeSetOperation::ProjectMemory {
                baseline: serde_json::json!({"value":"memory-before"}),
                memory: serde_json::json!({"value":"memory-after"}),
            },
            ChangeSetOperation::AssetMetadata {
                baseline: serde_json::json!({"value":"metadata-before"}),
                metadata: serde_json::json!({"value":"metadata-after"}),
            },
            ChangeSetOperation::CreateScene {
                file: "new.txt".into(),
                content: "new".into(),
            },
        ]
    }

    fn assert_original_resources(project: &Path) {
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "scene-before"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(project.join("game/config/characters.json")).unwrap()
            )
            .unwrap(),
            serde_json::json!({"version":1,"characters":[]})
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(project.join("game/ai-memory.json")).unwrap()
            )
            .unwrap(),
            serde_json::json!({"value":"memory-before"})
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(project.join("game/config/asset-metadata.json")).unwrap()
            )
            .unwrap(),
            serde_json::json!({"value":"metadata-before"})
        );
    }

    #[test]
    fn change_set_commit_accepts_logical_empty_json_baselines_on_a_fresh_project() {
        let project = temp_project("fresh_json_defaults");
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Characters {
                    baseline: serde_json::json!({"version":1,"characters":[]}),
                    document: serde_json::json!({
                        "version":1,
                        "characters":[{"id":"hero","name":"Hero"}]
                    }),
                },
                ChangeSetOperation::ProjectMemory {
                    baseline: serde_json::json!({
                        "worldSetting":"",
                        "writingStyle":"",
                        "userPreferences":"",
                        "updatedAt":"fresh-client-timestamp"
                    }),
                    memory: serde_json::json!({
                        "worldSetting":"Harbor",
                        "writingStyle":"",
                        "userPreferences":"",
                        "updatedAt":"now"
                    }),
                },
                ChangeSetOperation::AssetMetadata {
                    baseline: serde_json::json!({}),
                    metadata: serde_json::json!({"aliases":{"background/port.png":"Port"}}),
                },
            ],
        });

        assert_eq!(
            result,
            ApplyChangeSetResult::Committed {
                resources: vec![
                    ResourceId::Characters,
                    ResourceId::ProjectMemory,
                    ResourceId::AssetMetadata,
                ]
            }
        );
        assert!(project.join("game/config/characters.json").is_file());
        assert!(project.join("game/ai-memory.json").is_file());
        assert!(project.join("game/config/asset-metadata.json").is_file());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_fresh_json_failure_removes_created_files_and_directories() {
        let project = temp_project("fresh_json_rollback");
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Characters {
                    baseline: serde_json::json!({"version":1,"characters":[]}),
                    document: serde_json::json!({"version":1,"characters":[{"id":"hero"}]}),
                },
                ChangeSetOperation::ProjectMemory {
                    baseline: serde_json::json!({
                        "worldSetting":"",
                        "writingStyle":"",
                        "userPreferences":"",
                        "updatedAt":"fresh-client-timestamp"
                    }),
                    memory: serde_json::json!({"worldSetting":"Harbor"}),
                },
            ],
        };

        let result = apply_change_set_with_failures(
            request,
            FailurePlan::fail_write(ResourceId::ProjectMemory),
        );

        assert!(matches!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack { .. }
        ));
        assert!(!project.join("game/config/characters.json").exists());
        assert!(!project.join("game/ai-memory.json").exists());
        assert!(!project.join("game/config").exists());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_command_request_and_results_serialize() {
        let request: ApplyChangeSetRequest = serde_json::from_value(serde_json::json!({
            "projectPath": "/project",
            "operations": [{"kind":"scene","file":"start.txt","baseline":"before","content":"after"}]
        })).unwrap();
        assert_eq!(request.project_path, "/project");
        assert!(
            matches!(request.operations.as_slice(), [ChangeSetOperation::Scene { file, .. }] if file == "start.txt")
        );

        let values = [
            ApplyChangeSetResult::Committed {
                resources: vec![ResourceId::Characters],
            },
            ApplyChangeSetResult::Conflict {
                resources: vec![ResourceId::ProjectMemory],
            },
            ApplyChangeSetResult::FailedAndRolledBack {
                failed_resource: ResourceId::AssetMetadata,
                message: "failed".into(),
            },
            ApplyChangeSetResult::RollbackFailed {
                failed_resource: ResourceId::Characters,
                residual_resources: vec![ResourceId::Scene {
                    file: "start.txt".into(),
                }],
                message: "failed".into(),
            },
        ];
        let expected = [
            "committed",
            "conflict",
            "failed-and-rolled-back",
            "rollback-failed",
        ];
        for (result, status) in values.into_iter().zip(expected) {
            let value = serde_json::to_value(&result).unwrap();
            assert_eq!(value["status"], status);
            let round_trip: ApplyChangeSetResult = serde_json::from_value(value).unwrap();
            assert_eq!(round_trip, result);
        }
    }

    #[test]
    fn change_set_commit_different_projects_are_isolated() {
        let first = temp_project("project_first");
        let second = temp_project("project_second");
        fs::write(first.join("game/scene/start.txt"), "before").unwrap();
        fs::write(second.join("game/scene/start.txt"), "before").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = [(&first, "first"), (&second, "second")]
            .into_iter()
            .map(|(project, content)| {
                let project_path = project.to_string_lossy().into_owned();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    apply_change_set(ApplyChangeSetRequest {
                        project_path,
                        operations: vec![ChangeSetOperation::Scene {
                            file: "start.txt".into(),
                            baseline: "before".into(),
                            content: content.into(),
                        }],
                    })
                })
            })
            .collect();
        barrier.wait();
        for handle in handles {
            assert!(matches!(
                handle.join().unwrap(),
                ApplyChangeSetResult::Committed { .. }
            ));
        }
        assert_eq!(
            fs::read_to_string(first.join("game/scene/start.txt")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(second.join("game/scene/start.txt")).unwrap(),
            "second"
        );
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn change_set_commit_concurrent_same_baseline_allows_at_most_one_commit() {
        let project = temp_project("concurrent_baseline");
        fs::write(project.join("game/scene/start.txt"), "before").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut handles = Vec::new();
        for content in ["first", "second"] {
            let project_path = project.to_string_lossy().into_owned();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                apply_change_set(ApplyChangeSetRequest {
                    project_path,
                    operations: vec![ChangeSetOperation::Scene {
                        file: "start.txt".into(),
                        baseline: "before".into(),
                        content: content.into(),
                    }],
                })
            }));
        }
        barrier.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, ApplyChangeSetResult::Committed { .. }))
                .count(),
            1,
            "{results:?}"
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, ApplyChangeSetResult::Conflict { .. }))
                .count(),
            1,
            "{results:?}"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_rejects_escaping_scene_identifiers() {
        let project = temp_project("path_rejection");
        let outside = project
            .parent()
            .unwrap()
            .join("ollaic_change_set_outside.txt");
        fs::write(&outside, "sentinel").unwrap();
        for invalid in [
            "/tmp/evil.txt",
            "../evil.txt",
            "nested/evil.txt",
            "nested\\evil.txt",
            "..\\evil.txt",
        ] {
            let result = apply_change_set(ApplyChangeSetRequest {
                project_path: project.to_string_lossy().into_owned(),
                operations: vec![ChangeSetOperation::CreateScene {
                    file: invalid.into(),
                    content: "evil".into(),
                }],
            });
            assert!(
                matches!(result, ApplyChangeSetResult::FailedAndRolledBack { .. }),
                "{invalid}: {result:?}"
            );
        }
        assert_eq!(fs::read_to_string(&outside).unwrap(), "sentinel");
        assert_eq!(fs::read_dir(project.join("game/scene")).unwrap().count(), 0);
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(project).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn change_set_commit_rejects_symlinked_resource_directory() {
        use std::os::unix::fs::symlink;
        let project = temp_project("symlink_escape");
        let outside = temp_project("symlink_outside");
        fs::remove_dir_all(project.join("game/scene")).unwrap();
        symlink(outside.join("game/scene"), project.join("game/scene")).unwrap();
        fs::write(outside.join("game/scene/victim.txt"), "outside").unwrap();
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![ChangeSetOperation::Scene {
                file: "victim.txt".into(),
                baseline: "outside".into(),
                content: "changed".into(),
            }],
        });
        assert_eq!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack {
                failed_resource: ResourceId::Scene {
                    file: "victim.txt".into()
                },
                message: "resource path escapes project".into(),
            }
        );
        assert_eq!(
            fs::read_to_string(outside.join("game/scene/victim.txt")).unwrap(),
            "outside"
        );
        fs::remove_dir_all(project).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn change_set_commit_writer_error_after_replace_restores_current_resource() {
        let project = temp_project("writer_error_after_replace");
        let scene = project.join("game/scene/start.txt");
        fs::write(&scene, "before").unwrap();
        fs::create_dir(scene.with_extension("txt.bak")).unwrap();
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![ChangeSetOperation::Scene {
                file: "start.txt".into(),
                baseline: "before".into(),
                content: "after".into(),
            }],
        });
        assert_eq!(
            result,
            ApplyChangeSetResult::RollbackFailed {
                failed_resource: ResourceId::Scene {
                    file: "start.txt".into()
                },
                residual_resources: vec![ResourceId::Scene {
                    file: "start.txt".into()
                }],
                message: "Is a directory (os error 21)".into(),
            }
        );
        assert_eq!(fs::read_to_string(&scene).unwrap(), "before");
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_duplicate_resource_is_rejected_without_writes() {
        let project = temp_project("duplicate_resource");
        fs::write(project.join("game/scene/start.txt"), "before").unwrap();
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "before".into(),
                    content: "first".into(),
                },
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "before".into(),
                    content: "second".into(),
                },
            ],
        });
        assert_eq!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack {
                failed_resource: ResourceId::Scene {
                    file: "start.txt".into()
                },
                message: "duplicate resource operation".into(),
            }
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "before"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_failure_after_create_removes_partial_scene() {
        let project = temp_project("failure_after_create");
        let resource = ResourceId::Scene {
            file: "new.txt".into(),
        };
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![ChangeSetOperation::CreateScene {
                file: "new.txt".into(),
                content: "new".into(),
            }],
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan {
                fail_write: None,
                fail_after_create: Some(resource.clone()),
                fail_rollback: Vec::new(),
            },
        );
        assert_eq!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack {
                failed_resource: resource,
                message: "injected failure after create".into(),
            }
        );
        assert!(!project.join("game/scene/new.txt").exists());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_rollback_failure_reports_exact_residual_resources() {
        let project = temp_project("rollback_failure");
        fs::write(project.join("game/scene/one.txt"), "one-before").unwrap();
        fs::write(project.join("game/scene/two.txt"), "two-before").unwrap();
        let residual = ResourceId::Scene {
            file: "one.txt".into(),
        };
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "one.txt".into(),
                    baseline: "one-before".into(),
                    content: "one-after".into(),
                },
                ChangeSetOperation::Scene {
                    file: "two.txt".into(),
                    baseline: "two-before".into(),
                    content: "two-after".into(),
                },
            ],
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan {
                fail_write: Some(ResourceId::Scene {
                    file: "two.txt".into(),
                }),
                fail_after_create: None,
                fail_rollback: vec![residual.clone()],
            },
        );
        assert_eq!(
            result,
            ApplyChangeSetResult::RollbackFailed {
                failed_resource: ResourceId::Scene {
                    file: "two.txt".into()
                },
                residual_resources: vec![residual],
                message: "injected write failure".into(),
            }
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/one.txt")).unwrap(),
            "one-after"
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/two.txt")).unwrap(),
            "two-before"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_later_create_failure_removes_earlier_create() {
        let project = temp_project("later_create_failure");
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::CreateScene {
                    file: "one.txt".into(),
                    content: "one".into(),
                },
                ChangeSetOperation::CreateScene {
                    file: "two.txt".into(),
                    content: "two".into(),
                },
            ],
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan::fail_write(ResourceId::Scene {
                file: "two.txt".into(),
            }),
        );
        assert!(matches!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack { .. }
        ));
        assert!(!project.join("game/scene/one.txt").exists());
        assert!(!project.join("game/scene/two.txt").exists());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_create_failure_restores_all_previous_resources() {
        let project = setup_all_resources("create_failure");
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: all_resource_operations(),
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan::fail_write(ResourceId::Scene {
                file: "new.txt".into(),
            }),
        );
        assert!(matches!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack { .. }
        ));
        assert_original_resources(&project);
        assert!(!project.join("game/scene/new.txt").exists());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_asset_metadata_failure_restores_previous_resources() {
        let project = setup_all_resources("metadata_failure");
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: all_resource_operations(),
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan::fail_write(ResourceId::AssetMetadata),
        );
        assert!(matches!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack { .. }
        ));
        assert_original_resources(&project);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_memory_failure_restores_scene_and_characters() {
        let project = setup_all_resources("memory_failure");
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: all_resource_operations(),
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan::fail_write(ResourceId::ProjectMemory),
        );
        assert!(matches!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack { .. }
        ));
        assert_original_resources(&project);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_character_failure_restores_previous_scene() {
        let project = setup_all_resources("character_failure");
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: all_resource_operations(),
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan::fail_write(ResourceId::Characters),
        );
        assert!(matches!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack { .. }
        ));
        assert_original_resources(&project);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_scene_write_failure_restores_previous_scene() {
        let project = temp_project("scene_failure");
        fs::write(project.join("game/scene/one.txt"), "one-before").unwrap();
        fs::write(project.join("game/scene/two.txt"), "two-before").unwrap();
        let request = ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "one.txt".into(),
                    baseline: "one-before".into(),
                    content: "one-after".into(),
                },
                ChangeSetOperation::Scene {
                    file: "two.txt".into(),
                    baseline: "two-before".into(),
                    content: "two-after".into(),
                },
            ],
        };
        let result = apply_change_set_with_failures(
            request,
            FailurePlan::fail_write(ResourceId::Scene {
                file: "two.txt".into(),
            }),
        );
        assert!(matches!(
            result,
            ApplyChangeSetResult::FailedAndRolledBack { .. }
        ));
        assert_eq!(
            fs::read_to_string(project.join("game/scene/one.txt")).unwrap(),
            "one-before"
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/two.txt")).unwrap(),
            "two-before"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_create_scene_with_header_and_content_is_one_create() {
        let project = temp_project("create_complete");
        let content = "; 章节: 第一章\n; 大纲: 相遇\nAlice:Hello;\n";
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![ChangeSetOperation::CreateScene {
                file: "chapter1.txt".into(),
                content: content.into(),
            }],
        });
        assert!(matches!(result, ApplyChangeSetResult::Committed { .. }));
        assert_eq!(
            fs::read_to_string(project.join("game/scene/chapter1.txt")).unwrap(),
            content
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_multiple_create_scenes_succeed() {
        let project = temp_project("multiple_create");
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::CreateScene {
                    file: "one.txt".into(),
                    content: "one".into(),
                },
                ChangeSetOperation::CreateScene {
                    file: "two.txt".into(),
                    content: "two".into(),
                },
            ],
        });
        assert!(matches!(result, ApplyChangeSetResult::Committed { .. }));
        assert_eq!(
            fs::read_to_string(project.join("game/scene/one.txt")).unwrap(),
            "one"
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/two.txt")).unwrap(),
            "two"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_create_scene_collision_returns_conflict_without_writes() {
        let project = temp_project("create_collision");
        fs::write(project.join("game/scene/start.txt"), "before").unwrap();
        fs::write(project.join("game/scene/new.txt"), "existing").unwrap();
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "before".into(),
                    content: "after".into(),
                },
                ChangeSetOperation::CreateScene {
                    file: "new.txt".into(),
                    content: "created".into(),
                },
            ],
        });
        assert_eq!(
            result,
            ApplyChangeSetResult::Conflict {
                resources: vec![ResourceId::Scene {
                    file: "new.txt".into()
                }]
            }
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "before"
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/new.txt")).unwrap(),
            "existing"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_stale_asset_metadata_returns_conflict_without_writes() {
        let project = temp_project("stale_asset_metadata");
        fs::create_dir_all(project.join("game/config")).unwrap();
        fs::write(project.join("game/scene/start.txt"), "before").unwrap();
        fs::write(
            project.join("game/config/asset-metadata.json"),
            r#"{"aliases":{"current":"value"}}"#,
        )
        .unwrap();
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "before".into(),
                    content: "after".into(),
                },
                ChangeSetOperation::AssetMetadata {
                    baseline: serde_json::json!({"aliases":{}}),
                    metadata: serde_json::json!({"aliases":{"new":"value"}}),
                },
            ],
        });
        assert_eq!(
            result,
            ApplyChangeSetResult::Conflict {
                resources: vec![ResourceId::AssetMetadata]
            }
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "before"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_stale_project_memory_returns_conflict_without_writes() {
        let project = temp_project("stale_memory");
        fs::write(project.join("game/scene/start.txt"), "before").unwrap();
        fs::write(
            project.join("game/ai-memory.json"),
            r#"{"worldSetting":"current"}"#,
        )
        .unwrap();
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "before".into(),
                    content: "after".into(),
                },
                ChangeSetOperation::ProjectMemory {
                    baseline: serde_json::json!({"worldSetting":"staged"}),
                    memory: serde_json::json!({"worldSetting":"new"}),
                },
            ],
        });
        assert_eq!(
            result,
            ApplyChangeSetResult::Conflict {
                resources: vec![ResourceId::ProjectMemory]
            }
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "before"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_stale_characters_returns_conflict_without_writes() {
        let project = temp_project("stale_characters");
        fs::create_dir_all(project.join("game/config")).unwrap();
        fs::write(project.join("game/scene/start.txt"), "before").unwrap();
        fs::write(
            project.join("game/config/characters.json"),
            r#"{"version":1,"characters":[{"id":"hero"}]}"#,
        )
        .unwrap();
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "before".into(),
                    content: "after".into(),
                },
                ChangeSetOperation::Characters {
                    baseline: serde_json::json!({"version":1,"characters":[]}),
                    document: serde_json::json!({"version":1,"characters":[{"id":"new"}]}),
                },
            ],
        });
        assert_eq!(
            result,
            ApplyChangeSetResult::Conflict {
                resources: vec![ResourceId::Characters]
            }
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "before"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_stale_scene_returns_conflict_without_writes() {
        let project = temp_project("stale_scene");
        fs::write(project.join("game/scene/start.txt"), "start-before").unwrap();
        fs::write(project.join("game/scene/other.txt"), "other-current").unwrap();

        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "start-before".into(),
                    content: "start-after".into(),
                },
                ChangeSetOperation::Scene {
                    file: "other.txt".into(),
                    baseline: "other-staged".into(),
                    content: "other-after".into(),
                },
            ],
        });

        assert_eq!(
            result,
            ApplyChangeSetResult::Conflict {
                resources: vec![ResourceId::Scene {
                    file: "other.txt".into()
                }]
            }
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "start-before"
        );
        assert_eq!(
            fs::read_to_string(project.join("game/scene/other.txt")).unwrap(),
            "other-current"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_multi_resource_succeeds() {
        let project = temp_project("multi_resource");
        fs::create_dir_all(project.join("game/config")).unwrap();
        fs::write(project.join("game/scene/start.txt"), "before").unwrap();
        fs::write(
            project.join("game/config/characters.json"),
            r#"{"version":1,"characters":[]}"#,
        )
        .unwrap();
        fs::write(
            project.join("game/ai-memory.json"),
            r#"{"worldSetting":"old","writingStyle":"","userPreferences":"","updatedAt":"1"}"#,
        )
        .unwrap();
        fs::write(
            project.join("game/config/asset-metadata.json"),
            r#"{"aliases":{}}"#,
        )
        .unwrap();

        let characters_before = json(serde_json::json!({"version": 1, "characters": []}));
        let characters_after =
            json(serde_json::json!({"version": 1, "characters": [{"id":"hero","name":"Hero"}]}));
        let memory_before = json(
            serde_json::json!({"worldSetting":"old","writingStyle":"","userPreferences":"","updatedAt":"1"}),
        );
        let memory_after = json(
            serde_json::json!({"worldSetting":"new","writingStyle":"","userPreferences":"","updatedAt":"2"}),
        );
        let metadata_before = json(serde_json::json!({"aliases": {}}));
        let metadata_after = json(serde_json::json!({"aliases": {"background/park.webp":"Park"}}));
        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![
                ChangeSetOperation::Scene {
                    file: "start.txt".into(),
                    baseline: "before".into(),
                    content: "after".into(),
                },
                ChangeSetOperation::Characters {
                    baseline: characters_before,
                    document: characters_after.clone(),
                },
                ChangeSetOperation::ProjectMemory {
                    baseline: memory_before,
                    memory: memory_after.clone(),
                },
                ChangeSetOperation::AssetMetadata {
                    baseline: metadata_before,
                    metadata: metadata_after.clone(),
                },
            ],
        });

        assert!(matches!(result, ApplyChangeSetResult::Committed { .. }));
        assert_eq!(
            fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            "after"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(project.join("game/config/characters.json")).unwrap()
            )
            .unwrap(),
            characters_after
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(project.join("game/ai-memory.json")).unwrap()
            )
            .unwrap(),
            memory_after
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(project.join("game/config/asset-metadata.json")).unwrap()
            )
            .unwrap(),
            metadata_after
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn change_set_commit_single_scene_succeeds() {
        let project = temp_project("single_scene");
        let scene = project.join("game/scene/start.txt");
        fs::write(&scene, "Alice:before;\n").unwrap();

        let result = apply_change_set(ApplyChangeSetRequest {
            project_path: project.to_string_lossy().into_owned(),
            operations: vec![ChangeSetOperation::Scene {
                file: "start.txt".into(),
                baseline: "Alice:before;\n".into(),
                content: "Alice:after;\n".into(),
            }],
        });

        assert_eq!(
            result,
            ApplyChangeSetResult::Committed {
                resources: vec![ResourceId::Scene {
                    file: "start.txt".into()
                }]
            }
        );
        assert_eq!(fs::read_to_string(scene).unwrap(), "Alice:after;\n");
        fs::remove_dir_all(project).unwrap();
    }
}
