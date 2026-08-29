use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

use crate::story_plan::types::AssetTaskPlan;

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

pub struct AssetPlannerAgent;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetPlanResponse {
    asset_plan: Vec<AssetTaskPlan>,
}

fn fill_missing_task_ids(tasks: &mut [AssetTaskPlan]) {
    for task in tasks {
        if task.kind == "figure" && task.emotion.is_none() {
            task.emotion = Some("default".to_string());
        }
        if task.id.trim().is_empty() {
            task.id = format!("{}_{}", task.kind.trim(), task.target_stem.trim());
        }
    }
}

fn ensure_staged_figure_tasks(
    tasks: &mut Vec<AssetTaskPlan>,
    characters: &[crate::characters::types::Character],
    drafts: &[crate::story_plan::SceneDraft],
) {
    let mut planned: std::collections::HashSet<(String, String)> = tasks
        .iter()
        .filter(|task| task.kind == "figure")
        .filter_map(|task| Some((task.character_ref.clone()?, task.emotion.clone()?)))
        .collect();
    for cue in drafts
        .iter()
        .flat_map(|draft| &draft.beats)
        .flat_map(|beat| &beat.figure_cues)
        .filter(|cue| cue.action == crate::story_plan::FigureCueAction::Show)
    {
        let character_id = cue.character_id.as_str();
        let emotion = cue.emotion.as_str();
        if !planned.insert((character_id.to_string(), emotion.to_string())) {
            continue;
        }
        let Some(character) = characters.iter().find(|item| item.id == character_id) else {
            continue;
        };
        tasks.push(AssetTaskPlan {
            id: format!("figure_{}_{}", character.id, emotion),
            kind: "figure".to_string(),
            target_stem: format!("{}_{}", character.id, emotion),
            prompt: format!(
                "视觉小说角色立绘，单人，完整身体，纯色背景，{}表情；{}；性格：{}",
                emotion, character.description, character.personality
            ),
            scene_ref: None,
            character_ref: Some(character.id.clone()),
            emotion: Some(emotion.to_string()),
            status: "pending".to_string(),
        });
    }
}

fn validate_asset_plan(
    tasks: &[AssetTaskPlan],
    scenes: &[crate::story_plan::ScenePlan],
    characters: &[crate::characters::types::Character],
) -> Result<(), AgentError> {
    if tasks.is_empty() {
        return Err(contract_error("$.assetPlan", "must not be empty"));
    }
    let scene_ids: std::collections::HashSet<&str> =
        scenes.iter().map(|scene| scene.id.as_str()).collect();
    let character_ids: std::collections::HashSet<&str> = characters
        .iter()
        .map(|character| character.id.as_str())
        .collect();
    let mut ids = std::collections::HashSet::new();
    let mut figure_variants = std::collections::HashSet::new();
    for (index, task) in tasks.iter().enumerate() {
        let path = format!("$.assetPlan[{index}]");
        if !crate::story_plan::types::is_webgal_flag_value(&task.id)
            || !ids.insert(task.id.as_str())
        {
            return Err(contract_error(
                format!("{path}.id"),
                "must be a unique safe id",
            ));
        }
        if !matches!(task.kind.as_str(), "background" | "figure" | "bgm" | "sfx") {
            return Err(contract_error(
                format!("{path}.kind"),
                "must be background, figure, bgm, or sfx",
            ));
        }
        if !crate::story_plan::types::is_webgal_flag_value(&task.target_stem) {
            return Err(contract_error(
                format!("{path}.targetStem"),
                "must be a safe filename stem",
            ));
        }
        if task.prompt.trim().is_empty() {
            return Err(contract_error(
                format!("{path}.prompt"),
                "must not be empty",
            ));
        }
        if task.status != "pending" {
            return Err(contract_error(
                format!("{path}.status"),
                "must equal pending",
            ));
        }
        if let Some(scene) = &task.scene_ref {
            if !scene_ids.contains(scene.as_str()) {
                return Err(contract_error(
                    format!("{path}.sceneRef"),
                    "references unknown scene id",
                ));
            }
        }
        if let Some(character) = &task.character_ref {
            if !character_ids.contains(character.as_str()) {
                return Err(contract_error(
                    format!("{path}.characterRef"),
                    "references unknown character id",
                ));
            }
        }
        if task.kind == "figure" {
            if task.character_ref.as_deref().is_none_or(str::is_empty) {
                return Err(contract_error(
                    format!("{path}.characterRef"),
                    "is required for figure tasks",
                ));
            }
            if !task
                .emotion
                .as_deref()
                .is_some_and(crate::story_plan::types::is_webgal_flag_value)
            {
                return Err(contract_error(
                    format!("{path}.emotion"),
                    "is required and must be safe for figure tasks",
                ));
            }
            let variant = (
                task.character_ref
                    .as_deref()
                    .expect("validated characterRef"),
                task.emotion.as_deref().expect("validated emotion"),
            );
            if !figure_variants.insert(variant) {
                return Err(contract_error(
                    format!("{path}.emotion"),
                    "duplicates an existing character/emotion figure variant",
                ));
            }
        } else if task.emotion.is_some() {
            return Err(contract_error(
                format!("{path}.emotion"),
                "is only allowed for figure tasks",
            ));
        }
    }
    Ok(())
}

