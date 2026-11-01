use super::*;

#[test]
fn character_output_reconciles_provisional_scene_cast_names() {
    let mut plan = StoryPlan::new("test");
    plan.scene_plans = vec![crate::story_plan::ScenePlan {
        approval_status: Default::default(),
        rolling_summary: None,
        location_id: None,
        time_of_day: None,
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["艾拉".into(), "洛因".into()],
        ..Default::default()
    }];
    let characters = serde_json::from_value(serde_json::json!([
        {"id":"ailla","name":"艾拉"},
        {"id":"luoyin","name":"洛因"}
    ]))
    .unwrap();

    apply_output(
        &mut plan,
        &AgentOutput::new(AgentOutputPayload::Characters(characters)),
    );

    assert_eq!(plan.scene_plans[0].character_ids, vec!["ailla", "luoyin"]);
}

#[test]
fn character_output_reconciles_provisional_id_case() {
    let mut plan = StoryPlan::new("test");
    plan.scene_plans = vec![crate::story_plan::ScenePlan {
        approval_status: Default::default(),
        rolling_summary: None,
        location_id: None,
        time_of_day: None,
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["Erin".into(), "Xiaoqi".into()],
        ..Default::default()
    }];
    let characters = serde_json::from_value(serde_json::json!([
        {"id":"erin","name":"艾琳"},
        {"id":"xiaoqi","name":"小七"}
    ]))
    .unwrap();

    apply_output(
        &mut plan,
        &AgentOutput::new(AgentOutputPayload::Characters(characters)),
    );

    assert_eq!(plan.scene_plans[0].character_ids, vec!["erin", "xiaoqi"]);
}

#[test]
fn unresolved_provisional_cast_uses_empty_cast_recovery() {
    let mut scenes = vec![crate::story_plan::ScenePlan {
        approval_status: Default::default(),
        rolling_summary: None,
        location_id: None,
        time_of_day: None,
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["Erin".into()],
        ..Default::default()
    }];
    let characters: Vec<crate::characters::types::Character> =
        serde_json::from_value(serde_json::json!([
            {"id":"aila","name":"艾拉"}
        ]))
        .unwrap();

    reconcile_scene_casts(&mut scenes, &characters);

    assert!(scenes[0].character_ids.is_empty());
}

#[test]
fn character_step_keeps_provisional_cast_when_old_config_is_loaded() {
    let mut plan = StoryPlan::new("test");
    plan.scene_plans = vec![crate::story_plan::ScenePlan {
        approval_status: Default::default(),
        rolling_summary: None,
        location_id: None,
        time_of_day: None,
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["艾拉".into(), "洛因".into()],
        ..Default::default()
    }];
    let old_characters = serde_json::from_value(serde_json::json!([
        {"id":"old","name":"旧角色"}
    ]))
    .unwrap();

    apply_canonical_characters(&mut plan, old_characters, true);

    assert_eq!(plan.scene_plans[0].character_ids, vec!["艾拉", "洛因"]);
}

#[test]
fn dialogist_output_merges_staged_character_into_scene_cast() {
    let mut plan = StoryPlan::new("test");
    plan.scene_plans = vec![crate::story_plan::ScenePlan {
        approval_status: Default::default(),
        rolling_summary: None,
        location_id: None,
        time_of_day: None,
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["erin".into()],
        ..Default::default()
    }];
    let draft = serde_json::from_value(serde_json::json!({
        "sceneId": "opening",
        "beats": [{
            "text": "艾拉走入画面。",
            "figureCues": [{
                "action": "show", "characterId": "viper",
                "position": "left", "emotion": "default"
            }]
        }]
    }))
    .unwrap();

    apply_output(
        &mut plan,
        &AgentOutput::new(AgentOutputPayload::SceneDrafts(vec![draft])),
    );

    assert_eq!(plan.scene_plans[0].character_ids, vec!["erin", "viper"]);
}

#[test]
fn asset_plan_persists_missing_character_sprite_slots() {
    let project = std::env::temp_dir().join("ollaic_planned_sprite_slot");
    let _ = std::fs::remove_dir_all(&project);
    let mut plan = StoryPlan::new("test");
    plan.characters = serde_json::from_value(serde_json::json!([{
        "id": "alice", "name": "Alice", "sprites": []
    }]))
    .unwrap();
    let output = AgentOutput::new(AgentOutputPayload::AssetPlan(vec![
        crate::story_plan::AssetTaskPlan {
            aspect_ratio: None,
            reference_image: None,
            id: "figure_alice_happy".into(),
            kind: "figure".into(),
            target_stem: "alice_happy".into(),
            prompt: "happy Alice".into(),
            scene_ref: None,
            character_ref: Some("alice".into()),
            emotion: Some("happy".into()),
            status: "pending".into(),
        },
    ]));

    apply_output(&mut plan, &output);
    OutputTransaction::apply(&project, &output, &plan)
        .unwrap()
        .commit();

    assert_eq!(plan.characters[0].sprites[0].emotion, "happy");
    assert_eq!(plan.characters[0].sprites[0].file, "");
    assert_eq!(
        plan.characters[0].sprites[0].prompt.as_deref(),
        Some("happy Alice")
    );
    let persisted =
        crate::characters::commands::list_characters(project.to_string_lossy().into_owned())
            .unwrap();
    assert_eq!(persisted[0].sprites[0], plan.characters[0].sprites[0]);
    let _ = std::fs::remove_dir_all(project);
}

