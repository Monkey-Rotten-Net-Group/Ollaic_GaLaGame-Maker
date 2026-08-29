use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

use crate::characters::types::Character;

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

pub struct CharacterAgent;

#[derive(Deserialize)]
struct CharacterResponse {
    characters: Vec<Character>,
}

impl Agent for CharacterAgent {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            if ctx.scene_plans.is_empty() {
                return Err(AgentError(
                    "Character Agent requires scene plans".to_string(),
                ));
            }
            let input = serde_json::json!({
                "productionBrief": ctx.prompt,
                "synopsis": ctx.synopsis,
                "worldbook": ctx.worldbook,
                "chapters": ctx.chapters,
                "scenePlans": ctx.scene_plans,
                "stepInstruction": ctx.instruction,
                "requirements": "生成 3-5 个可直接保存的角色卡。id 使用稳定英文小写标识，并覆盖 scenePlans.characterIds；若对 provisional characterId 做了小写化、翻译或改名，必须把原值逐字保存在该角色 aliases。name 是 WebGAL 对白中的显示名。description、personality、dialogueStyle、keywords 必须具体。sprites 留空，资产由 P2 生成。"
            });
            if let Some(routed) = generate_structured_validated::<CharacterResponse, _>(
                ctx.chat,
                "Character / 角色设计",
                concat!(
                    "根据剧情结构创建一致、可演出的角色卡。严格使用 JSON：",
                    r#"{"characters":[{"id":"protagonist","name":"...","aliases":[],"description":"...","personality":"...","stance":"...","keywords":["..."],"dialogueStyle":"...","gender":"...","age":"...","sprites":[],"relations":[],"notes":""}]}"#,
                    "。id 和 name 必填，字段使用 camelCase。relations 可留空；若填写，每项必须同时包含 targetId、relationType、description。"
                ),
                &input,
                ctx.allow_local_fallback,
                |response| {
                    discard_incomplete_relations(&mut response.characters);
                    validate_characters(&response.characters, ctx.scene_plans)
                },
            ).await? {
                return Ok(AgentOutput::new(AgentOutputPayload::Characters(
                    routed.value.characters,
                ))
                .with_model(
                    routed.model,
                    routed.prompt_tokens,
                    routed.completion_tokens,
                ));
            }

            let characters = vec![
                CharacterSeed {
                    id: "protagonist",
                    name: "陆川",
                    description: "习惯先观察再行动的转学生，是异常回声的新感知者。",
                    personality: "克制、敏锐、害怕连累别人；越紧张越会用事实掩饰情绪。",
                    dialogue_style: "短句，先确认事实再表达感受；真正下定决心时会直接叫对方名字。",
                    gender: "男",
                    age: "17",
                    keywords: &["主人公", "转学生", "锚点"],
                    stance: "中立",
                }
                .build(),
                CharacterSeed {
                    id: "heroine",
                    name: "林夏",
                    description: "掌握静默协议真相的少女，独自追查被抹去的异常记录。",
                    personality: "冷静外表下有强烈的责任感，不轻易求助，却会记住他人的微小善意。",
                    dialogue_style: "语气简洁，常用反问试探；放下戒备后会把真正担忧藏在玩笑后面。",
                    gender: "女",
                    age: "17",
                    keywords: &["女主角", "知情者", "异常回声"],
                    stance: "越界者",
                }
                .build(),
                CharacterSeed {
                    id: "friend",
                    name: "周遥",
                    description: "主人公在新环境中的第一个朋友，也是维持日常秩序的现实提醒。",
                    personality: "热心、务实、对气氛变化很敏感；不理解秘密，却愿意保护朋友。",
                    dialogue_style: "自然口语，会用具体小事打断沉重气氛；认真时不绕弯子。",
                    gender: "女",
                    age: "17",
                    keywords: &["朋友", "日常", "见证者"],
                    stance: "守序",
                }
                .build(),
            ];
            Ok(AgentOutput::new(AgentOutputPayload::Characters(characters)).local_fallback())
        })
    }
}

struct CharacterSeed<'a> {
    id: &'a str,
    name: &'a str,
    description: &'a str,
    personality: &'a str,
    dialogue_style: &'a str,
    gender: &'a str,
    age: &'a str,
    keywords: &'a [&'a str],
    stance: &'a str,
}

impl CharacterSeed<'_> {
    fn build(self) -> Character {
        Character {
            id: self.id.to_string(),
            name: self.name.to_string(),
            aliases: Vec::new(),
            description: self.description.to_string(),
            personality: self.personality.to_string(),
            reference_images: Vec::new(),
            stance: self.stance.to_string(),
            keywords: self
                .keywords
                .iter()
                .map(|value| value.to_string())
                .collect(),
            dialogue_style: self.dialogue_style.to_string(),
            gender: self.gender.to_string(),
            age: self.age.to_string(),
            sprites: Vec::new(),
            default_voice: None,
            voice_timbre: None,
            relations: Vec::new(),
            color_theme: None,
            notes: String::new(),
        }
    }
}

