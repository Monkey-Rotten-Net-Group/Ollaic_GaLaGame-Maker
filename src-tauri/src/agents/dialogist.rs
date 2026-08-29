use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

use crate::story_plan::types::{
    DialogueBeat, FigureCue, FigureCueAction, FigureStagePosition, SceneDraft, ScenePlan,
};

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

pub struct DialogistAgent;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DialogistResponse {
    scene_drafts: Vec<SceneDraft>,
}

fn fill_missing_titles(plans: &[ScenePlan], drafts: &mut [SceneDraft]) {
    for draft in drafts {
        if draft.title.trim().is_empty() {
            if let Some(plan) = plans.iter().find(|plan| plan.id == draft.scene_id) {
                draft.title = plan.title.clone();
            }
        }
    }
}

impl Agent for DialogistAgent {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            if ctx.scene_plans.is_empty() || ctx.characters.is_empty() {
                return Err(AgentError(
                    "Dialogist requires scene plans and characters".to_string(),
                ));
            }
            let input = serde_json::json!({
                "productionBrief": ctx.prompt,
                "synopsis": ctx.synopsis,
                "worldbook": ctx.worldbook,
                "glossary": ctx.glossary,
                "characters": ctx.characters,
                "scenePlans": ctx.scene_plans,
                "branches": ctx.branches,
                "stepInstruction": ctx.instruction,
                "requirements": "每个 scenePlan 对应一个 sceneDraft，sceneId 必须一致；每场至少 8 个 beat。speaker 为角色 name 或 null（旁白），text 不含 WebGAL 命令。必须用 figureCues 显式决定镜头需要的角色何时 show/hide；show 必须给项目已有 characterId、left/center/right position 和安全英文 emotion 标签，hide 只需 characterId。可根据演出需要补充 scenePlan 未列出的已有角色，但不要把全部角色默认上屏。对白要推进冲突、体现人物口吻。"
            });
            if let Some(routed) = generate_structured_validated::<DialogistResponse, _>(
                ctx.chat,
                "Dialogist / 场景对白",
                "把场景卡扩写成可编译的结构化旁白、对白和演出。JSON 格式：{\"sceneDrafts\":[{\"sceneId\":\"...\",\"title\":\"...\",\"beats\":[{\"speaker\":null,\"text\":\"...\",\"figureCues\":[{\"action\":\"show\",\"characterId\":\"heroine\",\"position\":\"right\",\"emotion\":\"default\"}]}]}]}。",
                &input,
                ctx.allow_local_fallback,
                |response| {
                    fill_missing_titles(ctx.scene_plans, &mut response.scene_drafts);
                    normalize_figure_cue_character_ids(
                        ctx.characters,
                        &mut response.scene_drafts,
                    );
                    for draft in &mut response.scene_drafts {
                        draft.stage_managed = true;
                    }
                    validate_drafts(ctx.scene_plans, ctx.characters, &response.scene_drafts)
                },
            ).await? {
                return Ok(AgentOutput::new(AgentOutputPayload::SceneDrafts(
                    routed.value.scene_drafts,
                ))
                .with_model(
                    routed.model,
                    routed.prompt_tokens,
                    routed.completion_tokens,
                ));
            }

            let drafts = ctx
                .scene_plans
                .iter()
                .map(|scene| local_draft(scene, ctx.characters))
                .collect();
            Ok(AgentOutput::new(AgentOutputPayload::SceneDrafts(drafts)).local_fallback())
        })
    }
}

fn normalize_figure_cue_character_ids(
    characters: &[crate::characters::types::Character],
    drafts: &mut [SceneDraft],
) {
    for cue in drafts
        .iter_mut()
        .flat_map(|draft| &mut draft.beats)
        .flat_map(|beat| &mut beat.figure_cues)
    {
        if let Some(character) = characters.iter().find(|character| {
            character.id == cue.character_id
                || character.name == cue.character_id
                || character
                    .aliases
                    .iter()
                    .any(|alias| alias == &cue.character_id)
        }) {
            cue.character_id.clone_from(&character.id);
        }
    }
}

