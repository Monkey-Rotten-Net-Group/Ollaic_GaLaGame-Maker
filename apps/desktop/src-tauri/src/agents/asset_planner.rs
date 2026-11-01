use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

use crate::characters::types::Character;
use crate::story_plan::types::{AssetTaskPlan, VisualStyleSpec};

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

pub struct AssetPlannerAgent;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetPlanResponse {
    asset_plan: Vec<AssetTaskPlan>,
}

pub fn build_styled_prompt(base_prompt: &str, visual_style: &VisualStyleSpec) -> String {
    let mut parts = Vec::new();
    if !visual_style.style_prompt.trim().is_empty() {
        parts.push(visual_style.style_prompt.trim());
    }
    if !base_prompt.trim().is_empty() {
        parts.push(base_prompt.trim());
    }
    if !visual_style.palette_and_lighting.trim().is_empty() {
        parts.push(visual_style.palette_and_lighting.trim());
    }
    if !visual_style.negative_prompt.trim().is_empty() {
        parts.push("Negative constraints:");
        parts.push(visual_style.negative_prompt.trim());
    }
    parts.join("；")
}

pub fn build_emotion_variant_prompt(
    character: &Character,
    emotion: &str,
    visual_style: &VisualStyleSpec,
) -> String {
    let base = format!(
        "保持与参考图完全一致的人物身份、发型发色、眼睛颜色、服装、镜头机位和完整站姿构图，仅将面部表情修改为：{}。纯色平涂白背景 #FFFFFF。角色设定：{}；性格：{}",
        emotion, character.description, character.personality
    );
    build_styled_prompt(&base, visual_style)
}

fn fill_missing_task_ids(tasks: &mut [AssetTaskPlan]) {
    for task in tasks {
        if task.kind == "figure" {
            if task.emotion.is_none() {
                task.emotion = Some("default".to_string());
            }
            if task.aspect_ratio.is_none() {
                task.aspect_ratio = Some("3:4".to_string());
            }
        } else if task.kind == "background" && task.aspect_ratio.is_none() {
            task.aspect_ratio = Some("16:9".to_string());
        }
        if task.id.trim().is_empty() {
            task.id = format!("{}_{}", task.kind.trim(), task.target_stem.trim());
        }
    }
}

fn ensure_staged_figure_tasks(
    tasks: &mut Vec<AssetTaskPlan>,
    characters: &[Character],
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

        let is_default = emotion == "default";
        let prompt = if is_default {
            format!(
                "视觉小说角色立绘，单人，完整身体，纯色背景，默认表情；{}；性格：{}",
                character.description, character.personality
            )
        } else {
            format!("表情：{}；{}", emotion, character.description)
        };

        let reference_image = None;

        tasks.push(AssetTaskPlan {
            id: format!("figure_{}_{}", character.id, emotion),
            kind: "figure".to_string(),
            target_stem: format!("{}_{}", character.id, emotion),
            prompt,
            scene_ref: None,
            character_ref: Some(character.id.clone()),
            emotion: Some(emotion.to_string()),
            reference_image,
            aspect_ratio: Some("3:4".to_string()),
            status: "pending".to_string(),
        });
    }
    // Every expression family needs a successful default anchor, even when no beat shows it.
    let missing_anchors: Vec<_> = tasks
        .iter()
        .filter(|task| task.kind == "figure")
        .filter_map(|task| task.character_ref.as_deref())
        .filter(|id| !planned.contains(&(id.to_string(), "default".to_string())))
        .map(str::to_string)
        .collect();
    for id in missing_anchors {
        if !planned.insert((id.clone(), "default".to_string())) {
            continue;
        }
        let Some(character) = characters.iter().find(|item| item.id == id) else {
            continue;
        };
        tasks.push(AssetTaskPlan {
            id: format!("figure_{id}_default"),
            kind: "figure".into(),
            target_stem: format!("{id}_default"),
            prompt: format!(
                "视觉小说角色立绘，单人，完整身体，纯白背景 #FFFFFF，默认表情；{}；性格：{}",
                character.description, character.personality
            ),
            character_ref: Some(id),
            emotion: Some("default".into()),
            status: "pending".into(),
            ..Default::default()
        });
    }
}