fn validate_characters(
    characters: &[Character],
    scene_plans: &[crate::story_plan::ScenePlan],
) -> Result<(), AgentError> {
    let mut ids = std::collections::HashSet::new();
    if characters.len() < 2 {
        return Err(contract_error(
            "$.characters",
            "must contain at least 2 characters",
        ));
    }
    for (index, character) in characters.iter().enumerate() {
        let path = format!("$.characters[{index}]");
        if !crate::story_plan::types::is_webgal_flag_value(&character.id) {
            return Err(contract_error(
                format!("{path}.id"),
                "must be a safe WebGAL id",
            ));
        }
        if character.name.trim().is_empty() {
            return Err(contract_error(format!("{path}.name"), "must not be empty"));
        }
        if !ids.insert(character.id.as_str()) {
            return Err(contract_error(format!("{path}.id"), "must be unique"));
        }
        for (field, value) in [
            ("description", character.description.as_str()),
            ("personality", character.personality.as_str()),
            ("dialogueStyle", character.dialogue_style.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(contract_error(
                    format!("{path}.{field}"),
                    "must not be empty",
                ));
            }
        }
        if character.keywords.is_empty() {
            return Err(contract_error(
                format!("{path}.keywords"),
                "must not be empty",
            ));
        }
    }
    for (scene_index, scene) in scene_plans.iter().enumerate() {
        for (character_index, reference) in scene.character_ids.iter().enumerate() {
            let matched = characters.iter().any(|character| {
                reference.eq_ignore_ascii_case(&character.id)
                    || reference == &character.name
                    || character
                        .aliases
                        .iter()
                        .any(|alias| reference.eq_ignore_ascii_case(alias))
            });
            if !matched {
                return Err(contract_error(
                    format!("$.scenePlans[{scene_index}].characterIds[{character_index}]"),
                    format!("has no matching character or alias: {reference}"),
                ));
            }
        }
    }
    for (index, character) in characters.iter().enumerate() {
        for (relation_index, relation) in character.relations.iter().enumerate() {
            if !ids.contains(relation.target_id.as_str()) {
                return Err(contract_error(
                    format!("$.characters[{index}].relations[{relation_index}].targetId"),
                    "references unknown character id",
                ));
            }
        }
    }
    Ok(())
}

fn discard_incomplete_relations(characters: &mut [Character]) {
    for character in characters {
        character.relations.retain(|relation| {
            !relation.target_id.trim().is_empty() && !relation.relation_type.trim().is_empty()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::story_plan::types::{BranchGraph, ScenePlan};

    #[test]
    fn model_response_accepts_numeric_character_age() {
        let response = r#"{"characters":[{"id":"heroine","name":"未来","age":28}]}"#;
        let parsed: CharacterResponse =
            serde_json::from_str(response).expect("numeric age should be accepted");
        assert_eq!(parsed.characters[0].age, "28");
    }

    #[test]
    fn model_response_accepts_incomplete_optional_relations() {
        let response = r#"{"characters":[
            {"id":"hero","name":"陆川","relations":[
                {"relationType":"朋友"},
                {"targetId":"heroine","relationType":"朋友"}
            ]},
            {"id":"heroine","name":"林夏","relations":[{"targetId":"hero"}]}
        ]}"#;
        let mut parsed: CharacterResponse = serde_json::from_str(response)
            .expect("incomplete optional relations should not reject all character cards");
        discard_incomplete_relations(&mut parsed.characters);
        assert_eq!(parsed.characters.len(), 2);
        assert_eq!(parsed.characters[0].relations.len(), 1);
        assert_eq!(parsed.characters[0].relations[0].target_id, "heroine");
        assert!(parsed.characters[1].relations.is_empty());
    }

    #[test]
    fn uncovered_provisional_character_id_reports_upstream_path() {
        let characters = vec![
            CharacterSeed {
                id: "hero",
                name: "陆川",
                description: "主角",
                personality: "谨慎",
                dialogue_style: "短句",
                gender: "男",
                age: "17",
                keywords: &["主角"],
                stance: "中立",
            }
            .build(),
            CharacterSeed {
                id: "heroine",
                name: "林夏",
                description: "女主",
                personality: "冷静",
                dialogue_style: "简洁",
                gender: "女",
                age: "17",
                keywords: &["女主"],
                stance: "越界",
            }
            .build(),
        ];
        let scenes = vec![ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "开场".into(),
            summary: "相遇".into(),
            character_ids: vec!["missing_role".into()],
        }];
        let error = validate_characters(&characters, &scenes).unwrap_err();
        assert!(error.0.contains("$.scenePlans[0].characterIds[0]"));
    }

    #[tokio::test]
    async fn local_character_agent_produces_editable_character_cards() {
        let scenes = vec![ScenePlan {
            id: "opening".into(),
            file: "start.txt".into(),
            chapter_id: "ch1".into(),
            title: "开场".into(),
            summary: "相遇".into(),
            character_ids: vec!["protagonist".into()],
        }];
        let agent = CharacterAgent;
        let ctx = AgentContext {
            chat: &crate::agents::router::NoChatGateway,
            prompt: "校园悬疑恋爱",
            instruction: "",
            synopsis: "相遇",
            chapters: &[],
            worldbook: "规则",
            glossary: &Default::default(),
            characters: &[],
            scene_plans: &scenes,
            branches: &BranchGraph::default(),
            scene_drafts: &[],
            asset_plan: &[],
            allow_local_fallback: true,
        };
        let out = agent.run(&ctx).await.unwrap();
        let AgentOutputPayload::Characters(characters) = out.payload else {
            panic!("Character Agent must return characters")
        };
        assert_eq!(characters.len(), 3);
        assert!(characters
            .iter()
            .all(|character| !character.dialogue_style.is_empty()));
    }
}
