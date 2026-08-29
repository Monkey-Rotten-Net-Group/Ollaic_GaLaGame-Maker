use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

use crate::story_plan::types::{BranchEdge, BranchGraph, ChapterPlan, ScenePlan};

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

/// Plotter: turns canon into chapters, scene cards, and an explicit branch graph.
pub struct OutlineAgent;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlineResponse {
    chapters: Vec<ChapterPlan>,
    scene_plans: Vec<ScenePlan>,
    branches: BranchGraph,
}

fn fill_missing_summaries(response: &mut OutlineResponse, synopsis: &str) {
    for chapter in &mut response.chapters {
        if chapter.summary.trim().is_empty() {
            chapter.summary = format!("章节“{}”围绕故事主线继续推进：{}", chapter.title, synopsis);
        }
    }
    for scene in &mut response.scene_plans {
        if scene.summary.trim().is_empty() {
            scene.summary = format!("围绕“{}”展开，推进主线冲突与人物关系。", scene.title);
        }
    }
}

fn validate_response(response: &mut OutlineResponse, synopsis: &str) -> Result<(), AgentError> {
    fill_missing_summaries(response, synopsis);
    if response.chapters.is_empty() {
        return Err(contract_error("$.chapters", "must not be empty"));
    }
    if response.scene_plans.len() < 2 {
        return Err(contract_error(
            "$.scenePlans",
            "must contain at least 2 scenes",
        ));
    }
    let mut chapter_ids = std::collections::HashSet::new();
    for (index, chapter) in response.chapters.iter().enumerate() {
        if chapter.id.trim().is_empty() {
            return Err(contract_error(
                format!("$.chapters[{index}].id"),
                "must not be empty",
            ));
        }
        if !chapter_ids.insert(chapter.id.as_str()) {
            return Err(contract_error(
                format!("$.chapters[{index}].id"),
                "must be unique",
            ));
        }
        if chapter.title.trim().is_empty() {
            return Err(contract_error(
                format!("$.chapters[{index}].title"),
                "must not be empty",
            ));
        }
    }
    let mut scene_ids = std::collections::HashSet::new();
    let mut scene_files = std::collections::HashSet::new();
    for (index, scene) in response.scene_plans.iter().enumerate() {
        let path = format!("$.scenePlans[{index}]");
        if scene.id.trim().is_empty() || !scene_ids.insert(scene.id.as_str()) {
            return Err(contract_error(
                format!("{path}.id"),
                "must be non-empty and unique",
            ));
        }
        if !is_safe_scene_file(&scene.file) || !scene_files.insert(scene.file.as_str()) {
            return Err(contract_error(
                format!("{path}.file"),
                "must be a unique safe .txt filename",
            ));
        }
        if !chapter_ids.contains(scene.chapter_id.as_str()) {
            return Err(contract_error(
                format!("{path}.chapterId"),
                "references unknown chapter id",
            ));
        }
        if scene.title.trim().is_empty() {
            return Err(contract_error(format!("{path}.title"), "must not be empty"));
        }
        for (character_index, character) in scene.character_ids.iter().enumerate() {
            if character.trim().is_empty() {
                return Err(contract_error(
                    format!("{path}.characterIds[{character_index}]"),
                    "must not be empty",
                ));
            }
        }
    }
    if !scene_ids.contains(response.branches.entry_scene.as_str()) {
        return Err(contract_error(
            "$.branches.entryScene",
            "references unknown scene id",
        ));
    }
    for (index, edge) in response.branches.edges.iter().enumerate() {
        if !scene_ids.contains(edge.from.as_str()) {
            return Err(contract_error(
                format!("$.branches.edges[{index}].from"),
                "references unknown scene id",
            ));
        }
        if !scene_ids.contains(edge.to.as_str()) {
            return Err(contract_error(
                format!("$.branches.edges[{index}].to"),
                "references unknown scene id",
            ));
        }
    }
    Ok(())
}

