use super::*;
use crate::story_plan::types::{
    AssetTaskPlan, BranchEdge, BranchGraph, ChapterPlan, DialogueBeat, PipelineRunSummary,
    SceneDraft, ScenePlan, StoryMemory, StoryPlan,
};
use std::collections::BTreeMap;
use std::fs;

fn fresh_project_dir(name: &str) -> std::path::PathBuf {
    let tmp = std::env::temp_dir().join(format!("ollaic_story_plan_{}", name));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    tmp
}

#[test]
fn plan_round_trips_through_disk() {
    let project = fresh_project_dir("round_trip");
    let plan = StoryPlan {
        visual_style: Default::default(),
        version: 1,
        prompt: "赛博朋克校园恋爱悬疑短篇".to_string(),
        synopsis: "一名转学生在校园服务器里发现了一段不该存在的记忆。".to_string(),
        chapters: vec![
            ChapterPlan {
                id: "ch1".to_string(),
                title: "序章 · 信号".to_string(),
                summary: "主角转学，初遇女主，发现异常。".to_string(),
            },
            ChapterPlan {
                id: "ch2".to_string(),
                title: "第一章 · 余像".to_string(),
                summary: "追查信号来源，与女主关系推进。".to_string(),
            },
        ],
        memory: StoryMemory {
            worldbook: "霓虹学园的世界设定。".to_string(),
            glossary: BTreeMap::from([
                ("余像".to_string(), "被删除后仍会回响的记忆".to_string()),
                ("回声".to_string(), "重复出现的异常信号".to_string()),
                ("协议".to_string(), "维护遗忘秩序的规则".to_string()),
                ("锚点".to_string(), "确认真实记忆的人或物".to_string()),
            ]),
        },
        characters: Vec::new(),
        scene_plans: vec![ScenePlan {
            location_id: None,
            time_of_day: None,
            id: "opening".to_string(),
            file: "start.txt".to_string(),
            chapter_id: "ch1".to_string(),
            title: "异常信号".to_string(),
            summary: "转学生第一次听见余像。".to_string(),
            character_ids: Vec::new(),
            ..Default::default()
        }],
        branches: BranchGraph {
            entry_scene: "opening".to_string(),
            edges: vec![BranchEdge {
                from: "opening".to_string(),
                to: "opening".to_string(),
                choice: None,
                ..Default::default()
            }],
        },
        variables: Vec::new(),
        scene_drafts: vec![SceneDraft {
            scene_id: "opening".to_string(),
            title: "异常信号".to_string(),
            stage_managed: false,
            beats: vec![DialogueBeat {
                kind: BeatKind::Dialogue,
                speaker: None,
                text: "雨落在窗上。".to_string(),
                figure_cues: Vec::new(),
            }],
        }],
        asset_plan: vec![AssetTaskPlan {
            aspect_ratio: None,
            reference_image: None,
            id: "bg_opening".to_string(),
            kind: "background".to_string(),
            target_stem: "bg_opening".to_string(),
            prompt: "雨夜教室".to_string(),
            scene_ref: Some("opening".to_string()),
            character_ref: None,
            emotion: None,
            status: "pending".to_string(),
        }],
        scenes: vec!["start.txt".to_string()],
        pipeline_runs: vec![PipelineRunSummary {
            run_id: "run_1".to_string(),
            status: "completed".to_string(),
            started_at: 1_700_000_000,
            updated_at: 1_700_000_100,
        }],
    };

    save_plan(&project, &plan).unwrap();
    // No plan exists before save is impossible here; load returns the saved one.
    let loaded = load_plan(&project)
        .unwrap()
        .expect("plan should exist after save");

    assert_eq!(loaded, plan);
    // The plan lands exactly where the ADR says it should.
    assert!(plan_path(&project).is_file());
}

#[test]
fn load_returns_none_when_no_plan_exists() {
    let project = fresh_project_dir("none");
    assert!(load_plan(&project).unwrap().is_none());
}

#[test]
fn rejects_plan_with_unsupported_version() {
    let plan = StoryPlan {
        version: 99,
        prompt: "p".to_string(),
        ..StoryPlan::new("")
    };
    assert_eq!(validate(&plan), Err(PlanError::UnsupportedVersion(99)));
}

#[test]
fn rejects_plan_with_neither_prompt_nor_synopsis() {
    let mut plan = StoryPlan::new("   \n");
    plan.synopsis = "  ".to_string();
    assert_eq!(validate(&plan), Err(PlanError::EmptyPlan));
}