#[test]
fn plan_write_failure_rolls_back_project_outputs_in_the_same_transaction() {
    let project = std::env::temp_dir().join("ollaic_output_plan_rollback");
    let _ = std::fs::remove_dir_all(&project);
    std::fs::create_dir_all(project.join(".ollaic/plan.json")).unwrap();
    let characters = serde_json::from_value(serde_json::json!([{
        "id": "alice", "name": "Alice", "sprites": []
    }]))
    .unwrap();
    let output = AgentOutput::new(AgentOutputPayload::Characters(characters));
    let mut plan = StoryPlan::new("test");
    apply_output(&mut plan, &output);

    let error = OutputTransaction::apply(&project, &output, &plan)
        .err()
        .expect("plan path directory should reject the plan write");

    assert!(error.0.contains("plan.json"));
    assert!(!project.join("game/config/characters.json").exists());
    let _ = std::fs::remove_dir_all(project);
}

#[test]
fn step_rejects_output_owned_by_another_partition() {
    let output = AgentOutput::new(AgentOutputPayload::Scenes(Vec::new()));

    let error = validate_output_contract(
        StepKind::Plan,
        &StepExecutor::NamedAgent("sceneScript".into()),
        &output,
    )
    .unwrap_err();

    assert!(error.0.contains("plan"));
    assert!(error.0.contains("scenes"));
}

fn populated_scene_plan() -> StoryPlan {
    let mut plan = StoryPlan::new("Incremental scene production");
    plan.chapters = serde_json::from_value(serde_json::json!([
        {"id":"ch1", "title":"Chapter", "summary":"Chapter summary"}
    ]))
    .unwrap();
    plan.scene_plans = ["scene_01", "scene_02", "scene_03", "scene_04"]
        .into_iter()
        .map(|id| crate::story_plan::ScenePlan {
            id: id.into(),
            file: format!("{id}.txt"),
            chapter_id: "ch1".into(),
            title: if id == "scene_03" || id == "scene_04" {
                format!("Ending {id}")
            } else {
                id.into()
            },
            summary: format!("Summary of {id}"),
            approval_status: SceneApprovalStatus::Approved,
            rolling_summary: Some(format!("Reviewed summary of {id}")),
            ..Default::default()
        })
        .collect();
    plan.branches.entry_scene = "scene_01".into();
    plan.branches.edges = serde_json::from_value(serde_json::json!([
        {"from":"scene_01", "to":"scene_02", "choice":"Continue"},
        {"from":"scene_01", "to":"scene_03", "choice":"Leave"},
        {"from":"scene_02", "to":"scene_04"}
    ]))
    .unwrap();
    plan.scene_drafts = plan
        .scene_plans
        .iter()
        .map(|scene| {
            serde_json::from_value(serde_json::json!({
                "sceneId":scene.id, "title":scene.title,
                "beats":[{"text":format!("Reviewed dialogue for {}", scene.id)}]
            }))
            .unwrap()
        })
        .collect();
    plan.asset_plan = plan
        .scene_plans
        .iter()
        .map(|scene| AssetTaskPlan {
            id: format!("bg_{}", scene.id),
            kind: "background".into(),
            target_stem: format!("bg_{}", scene.id),
            prompt: format!("Background for {}", scene.id),
            scene_ref: Some(scene.id.clone()),
            status: "pending".into(),
            ..Default::default()
        })
        .collect();
    plan.scenes = plan
        .scene_plans
        .iter()
        .map(|scene| scene.file.clone())
        .collect();
    plan
}

