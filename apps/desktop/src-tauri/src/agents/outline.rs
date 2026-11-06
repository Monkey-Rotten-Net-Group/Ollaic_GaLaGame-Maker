use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

use crate::story_plan::store::{
    extract_condition_variables, extract_effect_variable, is_safe_branch_expression,
    is_safe_variable_id,
};
use crate::story_plan::types::{
    default_min_beats, fallback_min_beats, BranchEdge, BranchGraph, ChapterPlan, ScenePlan,
    VariableDef, VariableKind,
};

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

/// Plotter: turns canon into chapters, scene cards, and an explicit branch graph.
pub struct OutlineAgent;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlineResponse {
    #[serde(default)]
    variables: Vec<VariableDef>,
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
        if scene.emotional_arc.trim().is_empty() {
            scene.emotional_arc = format!("围绕“{}”推进情绪转折与心理变化。", scene.title);
        }
        if scene.min_beats == 0 {
            scene.min_beats = default_min_beats();
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
    let mut variable_ids = std::collections::HashSet::new();
    for (index, var) in response.variables.iter().enumerate() {
        let path = format!("$.variables[{index}]");
        if !is_safe_variable_id(&var.id) {
            return Err(contract_error(
                format!("{path}.id"),
                "must be a safe variable identifier",
            ));
        }
        if !variable_ids.insert(var.id.as_str()) {
            return Err(contract_error(format!("{path}.id"), "must be unique"));
        }
        match var.kind {
            VariableKind::Integer => {
                if var.initial_value.trim().parse::<i64>().is_err() {
                    return Err(contract_error(
                        format!("{path}.initialValue"),
                        format!("invalid integer initial value: {}", var.initial_value),
                    ));
                }
            }
            VariableKind::Boolean => {
                if !matches!(var.initial_value.trim(), "true" | "false") {
                    return Err(contract_error(
                        format!("{path}.initialValue"),
                        format!("invalid boolean initial value: {}", var.initial_value),
                    ));
                }
            }
        }
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
        if scene.min_beats < 8 {
            return Err(contract_error(
                format!("{path}.minBeats"),
                "minBeats must be at least 8",
            ));
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
    let mut written_variables = std::collections::HashSet::new();
    let mut read_variables = std::collections::HashSet::new();
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
        if let Some(condition) = &edge.condition {
            if !is_safe_branch_expression(condition) {
                return Err(contract_error(
                    format!("$.branches.edges[{index}].condition"),
                    "must not be empty",
                ));
            }
            let condition_vars = extract_condition_variables(condition);
            for var in condition_vars {
                if !variable_ids.contains(var.as_str()) {
                    return Err(contract_error(
                        format!("$.branches.edges[{index}].condition"),
                        format!("references undefined variable: {var}"),
                    ));
                }
                read_variables.insert(var);
            }
        }
        for (effect_index, effect) in edge.effects.iter().enumerate() {
            let effect_path = format!("$.branches.edges[{index}].effects[{effect_index}]");
            if effect.trim().is_empty() {
                return Err(contract_error(effect_path, "must not be empty"));
            }
            let Some(target_var) = extract_effect_variable(effect) else {
                return Err(contract_error(
                    effect_path,
                    "must be an assignment to a valid variable (e.g. var=expr)",
                ));
            };
            if !variable_ids.contains(target_var.as_str()) {
                return Err(contract_error(
                    effect_path,
                    format!("writes to undefined variable: {target_var}"),
                ));
            }
            written_variables.insert(target_var);
        }
    }
    for var in &read_variables {
        if !written_variables.contains(var) {
            return Err(contract_error(
                "$.branches",
                format!("variable '{var}' is read in a condition but never written in any branch effect"),
            ));
        }
    }
    // BFS reachability from entryScene
    let mut visited = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    visited.insert(response.branches.entry_scene.as_str());
    queue.push_back(response.branches.entry_scene.as_str());
    while let Some(current) = queue.pop_front() {
        for edge in &response.branches.edges {
            if edge.from == current && visited.insert(edge.to.as_str()) {
                queue.push_back(edge.to.as_str());
            }
        }
    }
    for scene in &response.scene_plans {
        if !visited.contains(scene.id.as_str()) {
            return Err(contract_error(
                "$.branches",
                format!(
                    "scene '{}' is unreachable from entryScene '{}'",
                    scene.id, response.branches.entry_scene
                ),
            ));
        }
    }
    // Dead-end checks
    let ending_scene_ids: std::collections::HashSet<&str> = response
        .scene_plans
        .iter()
        .filter(|s| s.is_ending())
        .map(|s| s.id.as_str())
        .collect();
    for scene in &response.scene_plans {
        let out_degree = response
            .branches
            .edges
            .iter()
            .filter(|e| e.from == scene.id)
            .count();
        if out_degree == 0 && !scene.is_ending() {
            return Err(contract_error(
                "$.branches.edges",
                format!(
                    "non-ending scene '{}' has no outgoing edges (dead end)",
                    scene.id
                ),
            ));
        }
        if !ending_scene_ids.is_empty() {
            let mut scene_visited = std::collections::HashSet::new();
            let mut scene_queue = std::collections::VecDeque::new();
            scene_visited.insert(scene.id.as_str());
            scene_queue.push_back(scene.id.as_str());
            let mut reaches_ending = ending_scene_ids.contains(scene.id.as_str());
            while let Some(curr) = scene_queue.pop_front() {
                if reaches_ending {
                    break;
                }
                for edge in &response.branches.edges {
                    if edge.from == curr && scene_visited.insert(edge.to.as_str()) {
                        if ending_scene_ids.contains(edge.to.as_str()) {
                            reaches_ending = true;
                            break;
                        }
                        scene_queue.push_back(edge.to.as_str());
                    }
                }
            }
            if !reaches_ending {
                return Err(contract_error(
                    "$.branches.edges",
                    format!(
                        "scene '{}' has no path to an ending scene (dead-end branch)",
                        scene.id
                    ),
                ));
            }
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
                "requirements": "生成全局变量声明（variables）、3 章结构、至少 5 个 scene 和分支拓扑（branches）。变量必须声明 id、kind（integer 或 boolean）、initialValue 和 description。每个 scenePlan 必须包含 id、file（入口 scene 必须是 start.txt；其他只能是无路径安全 .txt 文件名）、chapterId、title、summary、characterIds、povCharacterId（第一人称视角角色）、emotionalArc（情绪弧线）、requiredBeats（3-4 个关键戏剧节拍）、forbiddenReveals（本场严禁剧透的事实）、entryState（入场状态约束）和 minBeats（默认 24）。branches 包含 entryScene 和 edges，每条 edge 包含 from、to、可选 choice 选项文本、可选 condition 状态判定表达式，以及可选 effects 状态变更操作列表。至少包含一次带 choice 的分支，condition 检查的变量必须在 variables 中定义并至少被一条 edge 的 effects 写入。"
            });
            if let Some(routed) = generate_structured_validated::<OutlineResponse, _>(
                ctx.chat,
                "Plotter / 剧情结构",
                concat!(
                    "输出可执行的全局变量、章节、场景卡和状态分支拓扑。严格使用 JSON：",
                    r#"{"variables":[{"id":"linxia_trust","kind":"integer","initialValue":"0","description":"林夏对陆川的信任度"}],"chapters":[{"id":"ch1","title":"...","summary":"..."}],"scenePlans":[{"id":"opening","file":"start.txt","chapterId":"ch1","title":"...","summary":"...","characterIds":["protagonist"],"povCharacterId":"protagonist","emotionalArc":"...","requiredBeats":["..."],"forbiddenReveals":["..."],"entryState":["..."],"minBeats":24}],"branches":{"entryScene":"opening","edges":[{"from":"opening","to":"next_scene","choice":null,"condition":null,"effects":[]}]}}"#,
                    "。每个 chapter 和 scenePlan 都必须包含非空 summary 与 emotionalArc。"
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
                    variables: routed.value.variables,
                })
                .with_model(
                    routed.model,
                    routed.prompt_tokens,
                    routed.completion_tokens,
                ));
            }
            let variables = vec![
                VariableDef {
                    id: "linxia_trust".to_string(),
                    kind: VariableKind::Integer,
                    initial_value: "0".to_string(),
                    description: "林夏对陆川的信任度".to_string(),
                },
                VariableDef {
                    id: "protocol_obeyed".to_string(),
                    kind: VariableKind::Boolean,
                    initial_value: "false".to_string(),
                    description: "是否遵守静默协议回到日常".to_string(),
                },
            ];
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
                    Some("protagonist"),
                    "困惑日常 -> 警惕确认",
                    &[
                        "放学后听到走廊广播异常重复",
                        "在空教室发现未接电源的录音机",
                        "林夏指出磁带上写着陆川的学号",
                    ],
                    &["静默协议的终极代价", "两人的旧日约定"],
                    &["日常世界表面安稳"],
                ),
                scene(
                    "encounter",
                    "chapter_01.txt",
                    "ch1",
                    "交换秘密",
                    "少女指出主人公也已成为异常的一部分。",
                    &["protagonist", "heroine"],
                    Some("protagonist"),
                    "怀疑防备 -> 建立脆弱同盟",
                    &[
                        "天台风中对质异常回声",
                        "林夏承认自己在寻找被遗忘的人",
                        "陆川决定追查第一条证据",
                    ],
                    &["档案库终端的真正主人"],
                    &["陆川已持有磁带证据"],
                ),
                scene(
                    "investigation",
                    "chapter_02.txt",
                    "ch2",
                    "共同越界",
                    "两人验证规则，第三位角色带来现实压力。",
                    &["protagonist", "heroine", "friend"],
                    Some("protagonist"),
                    "谨慎试探 -> 危机升级",
                    &[
                        "旧资料室终端发现异常登录日志",
                        "周遥推门打断并带来外界怀疑",
                        "屏幕上名字被反向抹除触发警报",
                    ],
                    &["林夏即将消失的倒计时"],
                    &["静默协议已锁定终端位置"],
                ),
                scene(
                    "decision",
                    "decision.txt",
                    "ch3",
                    "锚点选择",
                    "静默协议启动，主人公必须当场选择。",
                    &["protagonist", "heroine", "friend"],
                    Some("protagonist"),
                    "两难压力 -> 意志决断",
                    &[
                        "整栋大楼断电陷入静默领域",
                        "录音机吐出主人公自己的声音",
                        "面临握手承担或回到日常的关键分岔",
                    ],
                    &[],
                    &["电力切断，协议完全覆盖"],
                ),
                scene(
                    "ending_trust",
                    "ending_trust.txt",
                    "ch3",
                    "共同承担",
                    "主人公选择相信少女，两人带着代价继续追索真相。",
                    &["protagonist", "heroine"],
                    Some("protagonist"),
                    "代价沉重 -> 坚定前行",
                    &[
                        "握紧林夏冰冷的手确认彼此存在",
                        "晨光破晓照出被抹除名字的记忆",
                        "立下绝不独自承担代价的新盟约",
                    ],
                    &[],
                    &["已选择信任分支，信任度增加"],
                ),
                scene(
                    "ending_depart",
                    "ending_depart.txt",
                    "ch3",
                    "归于静默",
                    "主人公回到安稳日常，却保留了一丝无法解释的熟悉感。",
                    &["protagonist"],
                    Some("protagonist"),
                    "平静释然 -> 隐秘怅惘",
                    &[
                        "松开手任由日常记忆覆盖",
                        "清晨广播恢复正常，身旁空无一人",
                        "独自按下无标签录音机听见笑声",
                    ],
                    &[],
                    &["已选择遵守协议分支"],
                ),
            ];
            let branches = BranchGraph {
                entry_scene: "opening".to_string(),
                edges: vec![
                    edge("opening", "encounter", None, None, vec![]),
                    edge(
                        "encounter",
                        "investigation",
                        None,
                        None,
                        vec!["linxia_trust=linxia_trust+1".to_string()],
                    ),
                    edge("investigation", "decision", None, None, vec![]),
                    edge(
                        "decision",
                        "ending_trust",
                        Some("握住她的手，一起承担"),
                        Some("linxia_trust>=1".to_string()),
                        vec!["linxia_trust=linxia_trust+1".to_string()],
                    ),
                    edge(
                        "decision",
                        "ending_depart",
                        Some("遵守协议，回到日常"),
                        None,
                        vec!["protocol_obeyed=true".to_string()],
                    ),
                ],
            };
            Ok(AgentOutput::new(AgentOutputPayload::Outline {
                chapters,
                scene_plans,
                branches,
                variables,
            })
            .local_fallback())
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn scene(
    id: &str,
    file: &str,
    chapter_id: &str,
    title: &str,
    summary: &str,
    characters: &[&str],
    pov: Option<&str>,
    arc: &str,
    beats: &[&str],
    forbidden: &[&str],
    entry: &[&str],
) -> ScenePlan {
    ScenePlan {
        location_id: None,
        time_of_day: None,
        id: id.to_string(),
        file: file.to_string(),
        chapter_id: chapter_id.to_string(),
        title: title.to_string(),
        summary: summary.to_string(),
        character_ids: characters.iter().map(|id| id.to_string()).collect(),
        approval_status: Default::default(),
        rolling_summary: None,
        pov_character_id: pov.map(str::to_string),
        emotional_arc: arc.to_string(),
        required_beats: beats.iter().map(|b| b.to_string()).collect(),
        forbidden_reveals: forbidden.iter().map(|f| f.to_string()).collect(),
        entry_state: entry.iter().map(|e| e.to_string()).collect(),
        min_beats: fallback_min_beats(),
    }
}