#[test]
fn rejects_figure_cue_for_character_outside_scene_cast() {
    use crate::characters::types::Character;
    use crate::story_plan::{FigureCue, FigureCueAction, FigureStagePosition};

    let mut plan = StoryPlan::new("a brief");
    plan.chapters = vec![ChapterPlan {
        id: "chapter".into(),
        title: "Chapter".into(),
        summary: "Summary".into(),
    }];
    plan.characters =
        vec![
            serde_json::from_value::<Character>(serde_json::json!({"id":"alice","name":"Alice"}))
                .unwrap(),
        ];
    plan.scene_plans = vec![ScenePlan {
        location_id: None,
        time_of_day: None,
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "chapter".into(),
        title: "Opening".into(),
        summary: "Empty room".into(),
        character_ids: Vec::new(),
        ..Default::default()
    }];
    plan.scene_drafts = vec![SceneDraft {
        scene_id: "opening".into(),
        title: "Opening".into(),
        stage_managed: true,
        beats: vec![DialogueBeat {
            kind: BeatKind::Dialogue,
            speaker: None,
            text: "The room is empty.".into(),
            figure_cues: vec![FigureCue {
                action: FigureCueAction::Show,
                character_id: "alice".into(),
                position: Some(FigureStagePosition::Center),
                emotion: "default".into(),
            }],
        }],
    }];
    plan.branches.entry_scene = "opening".into();

    assert!(matches!(
        validate(&plan),
        Err(PlanError::InvalidReference(_))
    ));
}

#[test]
fn rejects_outline_with_duplicate_chapter_ids() {
    let mut plan = StoryPlan::new("a brief");
    plan.chapters = vec![
        ChapterPlan {
            id: "ch1".to_string(),
            title: "A".to_string(),
            summary: "s".to_string(),
        },
        ChapterPlan {
            id: "ch1".to_string(),
            title: "B".to_string(),
            summary: "s".to_string(),
        },
    ];
    let error = validate(&plan).unwrap_err();
    assert!(error.to_string().contains("$.chapters[1].id"));
}

#[test]
fn refuses_to_save_an_invalid_plan() {
    let project = fresh_project_dir("invalid_save");
    let plan = StoryPlan {
        visual_style: Default::default(),
        version: 2,
        prompt: "p".to_string(),
        synopsis: String::new(),
        memory: StoryMemory::default(),
        chapters: Vec::new(),
        characters: Vec::new(),
        scene_plans: Vec::new(),
        branches: BranchGraph::default(),
        variables: Vec::new(),
        scene_drafts: Vec::new(),
        asset_plan: Vec::new(),
        scenes: Vec::new(),
        pipeline_runs: Vec::new(),
    };
    let err = save_plan(&project, &plan).unwrap_err();
    assert_eq!(err, PlanError::UnsupportedVersion(2));
    // Nothing should have been written for an invalid plan.
    assert!(!plan_path(&project).exists());
}

#[test]
fn rejects_scene_plan_with_path_traversal() {
    let mut plan = StoryPlan::new("brief");
    plan.chapters.push(ChapterPlan {
        id: "ch1".to_string(),
        title: "序章".to_string(),
        summary: "开场".to_string(),
    });
    plan.scene_plans.push(ScenePlan {
        location_id: None,
        time_of_day: None,
        id: "opening".to_string(),
        file: "../start.txt".to_string(),
        chapter_id: "ch1".to_string(),
        title: "开场".to_string(),
        summary: "开场".to_string(),
        character_ids: Vec::new(),
        ..Default::default()
    });
    let error = validate(&plan).unwrap_err();
    assert!(error.to_string().contains("$.scenePlans[0].file"));
}

#[test]
fn refuses_to_load_a_plan_with_wrong_version() {
    let project = fresh_project_dir("wrong_version_load");
    let path = plan_path(&project);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"version":7,"prompt":"x","synopsis":"","chapters":[],"pipelineRuns":[]}"#,
    )
    .unwrap();
    assert_eq!(
        load_plan(&project).unwrap_err(),
        PlanError::UnsupportedVersion(7)
    );
}

#[test]
fn loads_legacy_plan_without_version_as_v1() {
    let project = fresh_project_dir("legacy_without_version");
    let path = plan_path(&project);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        r#"{"prompt":"legacy brief","synopsis":"legacy synopsis"}"#,
    )
    .unwrap();

    let plan = load_plan(&project).unwrap().unwrap();
    assert_eq!(plan.version, 1);
    assert_eq!(plan.synopsis, "legacy synopsis");
}

#[test]
fn invalid_cross_node_reference_reports_json_path() {
    let mut plan = StoryPlan::new("test");
    plan.chapters.push(ChapterPlan {
        id: "ch1".into(),
        title: "Chapter".into(),
        summary: "Summary".into(),
    });
    plan.scene_plans.push(ScenePlan {
        location_id: None,
        time_of_day: None,
        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "missing".into(),
        title: "Opening".into(),
        summary: "Summary".into(),
        character_ids: Vec::new(),
        ..Default::default()
    });
    let error = validate(&plan).unwrap_err();
    assert!(error.to_string().contains("$.scenePlans[0].chapterId"));
}