impl Agent for AssetPlannerAgent {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            if ctx.scene_drafts.is_empty() || ctx.characters.is_empty() {
                return Err(AgentError(
                    "AssetPlanner requires dialogue drafts and characters".to_string(),
                ));
            }
            let input = serde_json::json!({
                "productionBrief": ctx.prompt,
                "worldbook": ctx.worldbook,
                "characters": ctx.characters,
                "scenePlans": ctx.scene_plans,
                "sceneDrafts": ctx.scene_drafts,
                "stepInstruction": ctx.instruction,
                "requirements": "仅规划需求，不生成或绑定素材。kind 使用 background、figure、bgm、sfx 之一；targetStem 使用安全英文/数字/下划线；sceneRef/characterRef 引用已有 id；status 固定 pending。覆盖每个场景的背景、Scene Staging 每个 show cue 的角色与 emotion 立绘，以及全局 BGM。figure 任务必须包含 emotion，prompt 必须要求单人、完整身体、纯色背景和对应表情，不得生成多人合照或全幅 CG。"
            });
            if let Some(routed) = generate_structured_validated::<AssetPlanResponse, _>(
                ctx.chat,
                "AssetPlanner / 资产规划",
                concat!(
                    "把故事内容转成 P2 可消费的结构化资产任务。严格使用 JSON：",
                    r#"{"assetPlan":[{"id":"bg_opening","kind":"background","targetStem":"bg_opening","prompt":"...","sceneRef":"opening","characterRef":null,"status":"pending"}]}"#,
                    "。每项都必须包含 id、kind、targetStem、prompt 和 status，字段使用 camelCase。"
                ),
                &input,
                ctx.allow_local_fallback,
                |response| {
                    fill_missing_task_ids(&mut response.asset_plan);
                    ensure_staged_figure_tasks(
                        &mut response.asset_plan,
                        ctx.characters,
                        ctx.scene_drafts,
                    );
                    validate_asset_plan(&response.asset_plan, ctx.scene_plans, ctx.characters)
                },
            ).await? {
                return Ok(AgentOutput::new(AgentOutputPayload::AssetPlan(
                    routed.value.asset_plan,
                ))
                .with_model(
                    routed.model,
                    routed.prompt_tokens,
                    routed.completion_tokens,
                ));
            }

            let mut tasks: Vec<AssetTaskPlan> = ctx
                .scene_plans
                .iter()
                .map(|scene| AssetTaskPlan {
                    id: format!("bg_{}", scene.id),
                    kind: "background".to_string(),
                    target_stem: format!("bg_{}", scene.id),
                    prompt: format!(
                        "视觉小说背景，无人物，{}；{}；与统一世界观保持光线和建筑语言一致",
                        scene.title, scene.summary
                    ),
                    scene_ref: Some(scene.id.clone()),
                    character_ref: None,
                    emotion: None,
                    status: "pending".to_string(),
                })
                .collect();
            ensure_staged_figure_tasks(&mut tasks, ctx.characters, ctx.scene_drafts);
            tasks.push(AssetTaskPlan {
                id: "bgm_main_theme".to_string(),
                kind: "bgm".to_string(),
                target_stem: "bgm_main_theme".to_string(),
                prompt: "克制而带悬念的视觉小说主题音乐，能从日常感逐渐过渡到温柔的决意。"
                    .to_string(),
                scene_ref: None,
                character_ref: None,
                emotion: None,
                status: "pending".to_string(),
            });
            Ok(AgentOutput::new(AgentOutputPayload::AssetPlan(tasks)).local_fallback())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn character(id: &str) -> crate::characters::types::Character {
        serde_json::from_value(serde_json::json!({"id": id, "name": id})).unwrap()
    }