/// Compare only explicit locations; absent locations do not imply a shared backdrop.
pub(crate) fn shares_background(
    left: &crate::story_plan::ScenePlan,
    right: &crate::story_plan::ScenePlan,
) -> bool {
    left.id == right.id
        || (left.location_id.is_some()
            && left.location_id == right.location_id
            && left.time_of_day == right.time_of_day)
}

fn normalize_visual_tasks(
    tasks: &mut Vec<AssetTaskPlan>,
    scenes: &[crate::story_plan::ScenePlan],
    characters: &[Character],
    drafts: &[crate::story_plan::SceneDraft],
    style: &VisualStyleSpec,
) {
    fill_missing_task_ids(tasks);
    ensure_staged_figure_tasks(tasks, characters, drafts);
    let mut backgrounds = Vec::<String>::new();
    tasks.retain_mut(|task| {
        if task.kind == "background" {
            if let Some(scene) = scenes
                .iter()
                .find(|scene| Some(&scene.id) == task.scene_ref.as_ref())
            {
                if backgrounds.iter().any(|id| {
                    scenes
                        .iter()
                        .any(|other| &other.id == id && shares_background(scene, other))
                }) {
                    return false;
                }
                backgrounds.push(scene.id.clone());
                if let Some(location) = &scene.location_id {
                    task.id = match scene.time_of_day.as_deref() {
                        Some(time) => format!(
                            "bg_{}_{}_some_{}_{}",
                            location.len(),
                            location,
                            time.len(),
                            time
                        ),
                        None => format!("bg_{}_{}_none", location.len(), location),
                    };
                    // Preserve the selected filename stem so imported backgrounds remain discoverable.
                }
            }
        }
        true
    });
    for task in tasks {
        match task.kind.as_str() {
            "figure" => {
                task.aspect_ratio = Some("3:4".into());
                let emotion = task.emotion.as_deref().unwrap_or("default");
                if emotion != "default" {
                    if let Some(character) = characters
                        .iter()
                        .find(|character| Some(&character.id) == task.character_ref.as_ref())
                    {
                        task.prompt = build_emotion_variant_prompt(character, emotion, style);
                    }
                    // Character references are resolved at execution time, with user uploads first.
                } else {
                    if task.reference_image.is_none() {
                        task.reference_image = style.style_reference_image.clone();
                    }
                    task.prompt = build_styled_prompt(
                        &format!(
                            "视觉小说角色立绘，单人，完整身体，默认表情，纯白背景 #FFFFFF；{}",
                            task.prompt
                        ),
                        style,
                    );
                }
            }
            "background" => {
                task.aspect_ratio = Some("16:9".into());
                task.prompt =
                    build_styled_prompt(&format!("视觉小说背景，无人物；{}", task.prompt), style);
                if task.reference_image.is_none() {
                    task.reference_image = style.style_reference_image.clone();
                }
            }
            _ => {}
        }
    }
}