#[test]
fn falls_back_to_valid_backup_when_primary_plan_is_semantically_invalid() {
    let project = fresh_project_dir("semantic_backup");
    let path = plan_path(&project);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"version":99,"prompt":"broken"}"#).unwrap();
    fs::write(
        crate::json_store::backup_path(&path),
        r#"{"prompt":"legacy","synopsis":"recoverable"}"#,
    )
    .unwrap();

    let plan = load_plan(&project).unwrap().unwrap();
    assert_eq!(plan.synopsis, "recoverable");
}

#[test]
fn migrates_historical_partial_node_outputs_on_load() {
    let project = fresh_project_dir("legacy_partial_outputs");
    let path = plan_path(&project);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{
          "prompt":"legacy",
          "synopsis":"Legacy synopsis",
          "chapters":[{"id":"ch1","title":"Chapter"}],
          "characters":[
            {"id":"alice","name":"Alice","relations":[{"targetId":"","relationType":""}]}
          ],
          "scenePlans":[{
            "id":"opening","file":"start.txt","chapterId":"ch1","title":"Opening",
            "characterIds":["alice"]
          }],
          "branches":{"entryScene":"opening","edges":[]},
          "sceneDrafts":[{
            "sceneId":"opening","beats":[{"speaker":"Alice","text":"Hello"}]
          }],
          "assetPlan":[{
            "kind":"figure","targetStem":"alice_default","prompt":"Alice",
            "characterRef":"alice","sceneRef":"start.txt"
          }]
        }"#,
    )
    .unwrap();

    let plan = load_plan(&project).unwrap().unwrap();
    assert!(plan.characters[0].relations.is_empty());
    assert!(!plan.chapters[0].summary.is_empty());
    assert!(!plan.scene_plans[0].summary.is_empty());
    assert_eq!(plan.scene_drafts[0].title, "Opening");
    assert_eq!(plan.asset_plan[0].id, "figure_alice_default");
    assert_eq!(plan.asset_plan[0].emotion.as_deref(), Some("default"));
    assert_eq!(plan.asset_plan[0].scene_ref.as_deref(), Some("opening"));
}

#[test]
fn rejects_partial_memory_with_field_path() {
    let mut plan = StoryPlan::new("brief");
    plan.memory.worldbook = "World".into();
    let error = validate(&plan).unwrap_err();
    assert!(error.to_string().contains("$.memory.glossary"));
}

