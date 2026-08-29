use crate::assets::commands::SceneAssetCard;
use crate::characters::types::Character;
use crate::webgal::project::ProjectMemory;
use crate::webgal::types::CommandType;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangeSetRequest {
    pub project_path: String,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub current_scene: Option<CurrentSceneState>,
    pub edits: Vec<ChangeSetEdit>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentSceneState {
    pub file: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChangeSetEdit {
    Scene {
        file: String,
        before_content: String,
        after_content: String,
    },
    CreateScene {
        file: String,
        chapter: Option<String>,
        outline: Option<String>,
        initial_content: Option<String>,
    },
    Character {
        before: Box<Character>,
        after: Box<Character>,
    },
    CreateCharacter {
        draft: Box<Character>,
    },
    Memory {
        before: ProjectMemory,
        after: ProjectMemory,
    },
    AssetPlan {
        cards: Vec<PlannedAssetCard>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedAssetCard {
    pub category: PlannedAssetCategory,
    #[serde(flatten)]
    pub card: SceneAssetCard,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlannedAssetCategory {
    Background,
    Cg,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ApplyChangeSetResult {
    Applied,
    Conflict {
        resources: Vec<String>,
    },
    Failed {
        resource: String,
        message: String,
        recovery: RecoveryStatus,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RecoveryStatus {
    NotNeeded,
    Restored,
    Failed {
        message: String,
        snapshot_id: String,
    },
}

#[tauri::command]
pub fn apply_ai_change_set(request: ApplyChangeSetRequest) -> ApplyChangeSetResult {
    let project_path = PathBuf::from(&request.project_path);
    crate::project_lock::with_project_lock(&project_path, || Ok::<_, String>(apply_locked(request)))
        .unwrap_or_else(|message| failed_without_writes("project recovery", message))
}

fn apply_locked(request: ApplyChangeSetRequest) -> ApplyChangeSetResult {
    if !Path::new(&request.project_path).join("game").is_dir() {
        return failed_without_writes(
            "project",
            format!("项目目录无效：{}/game 不存在", request.project_path),
        );
    }

    let project_path = Path::new(&request.project_path);
    if let Err(message) = crate::flow_edit_lock::ensure_editable(
        project_path,
        crate::flow_edit_lock::FlowResource::StoryPlan,
    ) {
        return failed_without_writes("flow_lock", message);
    }
    if request.edits.iter().any(|edit| {
        matches!(
            edit,
            ChangeSetEdit::Character { .. } | ChangeSetEdit::CreateCharacter { .. }
        )
    }) {
        if let Err(message) = crate::flow_edit_lock::ensure_editable(
            project_path,
            crate::flow_edit_lock::FlowResource::Characters,
        ) {
            return failed_without_writes("flow_lock", message);
        }
    }

    if !request.force {
        match detect_conflicts(&request) {
            Ok(resources) if !resources.is_empty() => {
                return ApplyChangeSetResult::Conflict { resources }
            }
            Ok(_) => {}
            Err((resource, message)) => return failed_without_writes(&resource, message),
        }
    }

    let snapshot = match crate::webgal::project::create_project_snapshot_locked(
        &request.project_path,
        Some("AI change set rollback".to_string()),
        Some("auto".to_string()),
        Some("Rollback point for one AI change-set commit".to_string()),
    ) {
        Ok(snapshot) => snapshot,
        Err(message) => return failed_without_writes("snapshot", message),
    };

    for edit in &request.edits {
        let resource = edit_resource(edit);
        if let Err(message) =
            injected_apply_failure(resource).and_then(|_| apply_edit(&request.project_path, edit))
        {
            let (recovery, may_delete_snapshot) =
                match restore_after_failure(&request.project_path, &snapshot.id) {
                    Ok(()) => (RecoveryStatus::Restored, true),
                    Err(message) => (
                        RecoveryStatus::Failed {
                            message,
                            snapshot_id: snapshot.id.clone(),
                        },
                        false,
                    ),
                };
            if may_delete_snapshot {
                let _ = crate::webgal::project::delete_project_snapshot_locked(
                    &request.project_path,
                    &snapshot.id,
                );
            }
            return ApplyChangeSetResult::Failed {
                resource: resource.to_string(),
                message,
                recovery,
            };
        }
    }

    let _ =
        crate::webgal::project::delete_project_snapshot_locked(&request.project_path, &snapshot.id);
    ApplyChangeSetResult::Applied
}

fn failed_without_writes(resource: &str, message: String) -> ApplyChangeSetResult {
    ApplyChangeSetResult::Failed {
        resource: resource.to_string(),
        message,
        recovery: RecoveryStatus::NotNeeded,
    }
}

fn scene_path(project_path: &str, file: &str) -> Result<PathBuf, String> {
    let path = Path::new(file);
    if path.file_name().and_then(|name| name.to_str()) != Some(file)
        || !file.to_ascii_lowercase().ends_with(".txt")
    {
        return Err(format!("场景文件名无效：{file}"));
    }
    Ok(Path::new(project_path).join("game/scene").join(file))
}

fn same_json<T: Serialize>(left: &T, right: &T) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

fn detect_conflicts(request: &ApplyChangeSetRequest) -> Result<Vec<String>, (String, String)> {
    let characters = crate::characters::commands::list_characters_locked(&request.project_path)
        .map_err(|message| ("characters".to_string(), message))?;
    let memory = crate::webgal::project::read_project_memory_locked(&request.project_path)
        .map_err(|message| ("memory".to_string(), message))?;
    let metadata = crate::assets::commands::read_asset_metadata(&request.project_path)
        .map_err(|message| ("asset_metadata".to_string(), message))?;
    let mut conflicts = Vec::new();

    for edit in &request.edits {
        match edit {
            ChangeSetEdit::Scene {
                file,
                before_content,
                ..
            } => {
                let path = scene_path(&request.project_path, file)
                    .map_err(|message| (format!("scene:{file}"), message))?;
                let disk_content = crate::json_store::read_to_string_recovering(&path)
                    .map_err(|error| error.to_string())
                    .map_err(|message| (format!("scene:{file}"), message))?;
                let buffer_changed = request
                    .current_scene
                    .as_ref()
                    .filter(|scene| scene.file == *file)
                    .is_some_and(|scene| scene.content != *before_content);
                if disk_content != *before_content || buffer_changed {
                    conflicts.push(format!("scene:{file}"));
                }
            }
            ChangeSetEdit::CreateScene { file, .. } => {
                let path = scene_path(&request.project_path, file)
                    .map_err(|message| (format!("scene:{file}"), message))?;
                if path.exists() {
                    conflicts.push(format!("scene:{file}"));
                }
            }
            ChangeSetEdit::Character { before, .. } => {
                if characters
                    .iter()
                    .find(|character| character.id == before.id)
                    .is_none_or(|current| !same_json(current, before.as_ref()))
                {
                    conflicts.push(format!("character:{}", before.id));
                }
            }
            ChangeSetEdit::CreateCharacter { draft } => {
                let name = draft.name.trim().to_lowercase();
                if characters
                    .iter()
                    .any(|character| character.name.trim().to_lowercase() == name)
                {
                    conflicts.push(format!("character:{}", draft.name));
                }
            }
            ChangeSetEdit::Memory { before, .. } => {
                let missing_matches_empty = memory.is_none()
                    && before.world_setting.is_empty()
                    && before.writing_style.is_empty()
                    && before.user_preferences.is_empty();
                if !missing_matches_empty
                    && memory
                        .as_ref()
                        .is_none_or(|current| !same_json(current, before))
                {
                    conflicts.push("memory".to_string());
                }
            }
            ChangeSetEdit::AssetPlan { cards } => {
                for planned in cards {
                    let existing = match planned.category {
                        PlannedAssetCategory::Background => metadata.scene_cards.values(),
                        PlannedAssetCategory::Cg => metadata.cg_cards.values(),
                    };
                    if existing.into_iter().any(|card| {
                        card.id.eq_ignore_ascii_case(&planned.card.id)
                            || card
                                .target_stem
                                .eq_ignore_ascii_case(&planned.card.target_stem)
                    }) {
                        conflicts.push(format!("asset:{}", planned.card.id));
                    }
                }
            }
        }
    }
    Ok(conflicts)
}

fn edit_resource(edit: &ChangeSetEdit) -> &'static str {
    match edit {
        ChangeSetEdit::Scene { .. } | ChangeSetEdit::CreateScene { .. } => "scene",
        ChangeSetEdit::Character { .. } | ChangeSetEdit::CreateCharacter { .. } => "character",
        ChangeSetEdit::Memory { .. } => "memory",
        ChangeSetEdit::AssetPlan { .. } => "asset_metadata",
    }
}

fn apply_edit(project_path: &str, edit: &ChangeSetEdit) -> Result<(), String> {
    match edit {
        ChangeSetEdit::Scene {
            file,
            after_content,
            ..
        } => {
            let path = scene_path(project_path, file)?;
            crate::json_store::write_crash_safe(&path, after_content.as_bytes())
                .map_err(|error| format!("写入场景 {file} 失败：{error}"))?;
            sync_scene_background_cards(project_path, file, after_content)
        }
        ChangeSetEdit::CreateScene {
            file,
            chapter,
            outline,
            initial_content,
        } => {
            let path = scene_path(project_path, file)?;
            if path.exists() {
                return Err(format!("场景 {file} 已存在"));
            }
            let mut content = String::new();
            if let Some(chapter) = chapter
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                content.push_str(&format!("; 章节: {chapter}\n"));
            }
            if let Some(outline) = outline
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                content.push_str(&format!("; 大纲: {outline}\n"));
            }
            content.push_str(initial_content.as_deref().unwrap_or(""));
            if content.is_empty() {
                content = format!("; {file}\n");
            }
            crate::json_store::write_crash_safe(&path, content.as_bytes())
                .map_err(|error| format!("创建场景 {file} 失败：{error}"))?;
            sync_scene_background_cards(project_path, file, &content)
        }
        ChangeSetEdit::Character { after, .. } => {
            crate::characters::commands::update_character_locked(project_path, *after.clone())
                .map(|_| ())
        }
        ChangeSetEdit::CreateCharacter { draft } => {
            crate::characters::commands::create_character_locked(project_path, *draft.clone())
                .map(|_| ())
        }
        ChangeSetEdit::Memory { after, .. } => {
            crate::webgal::project::save_project_memory_locked(project_path, after.clone())
        }
        ChangeSetEdit::AssetPlan { cards } => {
            let mut metadata = crate::assets::commands::read_asset_metadata(project_path)?;
            for planned in cards {
                match planned.category {
                    PlannedAssetCategory::Background => {
                        let mut card = planned.card.clone();
                        if let Some(existing) = metadata.scene_cards.get(&card.id) {
                            card.image_asset = existing.image_asset.clone().or(card.image_asset);
                        }
                        metadata.scene_cards.insert(card.id.clone(), card);
                    }
                    PlannedAssetCategory::Cg => {
                        let mut card = planned.card.clone();
                        if let Some(existing) = metadata.cg_cards.get(&card.id) {
                            card.image_asset = existing.image_asset.clone().or(card.image_asset);
                        }
                        metadata.cg_cards.insert(card.id.clone(), card);
                    }
                }
            }
            crate::assets::commands::write_asset_metadata(project_path, &metadata)
        }
    }
}

fn sync_scene_background_cards(
    project_path: &str,
    scene_file: &str,
    source: &str,
) -> Result<(), String> {
    let backgrounds = crate::webgal::parser::parse_script(source)
        .into_iter()
        .filter(|node| node.cmd_type == CommandType::ChangeBg)
        .filter_map(|node| node.asset.or(Some(node.content)))
        .map(|asset| asset.trim().to_string())
        .filter(|asset| !asset.is_empty() && asset != "none")
        .collect::<std::collections::HashSet<_>>();
    if backgrounds.is_empty() {
        return Ok(());
    }

    let mut metadata = crate::assets::commands::read_asset_metadata(project_path)?;
    let mut changed = false;
    for filename in backgrounds {
        let id = format!(
            "bg:{}",
            filename
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() || "._-".contains(character) {
                        character
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        );
        if metadata.deleted_scene_cards.contains(&id) {
            continue;
        }
        let available = Path::new(&filename)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == filename)
            && Path::new(project_path)
                .join("game/background")
                .join(&filename)
                .is_file();
        let image_asset = available.then(|| filename.clone());
        let target_stem = [".png", ".jpg", ".jpeg", ".webp", ".gif"]
            .iter()
            .find_map(|extension| {
                filename
                    .to_ascii_lowercase()
                    .ends_with(extension)
                    .then(|| filename[..filename.len() - extension.len()].to_string())
            })
            .unwrap_or_else(|| filename.clone());
        if let Some(existing) = metadata.scene_cards.get_mut(&id) {
            if existing.image_asset != image_asset {
                existing.image_asset = image_asset;
                changed = true;
            }
        } else {
            metadata.scene_cards.insert(
                id.clone(),
                SceneAssetCard {
                    id,
                    title: target_stem.clone(),
                    scene_file: Some(scene_file.to_string()),
                    image_asset,
                    target_stem,
                    prompt: String::new(),
                    style: String::new(),
                    negative_prompt: String::new(),
                },
            );
            changed = true;
        }
    }
    if changed {
        crate::assets::commands::write_asset_metadata(project_path, &metadata)?;
    }
    Ok(())
}

fn restore_after_failure(project_path: &str, snapshot_id: &str) -> Result<(), String> {
    injected_restore_failure()?;
    crate::webgal::project::restore_project_snapshot_locked(project_path, snapshot_id)
}

#[cfg(test)]
thread_local! {
    static APPLY_FAILURE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static RESTORE_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn inject_apply_failure_for_test(resource: &str) {
    APPLY_FAILURE.with(|failure| *failure.borrow_mut() = Some(resource.to_string()));
}

#[cfg(test)]
fn inject_restore_failure_for_test() {
    RESTORE_FAILURE.with(|failure| failure.set(true));
}

#[cfg(test)]
fn injected_apply_failure(resource: &str) -> Result<(), String> {
    APPLY_FAILURE.with(|failure| {
        if failure.borrow().as_deref() == Some(resource) {
            failure.borrow_mut().take();
            Err(format!("injected {resource} write failure"))
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
fn injected_apply_failure(_resource: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn injected_restore_failure() -> Result<(), String> {
    RESTORE_FAILURE.with(|failure| {
        if failure.replace(false) {
            Err("injected snapshot restore failure".to_string())
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
fn injected_restore_failure() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::commands::{read_asset_metadata, write_asset_metadata, AssetMetadata};
    use crate::characters::commands::{list_characters, save_characters};
    use crate::characters::types::Character;
    use crate::webgal::project::{read_project_memory, save_project_memory};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    fn project_dir(label: &str) -> String {
        let path = std::env::temp_dir().join(format!(
            "ollaic_change_set_{label}_{}_{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(path.join("game/scene")).unwrap();
        fs::create_dir_all(path.join("game/config")).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn character(id: &str, name: &str) -> Character {
        Character {
            id: id.to_string(),
            name: name.to_string(),
            aliases: Vec::new(),
            description: String::new(),
            personality: String::new(),
            reference_images: Vec::new(),
            stance: String::new(),
            keywords: Vec::new(),
            dialogue_style: String::new(),
            gender: String::new(),
            age: String::new(),
            sprites: Vec::new(),
            default_voice: None,
            voice_timbre: None,
            relations: Vec::new(),
            color_theme: None,
            notes: String::new(),
        }
    }

    fn memory(world: &str) -> ProjectMemory {
        ProjectMemory {
            world_setting: world.to_string(),
            writing_style: String::new(),
            user_preferences: String::new(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn later_resource_failure_restores_scene_asset_metadata_character_and_memory() {
        let project = project_dir("cross_resource_rollback");
        let scene_path = std::path::Path::new(&project).join("game/scene/start.txt");
        fs::write(&scene_path, "old scene").unwrap();
        save_characters(project.clone(), vec![character("hero", "Old Hero")]).unwrap();
        save_project_memory(project.clone(), memory("old world")).unwrap();
        write_asset_metadata(&project, &AssetMetadata::default()).unwrap();

        inject_apply_failure_for_test("memory");
        let result = apply_ai_change_set(ApplyChangeSetRequest {
            project_path: project.clone(),
            force: false,
            current_scene: None,
            edits: vec![
                ChangeSetEdit::Scene {
                    file: "start.txt".to_string(),
                    before_content: "old scene".to_string(),
                    after_content: "new scene".to_string(),
                },
                ChangeSetEdit::AssetPlan {
                    cards: vec![PlannedAssetCard {
                        category: PlannedAssetCategory::Background,
                        card: SceneAssetCard {
                            id: "scene:start:bg".to_string(),
                            title: "New background".to_string(),
                            ..Default::default()
                        },
                    }],
                },
                ChangeSetEdit::Character {
                    before: Box::new(character("hero", "Old Hero")),
                    after: Box::new(character("hero", "New Hero")),
                },
                ChangeSetEdit::Memory {
                    before: memory("old world"),
                    after: memory("new world"),
                },
            ],
        });

        assert!(matches!(
            result,
            ApplyChangeSetResult::Failed {
                recovery: RecoveryStatus::Restored,
                ..
            }
        ));
        assert_eq!(fs::read_to_string(&scene_path).unwrap(), "old scene");
        assert!(read_asset_metadata(&project)
            .unwrap()
            .scene_cards
            .is_empty());
        assert_eq!(
            list_characters(project.clone()).unwrap()[0].name,
            "Old Hero"
        );
        assert_eq!(
            read_project_memory(project.clone())
                .unwrap()
                .unwrap()
                .world_setting,
            "old world"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn rollback_failure_is_reported_and_keeps_the_snapshot_for_manual_recovery() {
        let project = project_dir("rollback_failure");
        let scene_path = std::path::Path::new(&project).join("game/scene/start.txt");
        fs::write(&scene_path, "old scene").unwrap();
        save_project_memory(project.clone(), memory("old world")).unwrap();

        inject_apply_failure_for_test("memory");
        inject_restore_failure_for_test();
        let result = apply_ai_change_set(ApplyChangeSetRequest {
            project_path: project.clone(),
            force: false,
            current_scene: None,
            edits: vec![
                ChangeSetEdit::Scene {
                    file: "start.txt".to_string(),
                    before_content: "old scene".to_string(),
                    after_content: "new scene".to_string(),
                },
                ChangeSetEdit::Memory {
                    before: memory("old world"),
                    after: memory("new world"),
                },
            ],
        });

        let snapshot_id = match result {
            ApplyChangeSetResult::Failed {
                resource,
                recovery:
                    RecoveryStatus::Failed {
                        message,
                        snapshot_id,
                    },
                ..
            } => {
                assert_eq!(resource, "memory");
                assert!(message.contains("restore failure"));
                snapshot_id
            }
            other => panic!("expected explicit recovery failure, got {other:?}"),
        };
        assert_eq!(fs::read_to_string(&scene_path).unwrap(), "new scene");
        assert!(std::path::Path::new(&project)
            .join(".webgal-editor/snapshots")
            .join(snapshot_id)
            .is_dir());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn conflict_is_reported_before_snapshot_or_write() {
        let project = project_dir("conflict_before_write");
        let scene_path = std::path::Path::new(&project).join("game/scene/start.txt");
        fs::write(&scene_path, "old scene").unwrap();

        let result = apply_ai_change_set(ApplyChangeSetRequest {
            project_path: project.clone(),
            force: false,
            current_scene: Some(CurrentSceneState {
                file: "start.txt".to_string(),
                content: "manual edit after preview".to_string(),
            }),
            edits: vec![ChangeSetEdit::Scene {
                file: "start.txt".to_string(),
                before_content: "old scene".to_string(),
                after_content: "AI scene".to_string(),
            }],
        });

        assert!(matches!(
            result,
            ApplyChangeSetResult::Conflict { resources }
                if resources == vec!["scene:start.txt".to_string()]
        ));
        assert_eq!(fs::read_to_string(&scene_path).unwrap(), "old scene");
        assert!(!std::path::Path::new(&project)
            .join(".webgal-editor/snapshots")
            .exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disk_change_is_not_hidden_by_a_stale_current_scene_buffer() {
        let project = project_dir("disk_conflict_with_stale_buffer");
        let scene_path = std::path::Path::new(&project).join("game/scene/start.txt");
        fs::write(&scene_path, "external edit after preview").unwrap();

        let result = apply_ai_change_set(ApplyChangeSetRequest {
            project_path: project.clone(),
            force: false,
            current_scene: Some(CurrentSceneState {
                file: "start.txt".to_string(),
                content: "old scene".to_string(),
            }),
            edits: vec![ChangeSetEdit::Scene {
                file: "start.txt".to_string(),
                before_content: "old scene".to_string(),
                after_content: "AI scene".to_string(),
            }],
        });

        assert!(matches!(
            result,
            ApplyChangeSetResult::Conflict { resources }
                if resources == vec!["scene:start.txt".to_string()]
        ));
        assert_eq!(
            fs::read_to_string(&scene_path).unwrap(),
            "external edit after preview"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn active_flow_scopes_reject_change_sets_before_snapshot_or_write() {
        let project = project_dir("flow_scope_rejects_change_set");
        let scene_path = std::path::Path::new(&project).join("game/scene/start.txt");
        fs::write(&scene_path, "old scene").unwrap();
        save_characters(project.clone(), vec![character("hero", "Old Hero")]).unwrap();

        let story_guard = crate::flow_edit_lock::FlowEditGuard::acquire(
            std::path::Path::new(&project),
            &[crate::flow_edit_lock::FlowResource::StoryPlan],
        )
        .unwrap();
        let scene_result = apply_ai_change_set(ApplyChangeSetRequest {
            project_path: project.clone(),
            force: true,
            current_scene: None,
            edits: vec![ChangeSetEdit::Scene {
                file: "start.txt".to_string(),
                before_content: "old scene".to_string(),
                after_content: "new scene".to_string(),
            }],
        });
        assert!(matches!(
            scene_result,
            ApplyChangeSetResult::Failed {
                resource,
                recovery: RecoveryStatus::NotNeeded,
                ..
            } if resource == "flow_lock"
        ));
        assert_eq!(fs::read_to_string(&scene_path).unwrap(), "old scene");
        assert!(!std::path::Path::new(&project)
            .join(".webgal-editor/snapshots")
            .exists());
        drop(story_guard);

        let character_guard = crate::flow_edit_lock::FlowEditGuard::acquire(
            std::path::Path::new(&project),
            &[crate::flow_edit_lock::FlowResource::Characters],
        )
        .unwrap();
        let character_result = apply_ai_change_set(ApplyChangeSetRequest {
            project_path: project.clone(),
            force: true,
            current_scene: None,
            edits: vec![ChangeSetEdit::Character {
                before: Box::new(character("hero", "Old Hero")),
                after: Box::new(character("hero", "New Hero")),
            }],
        });
        assert!(matches!(
            character_result,
            ApplyChangeSetResult::Failed {
                resource,
                recovery: RecoveryStatus::NotNeeded,
                ..
            } if resource == "flow_lock"
        ));
        assert_eq!(
            list_characters(project.clone()).unwrap()[0].name,
            "Old Hero"
        );
        drop(character_guard);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn request_and_recovery_json_match_the_frontend_contract() {
        let request: ApplyChangeSetRequest = serde_json::from_value(serde_json::json!({
            "projectPath": "/projects/story",
            "force": true,
            "currentScene": { "file": "start.txt", "content": "manual" },
            "edits": [{
                "kind": "scene",
                "file": "start.txt",
                "beforeContent": "old",
                "afterContent": "new"
            }]
        }))
        .unwrap();
        assert!(request.force);
        assert!(matches!(
            &request.edits[0],
            ChangeSetEdit::Scene {
                before_content,
                after_content,
                ..
            } if before_content == "old" && after_content == "new"
        ));

        let recovery = serde_json::to_value(RecoveryStatus::Failed {
            message: "permission denied".to_string(),
            snapshot_id: "rollback-123".to_string(),
        })
        .unwrap();
        assert_eq!(recovery["status"], "failed");
        assert_eq!(recovery["snapshotId"], "rollback-123");
        assert!(recovery.get("snapshot_id").is_none());
    }
}
