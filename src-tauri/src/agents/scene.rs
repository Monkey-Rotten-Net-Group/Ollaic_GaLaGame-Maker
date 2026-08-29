use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use crate::story_plan::types::{
    AssetTaskPlan, BranchGraph, DialogueBeat, FigureCue, FigureCueAction, FigureStagePosition,
    SceneDraft, ScenePlan,
};

use super::router::contract_error;
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload, SceneScript};

/// Deterministically compiles structured Dialogist output into editable WebGAL.
pub struct SceneAgent;

impl Agent for SceneAgent {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            validate_scene_inputs(
                ctx.scene_plans,
                ctx.scene_drafts,
                ctx.branches,
                ctx.characters,
                ctx.asset_plan,
            )?;
            let by_draft: HashMap<&str, &SceneDraft> = ctx
                .scene_drafts
                .iter()
                .map(|draft| (draft.scene_id.as_str(), draft))
                .collect();
            let by_file: HashMap<&str, &str> = ctx
                .scene_plans
                .iter()
                .map(|scene| (scene.id.as_str(), scene.file.as_str()))
                .collect();
            let figure_targets: HashMap<(&str, &str), &str> = ctx
                .asset_plan
                .iter()
                .filter(|task| task.kind == "figure")
                .filter_map(|task| {
                    Some((
                        (task.character_ref.as_deref()?, task.emotion.as_deref()?),
                        task.id.as_str(),
                    ))
                })
                .collect();
            let mut scripts = Vec::with_capacity(ctx.scene_plans.len());
            for scene in ctx.scene_plans {
                let draft = by_draft.get(scene.id.as_str()).ok_or_else(|| {
                    AgentError(format!(
                        "SceneScript is missing draft for scene {}",
                        scene.id
                    ))
                })?;
                let mut lines = vec![
                    format!("; Ollaic Agent scene: {}", clean(&scene.title)),
                    format!(
                        "; Planned assets in this production: {}",
                        ctx.asset_plan.len()
                    ),
                    format!("intro:{};", clean(&scene.title)),
                ];
                if draft.stage_managed {
                    lines.push("; Ollaic Scene Staging".to_string());
                }
                for beat in &draft.beats {
                    for cue in &beat.figure_cues {
                        lines.extend(compile_figure_cue(cue, &figure_targets)?);
                    }
                    lines.push(compile_beat(beat));
                }
                let outgoing: Vec<_> = ctx
                    .branches
                    .edges
                    .iter()
                    .filter(|edge| edge.from == scene.id)
                    .collect();
                if outgoing.len() > 1 || outgoing.iter().any(|edge| edge.choice.is_some()) {
                    let choices = outgoing
                        .iter()
                        .map(|edge| {
                            let label = clean_choice(edge.choice.as_deref().unwrap_or("继续"));
                            let file = by_file
                                .get(edge.to.as_str())
                                .copied()
                                .expect("validated branch target");
                            format!("{}:{}", label, file)
                        })
                        .collect::<Vec<_>>()
                        .join("|");
                    lines.push(format!("choose:{};", choices));
                } else if let Some(edge) = outgoing.first() {
                    let file = by_file.get(edge.to.as_str()).copied().ok_or_else(|| {
                        AgentError(format!(
                            "SceneScript branch targets unknown scene {}",
                            edge.to
                        ))
                    })?;
                    lines.push(format!("changeScene:{};", file));
                } else {
                    lines.push("end;".to_string());
                }
                let content = lines.join("\n") + "\n";
                validate_script(&scene.file, &content)?;
                scripts.push(SceneScript {
                    name: scene.file.clone(),
                    content,
                });
            }
            Ok(AgentOutput::new(AgentOutputPayload::Scenes(scripts)))
        })
    }
}