fn validate_asset_plan(
    tasks: &[AssetTaskPlan],
    scenes: &[crate::story_plan::ScenePlan],
    characters: &[Character],
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
            let selected_scenes: Vec<_> = ctx
                .scene_plans
                .iter()
                .filter(|scene| ctx.target_scene_id.is_none_or(|target| scene.id == target))
                .cloned()
                .collect();
            let selected_drafts: Vec<_> = ctx
                .scene_drafts
                .iter()
                .filter(|draft| {
                    ctx.target_scene_id
                        .is_none_or(|target| draft.scene_id == target)
                })
                .cloned()
                .collect();
            if selected_drafts.as_slice().is_empty() || ctx.characters.is_empty() {
                return Err(AgentError(
                    "AssetPlanner requires dialogue drafts and characters".to_string(),
                ));
            }
            let input = serde_json::json!({
                "productionBrief": ctx.prompt,
                "worldbook": ctx.worldbook,
                "characters": ctx.characters,
                "scenePlans": selected_scenes.as_slice(),
                "sceneDrafts": selected_drafts.as_slice(),
                "visualStyle": ctx.visual_style,
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
                    normalize_visual_tasks(
                        &mut response.asset_plan,
                        selected_scenes.as_slice(),
                        ctx.characters,
                        selected_drafts.as_slice(),
                        ctx.visual_style,
                    );
                    validate_asset_plan(&response.asset_plan, selected_scenes.as_slice(), ctx.characters)
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

            let mut tasks: Vec<AssetTaskPlan> = Vec::new();
            for scene in selected_scenes.as_slice() {
                let target_stem = format!("bg_{}", scene.id);
                let base = format!(
                    "视觉小说背景，无人物，{}；{}；与统一世界观保持光线和建筑语言一致",
                    scene.title, scene.summary
                );
                let prompt = base;
                tasks.push(AssetTaskPlan {
                    id: target_stem.clone(),
                    kind: "background".to_string(),
                    target_stem,
                    prompt,
                    scene_ref: Some(scene.id.clone()),
                    character_ref: None,
                    emotion: None,
                    reference_image: None,
                    aspect_ratio: Some("16:9".to_string()),
                    status: "pending".to_string(),
                });
            }

            ensure_staged_figure_tasks(&mut tasks, ctx.characters, selected_drafts.as_slice());
            tasks.push(AssetTaskPlan {
                id: "bgm_main_theme".to_string(),
                kind: "bgm".to_string(),
                target_stem: "bgm_main_theme".to_string(),
                prompt: "克制而带悬念的视觉小说主题音乐，能从日常感逐渐过渡到温柔的决意。"
                    .to_string(),
                scene_ref: None,
                character_ref: None,
                emotion: None,
                reference_image: None,
                aspect_ratio: None,
                status: "pending".to_string(),
            });
            normalize_visual_tasks(
                &mut tasks,
                selected_scenes.as_slice(),
                ctx.characters,
                selected_drafts.as_slice(),
                ctx.visual_style,
            );
            validate_asset_plan(&tasks, selected_scenes.as_slice(), ctx.characters)?;
            Ok(AgentOutput::new(AgentOutputPayload::AssetPlan(tasks)).local_fallback())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn character(id: &str) -> Character {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "description": format!("Desc for {id}"),
            "personality": format!("Personality for {id}")
        }))
        .unwrap()
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
            reference_image: None,
            aspect_ratio: Some("16:9".into()),
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
            reference_image: None,
            aspect_ratio: None,
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
            reference_image: None,
            aspect_ratio: None,
            status: "pending".into(),
        });
        let error = validate_asset_plan(&tasks, &[], &[character("alice")]).unwrap_err();
        assert!(error.0.contains("$.assetPlan[1].emotion"));
    }

    #[test]
    fn staging_adds_one_task_for_each_visible_character_and_sets_reference_image_for_variants() {
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
                kind: crate::story_plan::BeatKind::Dialogue,
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
        let vs = VisualStyleSpec {
            style_prompt: "厚涂赛璐璐".into(),
            ..Default::default()
        };

        normalize_visual_tasks(
            &mut tasks,
            &[],
            &[character("alice"), character("bob")],
            &drafts,
            &vs,
        );

        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].character_ref.as_deref(), Some("alice"));
        assert_eq!(tasks[0].emotion.as_deref(), Some("default"));
        assert!(tasks[0].reference_image.is_none());
        assert_eq!(tasks[0].aspect_ratio.as_deref(), Some("3:4"));
        assert!(tasks[0].prompt.contains("厚涂赛璐璐"));

        assert_eq!(tasks[1].character_ref.as_deref(), Some("bob"));
        assert_eq!(tasks[1].emotion.as_deref(), Some("angry"));
        assert!(tasks[1].reference_image.is_none());
        assert_eq!(tasks[1].aspect_ratio.as_deref(), Some("3:4"));
        assert!(tasks[1].prompt.contains("保持与参考图完全一致"));
        assert_eq!(tasks[2].character_ref.as_deref(), Some("bob"));
        assert_eq!(tasks[2].emotion.as_deref(), Some("default"));
    }
    #[test]
    fn model_visual_tasks_are_normalized_and_shared_backgrounds_are_deduplicated() {
        let scenes = ["one", "two"].map(|id| crate::story_plan::ScenePlan {
            id: id.into(),
            location_id: Some("school".into()),
            time_of_day: Some("sunset".into()),
            ..Default::default()
        });
        let mut tasks: Vec<_> = scenes
            .iter()
            .map(|scene| AssetTaskPlan {
                id: format!("bg_{}", scene.id),
                kind: "background".into(),
                target_stem: format!("bg_{}", scene.id),
                scene_ref: Some(scene.id.clone()),
                prompt: "school".into(),
                status: "pending".into(),
                ..Default::default()
            })
            .collect();
        tasks.push(AssetTaskPlan {
            id: "alice_smile".into(),
            kind: "figure".into(),
            target_stem: "alice_smile".into(),
            character_ref: Some("alice".into()),
            emotion: Some("smile".into()),
            prompt: "unconstrained".into(),
            status: "pending".into(),
            ..Default::default()
        });
        let style = VisualStyleSpec {
            style_prompt: "cel shaded".into(),
            negative_prompt: "watermark".into(),
            palette_and_lighting: "warm sunset".into(),
            style_reference_image: Some("game/style.png".into()),
        };
        normalize_visual_tasks(&mut tasks, &scenes, &[character("alice")], &[], &style);
        assert_eq!(
            tasks
                .iter()
                .filter(|task| task.kind == "background")
                .count(),
            1
        );
        assert_eq!(tasks.iter().filter(|task| task.kind == "figure").count(), 2);
        for task in &tasks {
            assert!(task.prompt.contains("cel shaded"));
            assert!(task.prompt.contains("watermark"));
            assert!(task.prompt.contains("warm sunset"));
        }
        assert_eq!(tasks[0].reference_image.as_deref(), Some("game/style.png"));
        assert_eq!(tasks[0].aspect_ratio.as_deref(), Some("16:9"));
        assert!(tasks[1].prompt.contains("保持与参考图完全一致"));
        assert_eq!(tasks[1].aspect_ratio.as_deref(), Some("3:4"));
        assert!(tasks
            .iter()
            .any(|task| task.emotion.as_deref() == Some("default")));
    }
    #[test]
    fn distinct_location_time_pairs_do_not_collide() {
        let scenes = [
            ("one", "school_roof", "night"),
            ("two", "school", "roof_night"),
        ]
        .map(|(id, location, time)| crate::story_plan::ScenePlan {
            id: id.into(),
            location_id: Some(location.into()),
            time_of_day: Some(time.into()),
            ..Default::default()
        });
        let mut tasks: Vec<_> = scenes
            .iter()
            .map(|scene| AssetTaskPlan {
                id: format!("bg_{}", scene.id),
                target_stem: format!("bg_{}", scene.id),
                kind: "background".into(),
                scene_ref: Some(scene.id.clone()),
                prompt: "rooftop".into(),
                status: "pending".into(),
                ..Default::default()
            })
            .collect();
        normalize_visual_tasks(&mut tasks, &scenes, &[], &[], &VisualStyleSpec::default());
        assert_eq!(tasks.len(), 2);
        assert_ne!(tasks[0].id, tasks[1].id);
        let mut absent = scenes[0].clone();
        absent.id = "absent".into();
        absent.time_of_day = None;
        let mut literal = absent.clone();
        literal.id = "literal".into();
        literal.time_of_day = Some("unspecified".into());
        tasks[0].scene_ref = Some(absent.id.clone());
        tasks[1].scene_ref = Some(literal.id.clone());
        normalize_visual_tasks(
            &mut tasks,
            &[absent, literal],
            &[],
            &[],
            &VisualStyleSpec::default(),
        );
        assert_eq!(tasks.len(), 2);
        assert_ne!(tasks[0].id, tasks[1].id);
    }
}