    #[test]
    fn model_response_without_task_id_does_not_abort_asset_planner() {
        let response = r#"{
            "assetPlan":[{
                "kind":"background",
                "targetStem":"bg_opening",
                "prompt":"黄昏教室",
                "sceneRef":"opening",
                "status":"pending"
            }]
        }"#;

        let mut parsed: AssetPlanResponse =
            serde_json::from_str(response).expect("missing task id should be recoverable");
        fill_missing_task_ids(&mut parsed.asset_plan);
        assert_eq!(parsed.asset_plan[0].id, "background_bg_opening");
    }

    #[test]
    fn planned_tasks_are_pending_by_default() {
        let task = AssetTaskPlan {
            id: "bg_opening".into(),
            kind: "background".into(),
            target_stem: "bg_opening".into(),
            prompt: "教室".into(),
            scene_ref: Some("opening".into()),
            character_ref: None,
            emotion: None,
            status: "pending".into(),
        };
        assert_eq!(task.status, "pending");
    }

    #[test]
    fn unknown_scene_reference_reports_asset_field_path() {
        let tasks = vec![AssetTaskPlan {
            id: "bg_opening".into(),
            kind: "background".into(),
            target_stem: "bg_opening".into(),
            prompt: "教室".into(),
            scene_ref: Some("missing".into()),
            character_ref: None,
            emotion: None,
            status: "pending".into(),
        }];
        let error = validate_asset_plan(&tasks, &[], &[]).unwrap_err();
        assert!(error.0.contains("$.assetPlan[0].sceneRef"));
    }

    #[test]
    fn duplicate_figure_variant_reports_asset_field_path() {
        let tasks = ["first", "second"].map(|id| AssetTaskPlan {
            id: id.into(),
            kind: "figure".into(),
            target_stem: id.into(),
            prompt: "Alice".into(),
            scene_ref: None,
            character_ref: Some("alice".into()),
            emotion: Some("default".into()),
            status: "pending".into(),
        });
        let error = validate_asset_plan(&tasks, &[], &[character("alice")]).unwrap_err();
        assert!(error.0.contains("$.assetPlan[1].emotion"));
    }

    #[test]
    fn staging_adds_one_task_for_each_visible_character() {
        use crate::story_plan::{
            DialogueBeat, FigureCue, FigureCueAction, FigureStagePosition, SceneDraft,
        };

        let cue = FigureCue {
            action: FigureCueAction::Show,
            character_id: "alice".into(),
            position: Some(FigureStagePosition::Left),
            emotion: "default".into(),
        };
        let drafts = vec![SceneDraft {
            scene_id: "opening".into(),
            title: "Opening".into(),
            stage_managed: true,
            beats: vec![DialogueBeat {
                speaker: Some("Alice".into()),
                text: "Hello".into(),
                figure_cues: vec![
                    cue.clone(),
                    cue,
                    FigureCue {
                        action: FigureCueAction::Show,
                        character_id: "bob".into(),
                        position: Some(FigureStagePosition::Right),
                        emotion: "angry".into(),
                    },
                ],
            }],
        }];
        let mut tasks = Vec::new();

        ensure_staged_figure_tasks(&mut tasks, &[character("alice"), character("bob")], &drafts);

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].character_ref.as_deref(), Some("alice"));
        assert_eq!(tasks[1].character_ref.as_deref(), Some("bob"));
        assert_eq!(tasks[1].emotion.as_deref(), Some("angry"));
    }
}