fn validate_scene_inputs(
    scene_plans: &[ScenePlan],
    drafts: &[SceneDraft],
    branches: &BranchGraph,
    characters: &[crate::characters::types::Character],
    asset_plan: &[AssetTaskPlan],
) -> Result<(), AgentError> {
    if scene_plans.is_empty() {
        return Err(contract_error("$.scenePlans", "must not be empty"));
    }
    if drafts.is_empty() {
        return Err(contract_error("$.sceneDrafts", "must not be empty"));
    }
    let scene_ids: std::collections::HashSet<&str> =
        scene_plans.iter().map(|scene| scene.id.as_str()).collect();
    let character_ids: std::collections::HashSet<&str> = characters
        .iter()
        .map(|character| character.id.as_str())
        .collect();
    if !scene_ids.contains(branches.entry_scene.as_str()) {
        return Err(contract_error(
            "$.branches.entryScene",
            "references unknown scene",
        ));
    }
    let mut draft_ids = std::collections::HashSet::new();
    for (draft_index, draft) in drafts.iter().enumerate() {
        if !scene_ids.contains(draft.scene_id.as_str()) {
            return Err(contract_error(
                format!("$.sceneDrafts[{draft_index}].sceneId"),
                format!("references unknown scene: {}", draft.scene_id),
            ));
        }
        if !draft_ids.insert(draft.scene_id.as_str()) {
            return Err(contract_error(
                format!("$.sceneDrafts[{draft_index}].sceneId"),
                "must be unique",
            ));
        }
        let cast: std::collections::HashSet<&str> = scene_plans
            .iter()
            .find(|scene| scene.id == draft.scene_id)
            .expect("known draft scene")
            .character_ids
            .iter()
            .map(String::as_str)
            .collect();
        for (beat_index, beat) in draft.beats.iter().enumerate() {
            for (cue_index, cue) in beat.figure_cues.iter().enumerate() {
                let path = format!(
                    "$.sceneDrafts[{draft_index}].beats[{beat_index}].figureCues[{cue_index}]"
                );
                if !character_ids.contains(cue.character_id.as_str())
                    || !cast.contains(cue.character_id.as_str())
                {
                    return Err(contract_error(
                        format!("{path}.characterId"),
                        format!(
                            "references character outside this scene: {}",
                            cue.character_id
                        ),
                    ));
                }
                if cue.action == FigureCueAction::Show {
                    if cue.position.is_none() {
                        return Err(contract_error(
                            format!("{path}.position"),
                            "required for show cues",
                        ));
                    }
                    if !crate::story_plan::types::is_webgal_flag_value(&cue.emotion) {
                        return Err(contract_error(
                            format!("{path}.emotion"),
                            "must be a safe label",
                        ));
                    }
                    if !asset_plan.iter().any(|task| {
                        task.kind == "figure"
                            && task.character_ref.as_deref() == Some(cue.character_id.as_str())
                            && task.emotion.as_deref() == Some(cue.emotion.as_str())
                    }) {
                        return Err(contract_error(
                            "$.assetPlan",
                            format!(
                                "missing figure task for {}/{} referenced by {path}",
                                cue.character_id, cue.emotion
                            ),
                        ));
                    }
                }
            }
        }
    }
    for scene in scene_plans {
        if !draft_ids.contains(scene.id.as_str()) {
            return Err(contract_error(
                "$.sceneDrafts",
                format!("missing draft for scene: {}", scene.id),
            ));
        }
    }
    for (index, edge) in branches.edges.iter().enumerate() {
        for (field, scene) in [("from", &edge.from), ("to", &edge.to)] {
            if !scene_ids.contains(scene.as_str()) {
                return Err(contract_error(
                    format!("$.branches.edges[{index}].{field}"),
                    format!("references unknown scene: {scene}"),
                ));
            }
        }
    }
    Ok(())
}