fn edge(
    from: &str,
    to: &str,
    choice: Option<&str>,
    condition: Option<String>,
    effects: Vec<String>,
) -> BranchEdge {
    BranchEdge {
        from: from.to_string(),
        to: to.to_string(),
        choice: choice.map(str::to_string),
        condition,
        effects,
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
            target_scene_id: None,
            preceding_scene_tail: "",
            visual_style: &Default::default(),
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
            variables: &[],
            scene_drafts: &[],
            asset_plan: &[],
            allow_local_fallback: true,
        };
        let out = agent.run(&ctx).await.unwrap();
        let AgentOutputPayload::Outline {
            chapters,
            scene_plans,
            branches,
            variables,
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
        assert_eq!(variables.len(), 2);
    }

    #[test]
    fn undefined_variable_in_condition_reports_contract_error() {
        let mut response: OutlineResponse = serde_json::from_str(r#"{
            "variables": [{"id": "trust", "kind": "integer", "initialValue": "0", "description": "信任度"}],
            "chapters": [{"id": "ch1", "title": "序章", "summary": "开始"}],
            "scenePlans": [
                {"id": "opening", "file": "start.txt", "chapterId": "ch1", "title": "相遇", "summary": "开始"},
                {"id": "ending", "file": "ending.txt", "chapterId": "ch1", "title": "结束", "summary": "结束"}
            ],
            "branches": {
                "entryScene": "opening",
                "edges": [
                    {"from": "opening", "to": "ending", "condition": "courage >= 1", "effects": ["trust=trust+1"]}
                ]
            }
        }"#).unwrap();
        let error = validate_response(&mut response, "主线").unwrap_err();
        assert!(error.0.contains("references undefined variable: courage"));
    }

    #[test]
    fn unwritten_condition_variable_reports_contract_error() {
        let mut response: OutlineResponse = serde_json::from_str(r#"{
            "variables": [
                {"id": "trust", "kind": "integer", "initialValue": "0", "description": "信任度"},
                {"id": "courage", "kind": "integer", "initialValue": "0", "description": "勇气值"}
            ],
            "chapters": [{"id": "ch1", "title": "序章", "summary": "开始"}],
            "scenePlans": [
                {"id": "opening", "file": "start.txt", "chapterId": "ch1", "title": "相遇", "summary": "开始"},
                {"id": "ending", "file": "ending.txt", "chapterId": "ch1", "title": "结束", "summary": "结束"}
            ],
            "branches": {
                "entryScene": "opening",
                "edges": [
                    {"from": "opening", "to": "ending", "condition": "courage >= 1", "effects": ["trust=trust+1"]}
                ]
            }
        }"#).unwrap();
        let error = validate_response(&mut response, "主线").unwrap_err();
        assert!(error.0.contains("courage"));
        assert!(error.0.contains("never written in any branch effect"));
    }

    #[test]
    fn dead_end_non_ending_scene_reports_contract_error() {
        let mut response: OutlineResponse = serde_json::from_str(r#"{
            "variables": [],
            "chapters": [{"id": "ch1", "title": "序章", "summary": "开始"}],
            "scenePlans": [
                {"id": "opening", "file": "start.txt", "chapterId": "ch1", "title": "相遇", "summary": "开始"},
                {"id": "middle", "file": "middle.txt", "chapterId": "ch1", "title": "过程", "summary": "未完待续"}
            ],
            "branches": {
                "entryScene": "opening",
                "edges": [
                    {"from": "opening", "to": "middle"}
                ]
            }
        }"#).unwrap();
        let error = validate_response(&mut response, "主线").unwrap_err();
        assert!(error.0.contains("dead end") || error.0.contains("middle"));
    }
}
