use super::*;

#[test]
fn character_output_reconciles_provisional_scene_cast_names() {
    let mut plan = StoryPlan::new("test");
    plan.scene_plans = vec![crate::story_plan::ScenePlan {
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["艾拉".into(), "洛因".into()],
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
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["Erin".into(), "Xiaoqi".into()],
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
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["Erin".into()],
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
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["艾拉".into(), "洛因".into()],
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
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Opening".into(),
        summary: String::new(),
        character_ids: vec!["erin".into()],
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
