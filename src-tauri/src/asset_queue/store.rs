use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{AssetKind, AssetQueue, AssetTask, AssetTaskStatus};
use crate::story_plan::types::StoryPlan;

pub fn queue_path(project_path: &Path) -> PathBuf {
    project_path.join(".ollaic/assets/queue.json")
}

pub fn load_queue(project_path: &Path) -> Result<AssetQueue, String> {
    let path = queue_path(project_path);
    let candidates = crate::json_store::read_candidates(&path)
        .map_err(|error| format!("failed to read asset queue {}: {error}", path.display()))?;
    if candidates.is_empty() {
        return Ok(AssetQueue::new("", Vec::new(), 0));
    }
    let mut last_error = String::new();
    for source in candidates {
        match parse_queue(&source) {
            Ok(queue) => return Ok(queue),
            Err(error) => last_error = error,
        }
    }
    Err(format!(
        "failed to parse asset queue {}: {}",
        path.display(),
        last_error
    ))
}

pub fn save_queue(project_path: &Path, queue: &AssetQueue) -> Result<(), String> {
    validate_queue(queue)?;
    let path = queue_path(project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create asset queue directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(queue).map_err(|error| error.to_string())?;
    crate::json_store::write_crash_safe(&path, &bytes)
        .map_err(|error| format!("failed to write asset queue {}: {error}", path.display()))
}

fn parse_queue(source: &str) -> Result<AssetQueue, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(source).map_err(|error| format!("invalid JSON: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "$: must be an object".to_string())?;
    object
        .entry("version")
        .or_insert(serde_json::Value::from(1));
    let queue: AssetQueue = serde_json::from_value(value)
        .map_err(|error| format!("queue schema violation: {error}"))?;
    validate_queue(&queue)?;
    Ok(queue)
}

fn validate_queue(queue: &AssetQueue) -> Result<(), String> {
    if queue.version != 1 {
        return Err(format!(
            "$.version: unsupported AssetQueue version {} (expected 1)",
            queue.version
        ));
    }
    if !queue.tasks.is_empty() && queue.run_id.trim().is_empty() {
        return Err("$.runId: must not be empty when tasks exist".to_string());
    }
    for (field, value) in [
        ("image", queue.limits.image),
        ("tts", queue.limits.tts),
        // `music` is a legacy persisted key; it limits manual BGM/SFX tasks.
        ("music", queue.limits.music),
    ] {
        if value == 0 {
            return Err(format!("$.limits.{field}: must be greater than zero"));
        }
    }
    let mut ids = HashSet::new();
    for (index, task) in queue.tasks.iter().enumerate() {
        let path = format!("$.tasks[{index}]");
        if !is_safe_token(&task.id) || !ids.insert(task.id.as_str()) {
            return Err(format!("{path}.id: must be a unique safe id"));
        }
        if !is_safe_token(&task.target_stem) {
            return Err(format!("{path}.targetStem: must be a safe filename stem"));
        }
        if task.prompt.trim().is_empty() {
            return Err(format!("{path}.prompt: must not be empty"));
        }
        if task.kind == AssetKind::Figure {
            if task.character_ref.as_deref().is_none_or(str::is_empty) {
                return Err(format!("{path}.characterRef: required for figure tasks"));
            }
            if !task.emotion.as_deref().is_some_and(is_safe_token) {
                return Err(format!(
                    "{path}.emotion: required and must be safe for figure tasks"
                ));
            }
        } else if task.emotion.is_some() {
            return Err(format!("{path}.emotion: only allowed for figure tasks"));
        }
        if task.kind == AssetKind::Tts {
            if task.scene_ref.as_deref().is_none_or(str::is_empty) {
                return Err(format!("{path}.sceneRef: required for TTS tasks"));
            }
            if task.dialogue_index.is_none() {
                return Err(format!("{path}.dialogueIndex: required for TTS tasks"));
            }
            if task.text.as_deref().is_none_or(str::is_empty) {
                return Err(format!("{path}.text: required for TTS tasks"));
            }
        }
    }
    Ok(())
}

fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

/// Build executable tasks from explicit planner output.
pub fn derive_queue(
    _project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
) -> Result<AssetQueue, String> {
    let scene_files_by_ref: HashMap<&str, &str> = plan
        .scene_plans
        .iter()
        .map(|scene| (scene.id.as_str(), scene.file.as_str()))
        .collect();
    let entry_scene = scene_files_by_ref
        .get(plan.branches.entry_scene.as_str())
        .copied();
    let mut ids = HashSet::new();
    let mut tasks = Vec::new();
    for (index, task_plan) in plan.asset_plan.iter().enumerate() {
        let kind = AssetKind::from_plan(&task_plan.kind)
            .ok_or_else(|| format!("unsupported asset kind: {}", task_plan.kind))?;
        if !ids.insert(task_plan.id.clone()) {
            return Err(format!("duplicate asset task id: {}", task_plan.id));
        }
        if let Some(scene) = task_plan.scene_ref.as_deref() {
            if !scene_files_by_ref.contains_key(scene) {
                return Err(format!(
                    "$.assetPlan[{index}].sceneRef: references unknown scene: {scene}"
                ));
            }
        }
        tasks.push(AssetTask {
            id: task_plan.id.clone(),
            kind,
            target_stem: task_plan.target_stem.clone(),
            prompt: task_plan.prompt.clone(),
            scene_ref: task_plan
                .scene_ref
                .as_deref()
                .and_then(|scene| scene_files_by_ref.get(scene).copied())
                .or_else(|| {
                    matches!(kind, AssetKind::Bgm | AssetKind::Sfx)
                        .then_some(entry_scene)
                        .flatten()
                })
                .map(str::to_string),
            character_ref: task_plan.character_ref.clone(),
            emotion: task_plan
                .emotion
                .clone()
                .or_else(|| (kind == AssetKind::Figure).then(|| "default".to_string())),
            dialogue_index: None,
            text: None,
            status: AssetTaskStatus::Pending,
            attempts: Vec::new(),
            asset_file: None,
            error: None,
            used_local_fallback: false,
        });
    }

    Ok(AssetQueue::new(run_id, tasks, now_ms()))
}

/// Rebuild from the current plan and scenes, retaining runtime state only when
/// every generation and binding input still matches.
pub fn rederive_queue(
    project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
    existing: &AssetQueue,
) -> Result<AssetQueue, String> {
    let mut fresh = derive_queue(project_path, run_id, plan)?;
    let existing_by_id: HashMap<&str, &AssetTask> = existing
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    for task in &mut fresh.tasks {
        if let Some(previous) = existing_by_id
            .get(task.id.as_str())
            .filter(|previous| same_task_semantics(task, previous))
        {
            let normalized_emotion = task.emotion.clone();
            *task = (*previous).clone();
            task.emotion = normalized_emotion;
        }
    }
    fresh.limits = existing.limits;
    Ok(fresh)
}

fn same_task_semantics(left: &AssetTask, right: &AssetTask) -> bool {
    left.id == right.id
        && left.kind == right.kind
        && left.target_stem == right.target_stem
        && left.prompt == right.prompt
        && left.scene_ref == right.scene_ref
        && left.character_ref == right.character_ref
        && normalized_emotion(left) == normalized_emotion(right)
        && left.dialogue_index == right.dialogue_index
        && left.text == right.text
}

fn normalized_emotion(task: &AssetTask) -> Option<&str> {
    if task.kind == AssetKind::Figure {
        Some(task.emotion.as_deref().unwrap_or("default"))
    } else {
        task.emotion.as_deref()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_queue::types::QueueLimits;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ollaic_asset_queue_{name}_{nonce}"));
        fs::create_dir_all(path.join("game/scene")).unwrap();
        path
    }

    #[test]
    fn does_not_derive_voice_tasks_without_explicit_coverage() {
        let project = temp_project("derive");
        fs::write(
            project.join("game/scene/start.txt"),
            "Alice:Hello;\n:Narration;\nBob:Already voiced -old.wav;\n",
        )
        .unwrap();
        let plan = StoryPlan {
            scenes: vec!["start.txt".into()],
            ..StoryPlan::new("test")
        };
        let queue = derive_queue(&project, "run-1", &plan).unwrap();
        assert!(queue.tasks.is_empty());
        assert_eq!(queue.limits.tts, 4);
        assert_eq!(queue.run_id, "run-1");
        save_queue(&project, &queue).unwrap();
        assert_eq!(load_queue(&project).unwrap(), queue);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn loads_legacy_queue_without_version_limits_or_status() {
        let project = temp_project("legacy_queue");
        let path = queue_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{
            "runId":"run-old",
            "updatedAt":1,
            "tasks":[{
                "id":"bg_opening",
                "kind":"background",
                "targetStem":"bg_opening",
                "prompt":"room"
            }]
        }"#,
        )
        .unwrap();
        let queue = load_queue(&project).unwrap();
        assert_eq!(queue.version, 1);
        assert_eq!(queue.limits, QueueLimits::default());
        assert_eq!(queue.tasks[0].status, AssetTaskStatus::Pending);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn rejects_unknown_queue_version_with_field_path() {
        let project = temp_project("future_queue");
        let path = queue_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"version":2,"runId":"run","updatedAt":1,"tasks":[]}"#,
        )
        .unwrap();
        let error = load_queue(&project).unwrap_err();
        assert!(error.contains("$.version"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn rejects_duplicate_queue_task_id_with_field_path() {
        let project = temp_project("duplicate_queue_task");
        let path = queue_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{
            "version":1,"runId":"run","updatedAt":1,
            "tasks":[
                {"id":"same","kind":"background","targetStem":"a","prompt":"a","status":"pending"},
                {"id":"same","kind":"background","targetStem":"b","prompt":"b","status":"pending"}
            ]
        }"#,
        )
        .unwrap();
        let error = load_queue(&project).unwrap_err();
        assert!(error.contains("$.tasks[1].id"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derive_rejects_unknown_plan_scene_reference_with_field_path() {
        let project = temp_project("unknown_plan_scene_ref");
        let plan = StoryPlan {
            asset_plan: vec![crate::story_plan::AssetTaskPlan {
                id: "bg_missing".into(),
                kind: "background".into(),
                target_stem: "bg_missing".into(),
                prompt: "Missing".into(),
                scene_ref: Some("missing".into()),
                character_ref: None,
                emotion: None,
                status: "pending".into(),
            }],
            scenes: vec!["start.txt".into()],
            ..StoryPlan::new("brief")
        };
        let error = derive_queue(&project, "run", &plan).unwrap_err();
        assert!(error.contains("$.assetPlan[0].sceneRef"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn maps_scene_ids_for_explicit_asset_tasks() {
        let project = temp_project("mapping");
        fs::write(project.join("game/scene/start.txt"), "Alice:Hello;\n").unwrap();
        let plan: StoryPlan = serde_json::from_value(serde_json::json!({
            "version": 1,
            "prompt": "test",
            "scenePlans": [{
                "id": "opening", "file": "start.txt", "chapterId": "ch1", "title": "Opening"
            }],
            "branches": { "entryScene": "opening", "edges": [] },
            "characters": [{
                "id": "alice", "name": "Alice", "voiceTimbre": "voice-42"
            }],
            "assetPlan": [{
                "id": "bg_opening", "kind": "background", "targetStem": "bg_opening",
                "prompt": "room", "sceneRef": "opening", "status": "pending"
            }, {
                "id": "bgm_main", "kind": "bgm", "targetStem": "bgm_main",
                "prompt": "theme", "status": "pending"
            }],
            "scenes": ["start.txt"]
        }))
        .unwrap();
        let queue = derive_queue(&project, "run-2", &plan).unwrap();
        assert_eq!(queue.tasks[0].scene_ref.as_deref(), Some("start.txt"));
        assert_eq!(queue.tasks[1].scene_ref.as_deref(), Some("start.txt"));
        assert_eq!(queue.tasks.len(), 2);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn legacy_figure_without_emotion_derives_as_default() {
        let project = temp_project("legacy_figure_emotion");
        let plan: StoryPlan = serde_json::from_value(serde_json::json!({
            "version": 1,
            "prompt": "test",
            "characters": [{"id": "alice", "name": "Alice"}],
            "assetPlan": [{
                "id": "figure_alice", "kind": "figure", "targetStem": "alice_default",
                "prompt": "Alice", "characterRef": "alice", "status": "pending"
            }]
        }))
        .unwrap();

        crate::story_plan::validate(&plan).unwrap();
        let mut queue = derive_queue(&project, "run-legacy", &plan).unwrap();
        assert_eq!(queue.tasks[0].emotion.as_deref(), Some("default"));
        queue.tasks[0].emotion = None;
        queue.tasks[0].status = AssetTaskStatus::Succeeded;
        queue.tasks[0].asset_file = Some("alice_default.png".to_string());

        let recovered = rederive_queue(&project, "run-legacy", &plan, &queue).unwrap();
        assert_eq!(recovered.tasks[0].status, AssetTaskStatus::Succeeded);
        assert_eq!(
            recovered.tasks[0].asset_file.as_deref(),
            Some("alice_default.png")
        );
        assert_eq!(recovered.tasks[0].emotion.as_deref(), Some("default"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn rederive_uses_fresh_membership_and_only_retains_identical_tasks() {
        use crate::asset_queue::types::{AssetAttempt, QueueLimits};
        use crate::story_plan::types::AssetTaskPlan;

        fn planned(
            id: &str,
            kind: &str,
            target_stem: &str,
            prompt: &str,
            character_ref: Option<&str>,
        ) -> AssetTaskPlan {
            AssetTaskPlan {
                id: id.into(),
                kind: kind.into(),
                target_stem: target_stem.into(),
                prompt: prompt.into(),
                scene_ref: None,
                character_ref: character_ref.map(str::to_string),
                emotion: (kind == "figure").then(|| "default".to_string()),
                status: "pending".into(),
            }
        }

        let project = temp_project("fresh_authority");
        fs::write(
            project.join("game/scene/start.txt"),
            "Alice:Hello -old.wav;\n",
        )
        .unwrap();
        let mut old_plan = StoryPlan::new("test");
        old_plan.scenes = vec!["start.txt".into()];
        old_plan.asset_plan = vec![
            planned("keep", "background", "keep", "same", None),
            planned("changed_target", "background", "old_target", "same", None),
            planned(
                "changed_prompt",
                "background",
                "same_target",
                "old prompt",
                None,
            ),
            planned("stale", "bgm", "stale", "remove me", None),
        ];
        let mut existing = derive_queue(&project, "run-1", &old_plan).unwrap();
        existing.limits = QueueLimits {
            image: 1,
            tts: 2,
            music: 3,
            max_retries: 5,
        };
        for task in &mut existing.tasks {
            task.status = AssetTaskStatus::Succeeded;
            task.asset_file = Some(format!("{}.png", task.target_stem));
            task.attempts.push(AssetAttempt {
                attempt: 1,
                started_at: 1,
                finished_at: 2,
                artifact: Some(format!("artifact/{}.png", task.id)),
                error: None,
                used_local_fallback: false,
            });
        }
        let kept = existing.tasks[0].clone();

        let mut fresh_plan = old_plan;
        fresh_plan.asset_plan = vec![
            planned("keep", "background", "keep", "same", None),
            planned("changed_target", "background", "new_target", "same", None),
            planned(
                "changed_prompt",
                "background",
                "same_target",
                "new prompt",
                None,
            ),
            planned(
                "new_figure",
                "figure",
                "alice_default",
                "Alice",
                Some("alice"),
            ),
        ];
        let redone = rederive_queue(&project, "run-1", &fresh_plan, &existing).unwrap();

        assert_eq!(redone.limits, existing.limits);
        assert_eq!(
            redone
                .tasks
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>(),
            vec!["keep", "changed_target", "changed_prompt", "new_figure",]
        );
        assert_eq!(
            redone.tasks[0], kept,
            "unchanged succeeded task is retained whole"
        );
        for task in &redone.tasks[1..] {
            assert_eq!(task.status, AssetTaskStatus::Pending);
            assert!(task.attempts.is_empty());
            assert!(task.asset_file.is_none());
        }
        assert_eq!(redone.tasks[1].target_stem, "new_target");
        assert_eq!(redone.tasks[2].prompt, "new prompt");
        assert_eq!(redone.tasks[3].kind, AssetKind::Figure);
        assert!(!redone.tasks.iter().any(|task| task.id == "stale"));
        let _ = fs::remove_dir_all(project);
    }
}