fn compile_figure_cue(
    cue: &FigureCue,
    figure_targets: &HashMap<(&str, &str), &str>,
) -> Result<Vec<String>, AgentError> {
    if !crate::story_plan::types::is_webgal_flag_value(&cue.character_id) {
        return Err(AgentError(
            "figure cue has an invalid characterId".to_string(),
        ));
    }
    let character = &cue.character_id;
    if cue.action == FigureCueAction::Hide {
        return Ok(vec![format!("changeFigure:none -id={character};")]);
    }
    if !crate::story_plan::types::is_webgal_flag_value(&cue.emotion) {
        return Err(AgentError("figure cue has an invalid emotion".to_string()));
    }
    let task_id = figure_targets
        .get(&(cue.character_id.as_str(), cue.emotion.as_str()))
        .ok_or_else(|| {
            AgentError(format!(
                "figure cue references character/emotion without an asset task: {}/{}",
                cue.character_id, cue.emotion
            ))
        })?;
    let position = match cue.position {
        Some(FigureStagePosition::Left) => "left",
        Some(FigureStagePosition::Center) => "center",
        Some(FigureStagePosition::Right) => "right",
        None => {
            return Err(AgentError(format!(
                "show figure cue has no position: {}",
                cue.character_id
            )))
        }
    };
    Ok(vec![
        format!("; {}", crate::asset_queue::binder::task_marker(task_id)),
        format!(
            "; {}",
            crate::asset_queue::binder::staged_figure_command(&format!(
                "changeFigure:none -id={character} -figureCharacter={character} -figureEmotion={} -{position};",
                cue.emotion
            ))
        ),
    ])
}

fn compile_beat(beat: &DialogueBeat) -> String {
    let text = clean(&beat.text);
    match beat
        .speaker
        .as_deref()
        .map(str::trim)
        .filter(|speaker| !speaker.is_empty())
    {
        Some(speaker) => format!("{}:{};", clean(speaker).replace(':', "："), text),
        None => format!(":{};", text),
    }
}

fn clean(value: &str) -> String {
    value.trim().replace(['\r', '\n'], " ").replace(';', "；")
}

fn clean_choice(value: &str) -> String {
    clean(value).replace([':', '|'], " ")
}