fn local_draft(
    scene: &ScenePlan,
    characters: &[crate::characters::types::Character],
) -> SceneDraft {
    let mut beats = match scene.id.as_str() {
        "opening" => vec![
            beat(
                None,
                "放学铃响过很久，走廊尽头的广播却又重复了一遍早晨的报时。",
            ),
            beat(Some("陆川"), "……刚才也是这个时间。"),
            beat(None, "空教室里，窗边的少女按停一台没有接通电源的录音机。"),
            beat(Some("林夏"), "你听见了。那就别装作只是设备故障。"),
            beat(Some("陆川"), "你一直在等能听见的人？"),
            beat(Some("林夏"), "不。我在确认下一个被卷进来的人是谁。"),
            beat(None, "她把录音机推到桌沿，磁带上写着陆川今天才拿到的学号。"),
            beat(Some("林夏"), "现在，你还想把它当成偶然吗？"),
        ],
        "encounter" => vec![
            beat(None, "天台的风把城市噪声压成遥远的低鸣。"),
            beat(Some("林夏"), "异常回声只重复被人刻意抹掉的东西。"),
            beat(Some("陆川"), "所以磁带里的学号，是有人想让我忘记？"),
            beat(Some("林夏"), "也可能是想让我忘记你。"),
            beat(None, "她说得平静，握住栏杆的手却慢慢收紧。"),
            beat(Some("陆川"), "你认识我。至少在我不记得的那段时间里。"),
            beat(Some("林夏"), "先证明你不会在知道代价后逃走。"),
            beat(Some("陆川"), "那就从第一条证据开始。"),
        ],
        "investigation" => vec![
            beat(None, "旧资料室的终端每隔十七秒闪过一次不存在的登录记录。"),
            beat(Some("周遥"), "你们最近的社团活动，是比赛谁更像可疑人物吗？"),
            beat(Some("陆川"), "如果我说是在找一份被删掉的值日表呢？"),
            beat(Some("周遥"), "我会问为什么林夏把出口堵住了。"),
            beat(Some("林夏"), "因为记录开始反向删除看过它的人。"),
            beat(None, "屏幕上，周遥的名字正在一笔一画地消失。"),
            beat(Some("陆川"), "关掉终端。现在。"),
            beat(Some("林夏"), "来不及了。静默协议已经注意到我们。"),
        ],
        "decision" => vec![
            beat(None, "整座教学楼的灯同时熄灭，只剩录音机的转轴仍在转动。"),
            beat(Some("林夏"), "协议会给你一个完整、安稳、没有我的日常。"),
            beat(Some("陆川"), "那你呢？"),
            beat(Some("林夏"), "回到我本来该消失的位置。很公平。"),
            beat(Some("周遥"), "公平不是替别人把选择做完。"),
            beat(None, "录音机吐出最后一截磁带，里面传来陆川自己的声音。"),
            beat(Some("陆川"), "我以前说过，会把你当作确认真实的锚点。"),
            beat(Some("林夏"), "所以这一次，别因为一句旧承诺勉强自己。"),
        ],
        "ending_trust" => vec![
            beat(None, "陆川握住林夏冰冷的手，广播里的报时第一次继续向前。"),
            beat(Some("陆川"), "不是因为旧承诺。是因为现在的我仍然会选你。"),
            beat(Some("林夏"), "越界以后，我们都会失去一部分安全。"),
            beat(Some("陆川"), "那就一起记住失去的部分。"),
            beat(None, "晨光落进走廊，所有被删除的名字短暂地浮现在玻璃上。"),
            beat(Some("林夏"), "第一条新规则：不准一个人擅自承担全部代价。"),
            beat(Some("陆川"), "同意。第二条，遇到异常先叫对方名字。"),
            beat(
                None,
                "他们并肩走向仍未醒来的城市，录音机安静地停在新的刻度。",
            ),
        ],
        "ending_depart" => vec![
            beat(None, "陆川松开手，广播声像潮水一样盖过林夏的名字。"),
            beat(Some("林夏"), "这样就好。明天你只会觉得做了一场很长的梦。"),
            beat(Some("陆川"), "可我为什么已经开始害怕忘记？"),
            beat(Some("林夏"), "因为你一直都比自己以为的更诚实。"),
            beat(None, "灯光恢复时，窗边只剩一台没有标签的录音机。"),
            beat(Some("周遥"), "陆川？你在等谁吗？"),
            beat(Some("陆川"), "不知道。只是觉得这里不该这么安静。"),
            beat(None, "他按下播放键，磁带深处传来一声几乎听不清的笑。"),
        ],
        _ => vec![
            beat(None, &scene.summary),
            beat(Some("陆川"), "我们已经走到这里，不能再假装什么都没发生。"),
            beat(Some("林夏"), "那就看着我，把你真正的选择说出来。"),
            beat(None, "短暂的沉默让两人都听见了彼此没有说出口的担忧。"),
            beat(Some("陆川"), "我会承担自己的那一部分。"),
            beat(Some("林夏"), "记住这句话。我不会让你反悔。"),
            beat(None, "他们越过界线，日常的表面随之出现新的裂痕。"),
            beat(Some("陆川"), "走吧。答案就在前面。"),
        ],
    };
    let by_name: std::collections::HashMap<&str, &str> = characters
        .iter()
        .map(|character| (character.name.as_str(), character.id.as_str()))
        .collect();
    let cast: std::collections::HashSet<&str> =
        scene.character_ids.iter().map(String::as_str).collect();
    let mut visible: Vec<String> = Vec::new();
    for beat in &mut beats {
        let Some(character_id) = beat
            .speaker
            .as_deref()
            .and_then(|speaker| by_name.get(speaker).copied())
            .filter(|id| cast.contains(id))
        else {
            continue;
        };
        if visible.iter().any(|id| id == character_id) {
            continue;
        }
        if visible.len() == 3 {
            beat.figure_cues.push(FigureCue {
                action: FigureCueAction::Hide,
                character_id: visible.remove(0),
                position: None,
                emotion: "default".to_string(),
            });
        }
        let position = match visible.len() {
            0 => FigureStagePosition::Left,
            1 => FigureStagePosition::Right,
            _ => FigureStagePosition::Center,
        };
        beat.figure_cues.push(FigureCue {
            action: FigureCueAction::Show,
            character_id: character_id.to_string(),
            position: Some(position),
            emotion: "default".to_string(),
        });
        visible.push(character_id.to_string());
    }
    SceneDraft {
        scene_id: scene.id.clone(),
        title: scene.title.clone(),
        stage_managed: true,
        beats,
    }
}