fn is_safe_scene_file(file: &str) -> bool {
    let stem = file.strip_suffix(".txt").unwrap_or("");
    !stem.is_empty()
        && stem
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        && std::path::Path::new(file)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(file)
}

impl Agent for OutlineAgent {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            let synopsis = ctx.synopsis.trim();
            if synopsis.is_empty() {
                return Err(AgentError("Plotter requires a synopsis".to_string()));
            }
            let input = serde_json::json!({
                "productionBrief": ctx.prompt,
                "synopsis": synopsis,
                "worldbook": ctx.worldbook,
                "glossary": ctx.glossary,
                "stepInstruction": ctx.instruction,
                "requirements": "生成 3 章、至少 5 个 scene。入口 scene 的 file 必须是 start.txt；其他 file 只能是无路径的 .txt 文件名。scene id 唯一，chapterId 必须引用章节 id。branches.entryScene 和每条 edge 的 from/to 使用 scene id，至少包含一次有 choice 文本的分支。"
            });
            if let Some(routed) = generate_structured_validated::<OutlineResponse, _>(
                ctx.chat,
                "Plotter / 剧情结构",
                concat!(
                    "输出可执行的章节、场景卡和分支拓扑。严格使用 JSON：",
                    r#"{"chapters":[{"id":"ch1","title":"...","summary":"..."}],"scenePlans":[{"id":"opening","file":"start.txt","chapterId":"ch1","title":"...","summary":"...","characterIds":["protagonist"]}],"branches":{"entryScene":"opening","edges":[{"from":"opening","to":"next_scene","choice":null}]}}"#,
                    "。每个 chapter 和 scenePlan 都必须包含非空 summary。"
                ),
                &input,
                ctx.allow_local_fallback,
                |response| validate_response(response, synopsis),
            )
            .await?
            {
                return Ok(AgentOutput::new(AgentOutputPayload::Outline {
                    chapters: routed.value.chapters,
                    scene_plans: routed.value.scene_plans,
                    branches: routed.value.branches,
                })
                .with_model(
                    routed.model,
                    routed.prompt_tokens,
                    routed.completion_tokens,
                ));
            }
            let chapters = vec![
                ChapterPlan {
                    id: "ch1".to_string(),
                    title: "序章 · 日常的裂缝".to_string(),
                    summary: format!(
                        "主人公在熟悉的日常中发现异常，并第一次遇见掌握秘密的少女。{}",
                        synopsis
                    ),
                },
                ChapterPlan {
                    id: "ch2".to_string(),
                    title: "第二章 · 共同越界".to_string(),
                    summary: "两人合作验证异常回声，在互相试探中建立信任，也触碰静默协议。"
                        .to_string(),
                },
                ChapterPlan {
                    id: "ch3".to_string(),
                    title: "终章 · 锚点".to_string(),
                    summary: "真相迫使主人公决定相信对方并承担代价，或退回安全却失去这段关系。"
                        .to_string(),
                },
            ];
            let scene_plans = vec![
                scene(
                    "opening",
                    "start.txt",
                    "ch1",
                    "听见回声",
                    "日常第一次出现无法解释的重复信号。",
                    &["protagonist", "heroine"],
                ),
                scene(
                    "encounter",
                    "chapter_01.txt",
                    "ch1",
                    "交换秘密",
                    "少女指出主人公也已成为异常的一部分。",
                    &["protagonist", "heroine"],
                ),
                scene(
                    "investigation",
                    "chapter_02.txt",
                    "ch2",
                    "共同越界",
                    "两人验证规则，第三位角色带来现实压力。",
                    &["protagonist", "heroine", "friend"],
                ),
                scene(
                    "decision",
                    "decision.txt",
                    "ch3",
                    "锚点选择",
                    "静默协议启动，主人公必须当场选择。",
                    &["protagonist", "heroine", "friend"],
                ),
                scene(
                    "ending_trust",
                    "ending_trust.txt",
                    "ch3",
                    "共同承担",
                    "主人公选择相信少女，两人带着代价继续追索真相。",
                    &["protagonist", "heroine"],
                ),
                scene(
                    "ending_depart",
                    "ending_depart.txt",
                    "ch3",
                    "归于静默",
                    "主人公回到安稳日常，却保留了一丝无法解释的熟悉感。",
                    &["protagonist"],
                ),
            ];
            let branches = BranchGraph {
                entry_scene: "opening".to_string(),
                edges: vec![
                    edge("opening", "encounter", None),
                    edge("encounter", "investigation", None),
                    edge("investigation", "decision", None),
                    edge("decision", "ending_trust", Some("握住她的手，一起承担")),
                    edge("decision", "ending_depart", Some("遵守协议，回到日常")),
                ],
            };
            Ok(AgentOutput::new(AgentOutputPayload::Outline {
                chapters,
                scene_plans,
                branches,
            })
            .local_fallback())
        })
    }
}

