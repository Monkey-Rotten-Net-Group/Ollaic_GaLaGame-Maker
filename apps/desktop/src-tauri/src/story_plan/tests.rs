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
        variables: Vec::new(),

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
            approval_status: Default::default(),
            rolling_summary: None,
            pov_character_id: None,
            emotional_arc: String::new(),
            required_beats: Vec::new(),
            forbidden_reveals: Vec::new(),
            entry_state: Vec::new(),
            min_beats: 24,

            id: "opening".to_string(),
            file: "start.txt".to_string(),
            chapter_id: "ch1".to_string(),
            title: "异常信号".to_string(),
            summary: "转学生第一次听见余像。".to_string(),
            character_ids: Vec::new(),
        }],
        branches: BranchGraph {
            entry_scene: "opening".to_string(),
            edges: vec![BranchEdge {
                condition: None,
                effects: Vec::new(),

                from: "opening".to_string(),
                to: "opening".to_string(),
                choice: None,
            }],
        },
        scene_drafts: vec![SceneDraft {
            scene_id: "opening".to_string(),
            title: "异常信号".to_string(),
            stage_managed: false,
            beats: vec![DialogueBeat {
                kind: crate::story_plan::types::BeatKind::Dialogue,

                speaker: None,
                text: "雨落在窗上。".to_string(),
                figure_cues: Vec::new(),
            }],
        }],
        asset_plan: vec![AssetTaskPlan {
            reference_image: None,
            aspect_ratio: None,

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
        visual_style: Default::default(),
        variables: Vec::new(),

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
        approval_status: Default::default(),
        rolling_summary: None,
        pov_character_id: None,
        emotional_arc: String::new(),
        required_beats: Vec::new(),
        forbidden_reveals: Vec::new(),
        entry_state: Vec::new(),
        min_beats: 24,

        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "chapter".into(),
        title: "Opening".into(),
        summary: "Empty room".into(),
        character_ids: Vec::new(),
    }];
    plan.scene_drafts = vec![SceneDraft {
        scene_id: "opening".into(),
        title: "Opening".into(),
        stage_managed: true,
        beats: vec![DialogueBeat {
            kind: crate::story_plan::types::BeatKind::Dialogue,

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
        variables: Vec::new(),

        version: 2,
        prompt: "p".to_string(),
        synopsis: String::new(),
        memory: StoryMemory::default(),
        chapters: Vec::new(),
        characters: Vec::new(),
        scene_plans: Vec::new(),
        branches: BranchGraph::default(),
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
        approval_status: Default::default(),
        rolling_summary: None,
        pov_character_id: None,
        emotional_arc: String::new(),
        required_beats: Vec::new(),
        forbidden_reveals: Vec::new(),
        entry_state: Vec::new(),
        min_beats: 24,

        id: "opening".to_string(),
        file: "../start.txt".to_string(),
        chapter_id: "ch1".to_string(),
        title: "开场".to_string(),
        summary: "开场".to_string(),
        character_ids: Vec::new(),
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
        approval_status: Default::default(),
        rolling_summary: None,
        pov_character_id: None,
        emotional_arc: String::new(),
        required_beats: Vec::new(),
        forbidden_reveals: Vec::new(),
        entry_state: Vec::new(),
        min_beats: 24,

        id: "opening".into(),
        file: "start.txt".into(),
        chapter_id: "missing".into(),
        title: "Opening".into(),
        summary: "Summary".into(),
        character_ids: Vec::new(),
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