fn validate_script(name: &str, content: &str) -> Result<(), AgentError> {
    let stem = name.strip_suffix(".txt").unwrap_or("");
    if stem.is_empty()
        || !stem
            .chars()
            .all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-')
        || std::path::Path::new(name)
            .file_name()
            .and_then(|value| value.to_str())
            != Some(name)
    {
        return Err(AgentError(format!(
            "invalid WebGAL scene file name: {name}"
        )));
    }
    if content
        .lines()
        .any(|line| !line.starts_with(';') && !line.ends_with(';'))
    {
        return Err(AgentError(format!(
            "scene {name} contains an unterminated WebGAL command"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::story_plan::types::{
        AssetTaskPlan, BranchEdge, BranchGraph, FigureCue, FigureCueAction, FigureStagePosition,
        ScenePlan,
    };

    #[tokio::test]
    async fn scene_agent_compiles_multiple_linked_webgal_files() {
        let plans = vec![
            ScenePlan {
                id: "opening".into(),
                file: "start.txt".into(),
                chapter_id: "ch1".into(),
                title: "开场".into(),
                summary: "相遇".into(),
                character_ids: vec!["heroine".into(), "friend".into()],
            },
            ScenePlan {
                id: "end".into(),
                file: "ending.txt".into(),
                chapter_id: "ch1".into(),
                title: "结尾".into(),
                summary: "告别".into(),
                character_ids: Vec::new(),
            },
        ];
        let drafts = vec![
            SceneDraft {
                scene_id: "opening".into(),
                title: "开场".into(),
                stage_managed: true,
                beats: vec![
                    DialogueBeat {
                        speaker: Some("林夏".into()),
                        text: "你终于来了。".into(),
                        figure_cues: vec![
                            FigureCue {
                                action: FigureCueAction::Show,
                                character_id: "heroine".into(),
                                position: Some(FigureStagePosition::Right),
                                emotion: "default".into(),
                            },
                            FigureCue {
                                action: FigureCueAction::Show,
                                character_id: "friend".into(),
                                position: Some(FigureStagePosition::Left),
                                emotion: "surprised".into(),
                            },
                        ],
                    },
                    DialogueBeat {
                        speaker: None,
                        text: "她离开了教室。".into(),
                        figure_cues: vec![FigureCue {
                            action: FigureCueAction::Hide,
                            character_id: "heroine".into(),
                            position: None,
                            emotion: "default".into(),
                        }],
                    },
                ],
            },
            SceneDraft {
                scene_id: "end".into(),
                title: "结尾".into(),
                stage_managed: false,
                beats: vec![DialogueBeat {
                    speaker: None,
                    text: "天亮了。".into(),
                    figure_cues: Vec::new(),
                }],
            },
        ];
        let branches = BranchGraph {
            entry_scene: "opening".into(),
            edges: vec![BranchEdge {
                from: "opening".into(),
                to: "end".into(),
                choice: None,
            }],
        };
        let characters = vec![
            serde_json::from_value(serde_json::json!({"id":"heroine","name":"林夏"})).unwrap(),
            serde_json::from_value(serde_json::json!({"id":"friend","name":"周遥"})).unwrap(),
        ];
        let agent = SceneAgent;
        let ctx = AgentContext {
            chat: &crate::agents::router::NoChatGateway,
            prompt: "",
            instruction: "",
            synopsis: "",
            chapters: &[],
            worldbook: "",
            glossary: &Default::default(),
            characters: &characters,
            scene_plans: &plans,
            branches: &branches,
            scene_drafts: &drafts,
            asset_plan: &[
                AssetTaskPlan {
                    id: "figure_heroine_default".into(),
                    kind: "figure".into(),
                    target_stem: "heroine_default".into(),
                    prompt: "林夏立绘".into(),
                    scene_ref: None,
                    character_ref: Some("heroine".into()),
                    emotion: Some("default".into()),
                    status: "pending".into(),
                },
                AssetTaskPlan {
                    id: "figure_friend_surprised".into(),
                    kind: "figure".into(),
                    target_stem: "friend_surprised".into(),
                    prompt: "周遥惊讶立绘".into(),
                    scene_ref: None,
                    character_ref: Some("friend".into()),
                    emotion: Some("surprised".into()),
                    status: "pending".into(),
                },
            ],
            allow_local_fallback: true,
        };
        let AgentOutputPayload::Scenes(scripts) = agent.run(&ctx).await.unwrap().payload else {
            panic!("Scene Agent must return scene files")
        };
        assert_eq!(scripts.len(), 2);
        assert!(scripts[0].content.contains("林夏:你终于来了。;"));
        assert!(scripts[0]
            .content
            .contains("; ollaic-asset-task:figure_heroine_default"));
        assert!(scripts[0].content.contains(
            "; ollaic-figure-staging:changeFigure:none -id=heroine -figureCharacter=heroine -figureEmotion=default -right;"
        ));
        assert!(
            !scripts[0]
                .content
                .lines()
                .any(|line| line
                    .starts_with("changeFigure:none -id=heroine -figureCharacter=heroine"))
        );
        assert!(scripts[0].content.contains(
            "; ollaic-figure-staging:changeFigure:none -id=friend -figureCharacter=friend -figureEmotion=surprised -left;"
        ));
        assert!(scripts[0]
            .content
            .contains("changeFigure:none -id=heroine;"));
        assert!(scripts[0].content.contains("changeScene:ending.txt;"));
        assert!(scripts[1].content.contains("end;"));
    }

    #[test]
    fn scene_input_errors_report_cross_node_paths() {
        let plans = vec![ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: "Summary".into(),
            character_ids: Vec::new(),
        }];
        let error =
            validate_scene_inputs(&plans, &[], &BranchGraph::default(), &[], &[]).unwrap_err();
        assert!(error.0.contains("$.sceneDrafts"));

        let drafts = vec![SceneDraft {
            scene_id: "opening".into(),
            title: "Opening".into(),
            stage_managed: false,
            beats: vec![DialogueBeat {
                speaker: None,
                text: "Text".into(),
                figure_cues: Vec::new(),
            }],
        }];
        let branches = BranchGraph {
            entry_scene: "opening".into(),
            edges: vec![BranchEdge {
                from: "opening".into(),
                to: "missing".into(),
                choice: Some("Go".into()),
            }],
        };
        let error = validate_scene_inputs(&plans, &drafts, &branches, &[], &[]).unwrap_err();
        assert!(error.0.contains("$.branches.edges[0].to"));
    }
}