fn scene(
    id: &str,
    file: &str,
    chapter_id: &str,
    title: &str,
    summary: &str,
    characters: &[&str],
) -> ScenePlan {
    ScenePlan {
        id: id.to_string(),
        file: file.to_string(),
        chapter_id: chapter_id.to_string(),
        title: title.to_string(),
        summary: summary.to_string(),
        character_ids: characters.iter().map(|id| id.to_string()).collect(),
    }
}

fn edge(from: &str, to: &str, choice: Option<&str>) -> BranchEdge {
    BranchEdge {
        from: from.to_string(),
        to: to.to_string(),
        choice: choice.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_response_without_summaries_does_not_abort_plotter() {
        let response = r#"{
            "chapters":[{"id":"ch1","title":"序章"}],
            "scenePlans":[{"id":"opening","file":"start.txt","chapterId":"ch1","title":"相遇"}],
            "branches":{"entryScene":"","edges":[]}
        }"#;

        let mut parsed: OutlineResponse =
            serde_json::from_str(response).expect("missing summary should be recoverable");
        fill_missing_summaries(&mut parsed, "校园悬疑");
        assert!(!parsed.chapters[0].summary.is_empty());
        assert!(!parsed.scene_plans[0].summary.is_empty());
    }

    #[test]
    fn unknown_chapter_reference_reports_scene_field_path() {
        let mut response: OutlineResponse = serde_json::from_str(r#"{
            "chapters":[{"id":"ch1","title":"序章","summary":"开始"}],
            "scenePlans":[
                {"id":"opening","file":"start.txt","chapterId":"missing","title":"相遇","summary":"开始"},
                {"id":"ending","file":"ending.txt","chapterId":"ch1","title":"结束","summary":"结束"}
            ],
            "branches":{"entryScene":"opening","edges":[{"from":"opening","to":"ending"}]}
        }"#).unwrap();
        let error = validate_response(&mut response, "主线").unwrap_err();
        assert!(error.0.contains("$.scenePlans[0].chapterId"));
    }

    #[tokio::test]
    async fn outline_agent_produces_two_chapters_from_synopsis() {
        let agent = OutlineAgent;
        let ctx = AgentContext {
            chat: &crate::agents::router::NoChatGateway,
            prompt: "",
            instruction: "",
            synopsis: "主角在校园发现异常信号",
            chapters: &[],
            worldbook: "霓虹学园",
            glossary: &Default::default(),
            characters: &[],
            scene_plans: &[],
            branches: &Default::default(),
            scene_drafts: &[],
            asset_plan: &[],
            allow_local_fallback: true,
        };
        let out = agent.run(&ctx).await.unwrap();
        let AgentOutputPayload::Outline {
            chapters,
            scene_plans,
            branches,
        } = out.payload
        else {
            panic!("Outline Agent must return an outline")
        };
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].id, "ch1");
        assert_eq!(chapters[1].id, "ch2");
        assert!(chapters[0].summary.contains("异常信号"));
        assert_eq!(scene_plans.len(), 6);
        assert_eq!(branches.entry_scene, "opening");
    }
}