fn beat(speaker: Option<&str>, text: &str) -> DialogueBeat {
    DialogueBeat {
        speaker: speaker.map(str::to_string),
        text: text.to_string(),
        figure_cues: Vec::new(),
    }
}

fn validate_drafts(
    plans: &[ScenePlan],
    characters: &[crate::characters::types::Character],
    drafts: &[SceneDraft],
) -> Result<(), AgentError> {
    if drafts.len() != plans.len() {
        return Err(contract_error(
            "$.sceneDrafts",
            format!("must contain exactly {} drafts", plans.len()),
        ));
    }
    let plan_ids: std::collections::HashSet<&str> =
        plans.iter().map(|plan| plan.id.as_str()).collect();
    let mut draft_ids = std::collections::HashSet::new();
    for (draft_index, draft) in drafts.iter().enumerate() {
        let path = format!("$.sceneDrafts[{draft_index}]");
        if !plan_ids.contains(draft.scene_id.as_str()) {
            return Err(contract_error(
                format!("{path}.sceneId"),
                "references unknown scene plan",
            ));
        }
        if !draft_ids.insert(draft.scene_id.as_str()) {
            return Err(contract_error(format!("{path}.sceneId"), "must be unique"));
        }
        if draft.title.trim().is_empty() {
            return Err(contract_error(format!("{path}.title"), "must not be empty"));
        }
        if draft.beats.len() < 8 {
            return Err(contract_error(
                format!("{path}.beats"),
                "must contain at least 8 beats",
            ));
        }
    }
    let character_ids: std::collections::HashSet<&str> = characters
        .iter()
        .map(|character| character.id.as_str())
        .collect();
    let character_names: std::collections::HashSet<&str> = characters
        .iter()
        .flat_map(|character| {
            std::iter::once(character.name.as_str())
                .chain(character.aliases.iter().map(String::as_str))
        })
        .collect();
    for (draft_index, draft) in drafts.iter().enumerate() {
        for (beat_index, beat) in draft.beats.iter().enumerate() {
            let beat_path = format!("$.sceneDrafts[{draft_index}].beats[{beat_index}]");
            if beat.text.trim().is_empty() {
                return Err(contract_error(
                    format!("{beat_path}.text"),
                    "must not be empty",
                ));
            }
            if let Some(speaker) = beat.speaker.as_deref() {
                if !character_names.contains(speaker) {
                    return Err(contract_error(
                        format!("{beat_path}.speaker"),
                        format!("references unknown character name or alias: {speaker}"),
                    ));
                }
            }
        }
        for (beat_index, cue_index, cue) in
            draft
                .beats
                .iter()
                .enumerate()
                .flat_map(|(beat_index, beat)| {
                    beat.figure_cues
                        .iter()
                        .enumerate()
                        .map(move |(cue_index, cue)| (beat_index, cue_index, cue))
                })
        {
            let error = if !character_ids.contains(cue.character_id.as_str()) {
                Some(("characterId", "references unknown character"))
            } else if !crate::story_plan::types::is_webgal_flag_value(&cue.character_id) {
                Some(("characterId", "must be safe for WebGAL"))
            } else if cue.action == crate::story_plan::FigureCueAction::Show
                && cue.position.is_none()
            {
                Some(("position", "required for show cues"))
            } else if cue.action == crate::story_plan::FigureCueAction::Show
                && !crate::story_plan::types::is_webgal_flag_value(&cue.emotion)
            {
                Some(("emotion", "must be a safe label for show cues"))
            } else {
                None
            };
            if let Some((field, reason)) = error {
                return Err(contract_error(
                    format!(
                        "$.sceneDrafts[{draft_index}].beats[{beat_index}].figureCues[{cue_index}].{field}"
                    ),
                    reason,
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_response_without_draft_title_uses_scene_title() {
        let response = r#"{
            "sceneDrafts":[{
                "sceneId":"opening",
                "beats":[{"speaker":null,"text":"黄昏的教室很安静。"}]
            }]
        }"#;
        let plans = vec![ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "初次相遇".into(),
            summary: String::new(),
            character_ids: Vec::new(),
        }];

        let mut parsed: DialogistResponse =
            serde_json::from_str(response).expect("missing draft title should be recoverable");
        fill_missing_titles(&plans, &mut parsed.scene_drafts);
        assert_eq!(parsed.scene_drafts[0].title, "初次相遇");
    }

    #[test]
    fn duplicate_scene_draft_reports_exact_scene_id_path() {
        let plans = ["opening", "ending"].map(|id| ScenePlan {
            id: id.into(),
            file: format!("{id}.txt"),
            chapter_id: "ch1".into(),
            title: id.into(),
            summary: id.into(),
            character_ids: Vec::new(),
        });
        let beats = (0..8)
            .map(|index| DialogueBeat {
                speaker: None,
                text: format!("beat {index}"),
                figure_cues: Vec::new(),
            })
            .collect::<Vec<_>>();
        let drafts = vec![
            SceneDraft {
                scene_id: "opening".into(),
                title: "Opening".into(),
                stage_managed: true,
                beats: beats.clone(),
            },
            SceneDraft {
                scene_id: "opening".into(),
                title: "Duplicate".into(),
                stage_managed: true,
                beats,
            },
        ];
        let error = validate_drafts(&plans, &[], &drafts).unwrap_err();
        assert!(error.0.contains("$.sceneDrafts[1].sceneId"));
    }

    #[test]
    fn local_opening_is_readable_dialogue() {
        let scene = ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "开场".into(),
            summary: "相遇".into(),
            character_ids: vec!["heroine".into()],
        };
        let characters = vec![serde_json::from_value(serde_json::json!({
            "id": "heroine", "name": "林夏"
        }))
        .unwrap()];
        let draft = local_draft(&scene, &characters);
        assert!(draft.beats.len() >= 8);
        assert!(draft.stage_managed);
        assert!(draft
            .beats
            .iter()
            .flat_map(|beat| &beat.figure_cues)
            .any(|cue| cue.character_id == "heroine"));
        assert!(draft
            .beats
            .iter()
            .any(|beat| beat.speaker.as_deref() == Some("林夏")));
    }

    #[test]
    fn figure_cue_character_name_normalizes_to_stable_id() {
        let characters = vec![serde_json::from_value(serde_json::json!({
            "id": "ailla", "name": "艾拉", "aliases": ["Aila"]
        }))
        .unwrap()];
        let mut drafts = vec![SceneDraft {
            scene_id: "opening".into(),
            title: "Opening".into(),
            stage_managed: true,
            beats: vec![DialogueBeat {
                speaker: Some("艾拉".into()),
                text: "走吧。".into(),
                figure_cues: vec![FigureCue {
                    action: FigureCueAction::Show,
                    character_id: "艾拉".into(),
                    position: Some(FigureStagePosition::Left),
                    emotion: "default".into(),
                }],
            }],
        }];

        normalize_figure_cue_character_ids(&characters, &mut drafts);

        assert_eq!(drafts[0].beats[0].figure_cues[0].character_id, "ailla");
        drafts[0].beats.extend((0..7).map(|index| DialogueBeat {
            speaker: None,
            text: format!("Narration {index}"),
            figure_cues: Vec::new(),
        }));
        let plans = vec![ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: String::new(),
            character_ids: Vec::new(),
        }];
        validate_drafts(&plans, &characters, &drafts).unwrap();
    }

    #[test]
    fn known_character_cue_can_expand_planned_scene_cast() {
        let characters: Vec<crate::characters::types::Character> =
            serde_json::from_value(serde_json::json!([
                {"id":"erin","name":"艾琳"},
                {"id":"viper","name":"毒蛇"}
            ]))
            .unwrap();
        let plans = vec![ScenePlan {
            id: "ambush".into(),
            file: "ambush.txt".into(),
            chapter_id: "ch2".into(),
            title: "Ambush".into(),
            summary: String::new(),
            character_ids: vec!["erin".into()],
        }];
        let mut beats = vec![DialogueBeat {
            speaker: Some("毒蛇".into()),
            text: "抓住他们。".into(),
            figure_cues: vec![FigureCue {
                action: FigureCueAction::Show,
                character_id: "viper".into(),
                position: Some(FigureStagePosition::Right),
                emotion: "angry".into(),
            }],
        }];
        beats.extend((0..7).map(|index| DialogueBeat {
            speaker: None,
            text: format!("Narration {index}"),
            figure_cues: Vec::new(),
        }));
        let drafts = vec![SceneDraft {
            scene_id: "ambush".into(),
            title: "Ambush".into(),
            stage_managed: true,
            beats,
        }];

        validate_drafts(&plans, &characters, &drafts).unwrap();
    }

    #[test]
    fn invalid_figure_cue_reports_exact_field_path() {
        let characters: Vec<crate::characters::types::Character> =
            serde_json::from_value(serde_json::json!([{"id":"alice","name":"Alice"}])).unwrap();
        let plans = vec![ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "Opening".into(),
            summary: "Summary".into(),
            character_ids: vec!["alice".into()],
        }];
        let mut beats = (0..8)
            .map(|index| DialogueBeat {
                speaker: None,
                text: format!("Beat {index}"),
                figure_cues: Vec::new(),
            })
            .collect::<Vec<_>>();
        beats[0].figure_cues.push(FigureCue {
            action: FigureCueAction::Show,
            character_id: "alice".into(),
            position: None,
            emotion: "default".into(),
        });
        let drafts = vec![SceneDraft {
            scene_id: "opening".into(),
            title: "Opening".into(),
            stage_managed: true,
            beats,
        }];

        let error = validate_drafts(&plans, &characters, &drafts).unwrap_err();
        assert!(error
            .0
            .contains("$.sceneDrafts[0].beats[0].figureCues[0].position"));
    }
}