fn scene_commit_project(name: &str, plan: &StoryPlan) -> std::path::PathBuf {
    let project = std::env::temp_dir().join(format!(
        "ollaic_incremental_commit_{name}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&project);
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    for scene in &plan.scene_plans {
        std::fs::write(
            project.join("game/scene").join(&scene.file),
            format!(":Reviewed script for {};", scene.id),
        )
        .unwrap();
    }
    crate::story_plan::save_plan(&project, plan).unwrap();
    project
}

#[test]
fn partial_scene_outputs_upsert_and_preserve_unrelated_reviewed_content_on_disk() {
    let mut plan = populated_scene_plan();
    let original = plan.clone();
    let project = scene_commit_project("upsert", &plan);
    let mut new_draft = plan.scene_drafts[1].clone();
    new_draft.beats[0].text = "A rewritten second scene".into();
    let drafts = AgentOutput::new(AgentOutputPayload::SceneDrafts(vec![new_draft.clone()]));

    apply_output(&mut plan, &drafts);
    OutputTransaction::apply(&project, &drafts, &plan)
        .unwrap()
        .commit();

    assert_eq!(plan.scene_drafts.len(), 4);
    assert_eq!(plan.scene_drafts[1], new_draft);
    assert_eq!(plan.scene_drafts[0], original.scene_drafts[0]);
    assert_eq!(plan.scene_drafts[2], original.scene_drafts[2]);
    assert_eq!(plan.asset_plan, original.asset_plan);
    assert_eq!(plan.scenes, original.scenes);
    assert_eq!(plan.scene_plans[0], original.scene_plans[0]);
    assert_eq!(plan.scene_plans[2], original.scene_plans[2]);
    assert_eq!(
        plan.scene_plans[1].approval_status,
        SceneApprovalStatus::Stale
    );
    assert_eq!(
        plan.scene_plans[3].approval_status,
        SceneApprovalStatus::Stale
    );

    let mut task = original.asset_plan[1].clone();
    task.prompt = "A new second-scene backdrop".into();
    let assets = AgentOutput::new(AgentOutputPayload::AssetPlan(vec![task.clone()]));
    apply_output(&mut plan, &assets);
    OutputTransaction::apply(&project, &assets, &plan)
        .unwrap()
        .commit();
    assert_eq!(plan.asset_plan.len(), 4);
    assert_eq!(plan.asset_plan[1], task);
    assert_eq!(plan.asset_plan[0], original.asset_plan[0]);
    assert_eq!(plan.asset_plan[2], original.asset_plan[2]);

    let output = AgentOutput::new(AgentOutputPayload::Scenes(vec![
        crate::agents::SceneScript {
            name: "scene_02.txt".into(),
            content: ":A rewritten second scene;".into(),
        },
    ]));
    apply_output(&mut plan, &output);
    OutputTransaction::apply(&project, &output, &plan)
        .unwrap()
        .commit();
    assert_eq!(plan.scenes.len(), 4);
    assert_eq!(
        plan.scene_plans[1].approval_status,
        SceneApprovalStatus::Drafted
    );
    assert_eq!(
        plan.scene_plans[3].approval_status,
        SceneApprovalStatus::Stale
    );
    for index in [0, 2] {
        let scene = &original.scene_plans[index];
        assert_eq!(plan.scene_plans[index], *scene);
        assert_eq!(
            std::fs::read_to_string(project.join("game/scene").join(&scene.file)).unwrap(),
            format!(":Reviewed script for {};", scene.id)
        );
    }
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/scene_02.txt")).unwrap(),
        ":A rewritten second scene;"
    );
    assert_eq!(
        crate::story_plan::load_plan(&project).unwrap().unwrap(),
        plan
    );
    std::fs::remove_dir_all(project).unwrap();
}

#[test]
fn unchanged_keyed_drafts_and_asset_tasks_preserve_approval_and_summary() {
    let mut plan = populated_scene_plan();
    let original = plan.clone();
    let drafts = AgentOutput::new(AgentOutputPayload::SceneDrafts(vec![
        plan.scene_drafts[1].clone()
    ]));
    let assets = AgentOutput::new(AgentOutputPayload::AssetPlan(vec![
        plan.asset_plan[1].clone()
    ]));
    apply_output(&mut plan, &drafts);
    apply_output(&mut plan, &assets);
    assert_eq!(plan, original);
}

#[test]
fn equivalent_shared_background_keeps_original_binding_and_other_scene_approval() {
    let mut plan = populated_scene_plan();
    for scene in &mut plan.scene_plans[..2] {
        scene.location_id = Some("courtyard".into());
        scene.time_of_day = Some("night".into());
    }
    let original = plan.clone();
    let mut requirement = plan.asset_plan[0].clone();
    requirement.scene_ref = Some("scene_02".into());
    requirement.aspect_ratio = Some("16:9".into());
    apply_output(
        &mut plan,
        &AgentOutput::new(AgentOutputPayload::AssetPlan(vec![requirement])),
    );
    assert_eq!(plan, original);
}

#[test]
fn failed_partial_scene_commit_restores_written_scene_and_persisted_approvals() {
    let original = populated_scene_plan();
    let mut updated = original.clone();
    let project = scene_commit_project("rollback", &original);
    std::fs::remove_file(project.join("game/scene/scene_03.txt")).unwrap();
    std::fs::create_dir(project.join("game/scene/scene_03.txt")).unwrap();
    let output = AgentOutput::new(AgentOutputPayload::Scenes(vec![
        crate::agents::SceneScript {
            name: "scene_02.txt".into(),
            content: ":Rewrite;".into(),
        },
        crate::agents::SceneScript {
            name: "scene_03.txt".into(),
            content: ":Rewrite other;".into(),
        },
    ]));
    apply_output(&mut updated, &output);
    assert!(OutputTransaction::apply(&project, &output, &updated).is_err());
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/scene_02.txt")).unwrap(),
        ":Reviewed script for scene_02;"
    );
    assert_eq!(
        crate::story_plan::load_plan(&project).unwrap().unwrap(),
        original
    );
    std::fs::remove_dir_all(project).unwrap();
}