#[test]
fn invalid_glossary_entry_uses_escaped_json_path() {
    let mut plan = StoryPlan::new("brief");
    plan.memory.worldbook = "World".into();
    plan.memory.glossary = BTreeMap::from([
        ("a.b".into(), String::new()),
        ("second".into(), "Two".into()),
        ("third".into(), "Three".into()),
        ("fourth".into(), "Four".into()),
    ]);
    let error = validate(&plan).unwrap_err();
    assert!(error.to_string().contains(r#"$.memory.glossary["a.b"]"#));
}

#[test]
fn legacy_plan_defaults_visual_fields_and_round_trips_new_fields() {
    let mut plan: StoryPlan = serde_json::from_str(r#"{"prompt":"legacy"}"#).unwrap();
    assert_eq!(plan.visual_style, Default::default());
    plan.visual_style.style_prompt = "cel shading".into();
    plan.visual_style.style_reference_image = Some("game/style.png".into());
    let encoded = serde_json::to_value(&plan).unwrap();
    assert_eq!(encoded["visualStyle"]["stylePrompt"], "cel shading");
    assert_eq!(serde_json::from_value::<StoryPlan>(encoded).unwrap(), plan);
}

#[test]
fn saves_unconnected_scene_cards_during_authoring() {
    let mut plan = StoryPlan::new("brief");
    plan.chapters.push(ChapterPlan {
        id: "ch1".into(),
        title: "Chapter 1".into(),
        summary: "Summary".into(),
    });
    plan.scene_plans.push(ScenePlan {
        id: "entry".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Entry".into(),
        summary: "Entry scene".into(),
        character_ids: vec![],
        ..Default::default()
    });
    plan.scene_plans.push(ScenePlan {
        id: "unreachable".into(),
        file: "unreachable.txt".into(),
        chapter_id: "ch1".into(),
        title: "Island".into(),
        summary: "Unreachable scene".into(),
        character_ids: vec![],
        ..Default::default()
    });
    plan.branches = BranchGraph {
        entry_scene: "entry".into(),
        edges: vec![BranchEdge {
            from: "entry".into(),
            to: "entry".into(),
            choice: None,
            ..Default::default()
        }],
    };

    validate(&plan).unwrap();
    let project = fresh_project_dir("unconnected_authoring");
    save_plan(&project, &plan).unwrap();
    assert_eq!(load_plan(&project).unwrap().unwrap(), plan);
}

#[test]
fn preserves_legacy_terminal_scenes_without_ending_names() {
    let mut plan = StoryPlan::new("brief");
    plan.chapters.push(ChapterPlan {
        id: "ch1".into(),
        title: "Chapter 1".into(),
        summary: "Summary".into(),
    });
    plan.scene_plans.push(ScenePlan {
        id: "entry".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Entry".into(),
        summary: "Entry scene".into(),
        character_ids: vec![],
        ..Default::default()
    });
    plan.scene_plans.push(ScenePlan {
        id: "trap".into(),
        file: "middle.txt".into(),
        chapter_id: "ch1".into(),
        title: "Middle Scene".into(),
        summary: "Non-ending scene that has no continuation".into(),
        character_ids: vec![],
        ..Default::default()
    });
    plan.branches = BranchGraph {
        entry_scene: "entry".into(),
        edges: vec![BranchEdge {
            from: "entry".into(),
            to: "trap".into(),
            choice: None,
            ..Default::default()
        }],
    };

    validate(&plan).unwrap();
    let project = fresh_project_dir("legacy_terminal");
    save_plan(&project, &plan).unwrap();
    assert_eq!(load_plan(&project).unwrap().unwrap(), plan);
}

#[test]
fn rejects_condition_reading_undefined_variable() {
    let mut plan = StoryPlan::new("brief");
    plan.chapters.push(ChapterPlan {
        id: "ch1".into(),
        title: "Chapter 1".into(),
        summary: "Summary".into(),
    });
    plan.scene_plans.push(ScenePlan {
        id: "entry".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Entry".into(),
        summary: "Entry scene".into(),
        character_ids: vec![],
        ..Default::default()
    });
    plan.variables = vec![VariableDef {
        id: "trust".into(),
        kind: VariableKind::Integer,
        initial_value: "0".into(),
        description: "信任度".into(),
    }];
    plan.branches = BranchGraph {
        entry_scene: "entry".into(),
        edges: vec![BranchEdge {
            from: "entry".into(),
            to: "entry".into(),
            choice: Some("Choice".into()),
            condition: Some("undefined_var > 0".into()),
            effects: vec![],
        }],
    };

    let error = validate(&plan).unwrap_err();
    assert!(
        error.to_string().contains("$.branches.edges[0].condition"),
        "Error should report undefined variable path: {}",
        error
    );
}

#[test]
fn rejects_condition_reading_variable_with_no_writes() {
    let mut plan = StoryPlan::new("brief");
    plan.chapters.push(ChapterPlan {
        id: "ch1".into(),
        title: "Chapter 1".into(),
        summary: "Summary".into(),
    });
    plan.scene_plans.push(ScenePlan {
        id: "entry".into(),
        file: "start.txt".into(),
        chapter_id: "ch1".into(),
        title: "Entry".into(),
        summary: "Entry scene".into(),
        character_ids: vec![],
        ..Default::default()
    });
    plan.variables = vec![VariableDef {
        id: "isolated_flag".into(),
        kind: VariableKind::Boolean,
        initial_value: "false".into(),
        description: "从不被写入的标记".into(),
    }];
    plan.branches = BranchGraph {
        entry_scene: "entry".into(),
        edges: vec![BranchEdge {
            from: "entry".into(),
            to: "entry".into(),
            choice: Some("Choice".into()),
            condition: Some("isolated_flag == true".into()),
            effects: vec![],
        }],
    };

    let error = validate(&plan).unwrap_err();
    assert!(
        error.to_string().contains("never written"),
        "Error should report variable never written: {}",
        error
    );
}

#[test]
fn branch_expressions_reject_invalid_assignments_and_script_injection() {
    use super::store::{extract_effect_variable, is_safe_branch_expression};
    for invalid in [
        "trust",
        "trust == 1",
        "信任=1",
        "trust=1;end",
        "trust=1\nend",
        "trust=1 -next",
        "trust=",
    ] {
        assert!(extract_effect_variable(invalid).is_none(), "{invalid}");
    }
    for valid in ["trust=1", "trust += 1", "trust-=1", "trust*=2", "trust/=2"] {
        assert_eq!(extract_effect_variable(valid).as_deref(), Some("trust"));
    }
    for invalid in ["信任>=1", "trust>1;end", "trust>1\nend", "trust>1 -next"] {
        assert!(!is_safe_branch_expression(invalid), "{invalid}");
    }
}
