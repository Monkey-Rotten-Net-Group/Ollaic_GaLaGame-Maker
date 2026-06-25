use super::*;
use std::fs;

#[test]
fn normalize_cosyvoice_voice_appends_v2_for_v2_model() {
    assert_eq!(normalize_cosyvoice_voice("longwanjun", "cosyvoice-v2"), "longwanjun_v2");
    assert_eq!(normalize_cosyvoice_voice("longanrou", "cosyvoice-v3-flash"), "longanrou_v2");
    // Already has _v2 — no double-append.
    assert_eq!(normalize_cosyvoice_voice("longxiaochun_v2", "cosyvoice-v2"), "longxiaochun_v2");
}

#[test]
fn normalize_cosyvoice_voice_strips_v2_for_v1_model() {
    assert_eq!(normalize_cosyvoice_voice("longxiaochun_v2", "cosyvoice-v1"), "longxiaochun");
    assert_eq!(normalize_cosyvoice_voice("longwanjun", "cosyvoice-v1"), "longwanjun");
}

#[test]
fn normalize_cosyvoice_voice_passes_through_custom_clone_id() {
    // Clone IDs contain hyphens; must not be mangled.
    let clone_id = "speech-synthesizer-clone-v3-abc123-def456";
    assert_eq!(normalize_cosyvoice_voice(clone_id, "cosyvoice-v2"), clone_id);
}

#[test]
fn ai_logs_can_list_and_clear_with_redaction() {
    let tmp = std::env::temp_dir().join("webgal_test_ai_logs.jsonl");
    let _ = fs::remove_file(&tmp);
    config::append_log_line_at(
        &tmp,
        r#"{"timestamp_ms":1,"action":"validate","provider":"openai","model":"gpt","endpoint":"https://example.test/v1?api_key=secret123","success":false,"message":"Authorization=Bearer secret123 token=abc"}"#,
    )
    .unwrap();
    config::append_log_line_at(
        &tmp,
        r#"{"timestamp_ms":2,"action":"chat_stream","provider":"openai","model":"gpt","endpoint":"https://example.test/v1","success":true,"message":"ok"}"#,
    )
    .unwrap();

    let logs = list_ai_logs_from_path(&tmp, Some(10)).unwrap();
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[0].timestamp_ms, 1);
    assert!(logs[0].endpoint.contains("[REDACTED]"));
    assert!(!logs[0].endpoint.contains("secret123"));
    assert!(!logs[0].message.contains("abc"));

    clear_ai_logs_at(&tmp).unwrap();
    assert!(!tmp.exists());
}

#[test]
fn ai_log_list_honors_limit() {
    let tmp = std::env::temp_dir().join("webgal_test_ai_logs_limit.jsonl");
    let _ = fs::remove_file(&tmp);
    for timestamp_ms in 1..=3 {
        config::append_log_line_at(
            &tmp,
            &format!(
                r#"{{"timestamp_ms":{timestamp_ms},"action":"validate","provider":"openai","model":"gpt","endpoint":"","success":true,"message":"ok"}}"#
            ),
        )
        .unwrap();
    }

    let logs = list_ai_logs_from_path(&tmp, Some(2)).unwrap();
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[0].timestamp_ms, 2);
    assert_eq!(logs[1].timestamp_ms, 3);
    let _ = fs::remove_file(&tmp);
}

#[test]
fn ai_agent_trace_sanitizes_secrets_without_log_truncation() {
    let long_text = "x".repeat(MAX_LOG_FIELD_CHARS + 50);
    let trace = serde_json::json!({
        "apiKey": "secret-key",
        "modelText": format!("response api_key=secret-token {long_text}"),
        "nested": [{ "authorization": "Bearer secret-token" }],
    });

    let sanitized = sanitize_trace_value(trace);
    assert_eq!(sanitized["apiKey"], "[REDACTED]");
    assert_eq!(sanitized["nested"][0]["authorization"], "[REDACTED]");
    let model_text = sanitized["modelText"].as_str().unwrap();
    assert!(model_text.contains("api_key=[REDACTED]"));
    assert!(!model_text.contains("secret-token"));
    assert!(model_text.len() > MAX_LOG_FIELD_CHARS);
}

#[tokio::test]
#[ignore]
async fn real_model_insert_figure_harness() {
    let cfg = config::load_config();
    eprintln!(
        "[harness] provider={} model={} endpoint={}",
        cfg.provider,
        cfg.model,
        effective_endpoint(&cfg),
    );

    let mut messages = vec![
        AiMessageInput {
            role: "system".to_string(),
            content: real_model_harness_system_prompt(),
            tool_calls: None,
            tool_call_id: None,
        },
        AiMessageInput {
            role: "user".to_string(),
            content: "请在第 1 行后插入静香“生气”表情的左侧立绘，并让它立即执行下一条。请直接调用工具生成预览，不要只文字说明。".to_string(),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let mut preview: Option<String> = None;
    let mut used_tools: Vec<String> = Vec::new();

    for turn in 1..=6 {
        eprintln!("\n[harness] === turn {turn} ===");
        let response = ai_chat_turn(messages, real_model_harness_tools(), None)
            .await
            .expect("真实模型调用失败");
        if let Some(text) = &response.text {
            eprintln!("[assistant text]\n{text}");
        }
        if response.tool_calls.is_empty() {
            eprintln!("[harness] no tool calls; stopping");
            break;
        }

        let tool_inputs: Vec<ToolCallInput> = response
            .tool_calls
            .iter()
            .map(|call| ToolCallInput {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            })
            .collect();
        messages = vec![AiMessageInput {
            role: "assistant".to_string(),
            content: response.text.clone().unwrap_or_default(),
            tool_calls: Some(tool_inputs),
            tool_call_id: None,
        }];

        for call in response.tool_calls {
            used_tools.push(call.name.clone());
            eprintln!(
                "[tool call] {} {}",
                call.name,
                serde_json::to_string_pretty(&call.arguments).unwrap()
            );
            let result = run_real_model_harness_tool(&call.name, &call.arguments, &mut preview);
            eprintln!(
                "[tool result] {}",
                serde_json::to_string_pretty(&result).unwrap()
            );
            messages.push(AiMessageInput {
                role: "tool".to_string(),
                content: result.to_string(),
                tool_calls: None,
                tool_call_id: Some(call.id),
            });
        }
    }

    let preview = preview.expect("真实模型没有调用 insert_figure 生成预览");
    eprintln!("\n[harness] tools: {}", used_tools.join(" -> "));
    eprintln!("[harness] preview:\n{preview}");
    assert!(
        used_tools.iter().any(|name| name == "insert_figure"),
        "真实模型没有选择 insert_figure；实际工具轨迹：{}",
        used_tools.join(" -> ")
    );
    assert!(preview.contains("changeFigure:char_shizuka/静香_生气_1700000000.png"));
    assert!(preview.contains("-figureCharacter=静香"));
    assert!(preview.contains("-figureEmotion=生气"));
    assert!(preview.contains("-left"));
    assert!(preview.contains("-next"));
}

#[tokio::test]
#[ignore]
async fn real_model_structured_story_tools_harness() {
    let cfg = config::load_config();
    eprintln!(
        "[harness] provider={} model={} endpoint={}",
        cfg.provider,
        cfg.model,
        effective_endpoint(&cfg),
    );

    let mut messages = vec![
        AiMessageInput {
            role: "system".to_string(),
            content: real_model_structured_harness_system_prompt(),
            tool_calls: None,
            tool_call_id: None,
        },
        AiMessageInput {
            role: "user".to_string(),
            content: [
                "请直接调用工具搭建一个可预览的完整故事骨架,不要只文字说明。",
                "需要完成:新建角色陆岚;整理 start.txt 的章节和大纲;在 start.txt 末尾插入一段开场剧情;",
                "再创建两个分支目标场景;最后给已有角色静香规划“微笑”和“惊讶”两个表情槽提示词。",
            ]
            .join(""),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let mut state = StructuredStoryHarnessState::default();
    let mut used_tools: Vec<String> = Vec::new();

    for turn in 1..=10 {
        eprintln!("\n[harness] === turn {turn} ===");
        let response = ai_chat_turn(
            clone_harness_messages(&messages),
            real_model_structured_harness_tools(),
            None,
        )
        .await
        .expect("真实模型调用失败");
        if let Some(text) = &response.text {
            eprintln!("[assistant text]\n{text}");
        }
        if response.tool_calls.is_empty() {
            eprintln!("[harness] no tool calls; stopping");
            break;
        }

        let tool_inputs: Vec<ToolCallInput> = response
            .tool_calls
            .iter()
            .map(|call| ToolCallInput {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            })
            .collect();
        messages.push(AiMessageInput {
            role: "assistant".to_string(),
            content: response.text.clone().unwrap_or_default(),
            tool_calls: Some(tool_inputs),
            tool_call_id: None,
        });

        for call in response.tool_calls {
            used_tools.push(call.name.clone());
            eprintln!(
                "[tool call] {} {}",
                call.name,
                serde_json::to_string_pretty(&call.arguments).unwrap()
            );
            let result =
                run_real_model_structured_harness_tool(&call.name, &call.arguments, &mut state);
            eprintln!(
                "[tool result] {}",
                serde_json::to_string_pretty(&result).unwrap()
            );
            messages.push(AiMessageInput {
                role: "tool".to_string(),
                content: result.to_string(),
                tool_calls: None,
                tool_call_id: Some(call.id),
            });
        }
    }

    eprintln!("\n[harness] tools: {}", used_tools.join(" -> "));
    for required in [
        "create_character",
        "set_scene_header",
        "insert_dialogue_block",
        "create_branch",
        "plan_character_sprites",
    ] {
        assert!(
            used_tools.iter().any(|name| name == required),
            "真实模型没有选择 {required}; 实际工具轨迹：{}",
            used_tools.join(" -> ")
        );
    }

    let character = state
        .created_character_preview
        .expect("真实模型没有暂存 create_character");
    assert!(character.contains("陆岚"));
    assert!(
        !character.contains("\"file\""),
        "create_character 不应该为未生成的立绘绑定 file: {character}"
    );

    let header = state
        .scene_header_preview
        .expect("真实模型没有暂存 set_scene_header");
    assert!(header.contains("; 章节:"));
    assert!(header.contains("; 大纲:"));
    assert!(header.contains("start.txt"));

    let dialogue = state
        .dialogue_preview
        .expect("真实模型没有暂存 insert_dialogue_block");
    assert!(dialogue.contains("静香:") || dialogue.contains("陆岚:"));
    assert!(
        dialogue.contains(':') && dialogue.contains(';'),
        "剧情块应生成 WebGAL txt 行: {dialogue}"
    );

    let branch = state
        .branch_preview
        .expect("真实模型没有暂存 create_branch");
    assert!(branch.contains("choose:"));
    assert!(branch.matches(".txt").count() >= 2);

    let sprites = state
        .sprite_plan_preview
        .expect("真实模型没有暂存 plan_character_sprites");
    assert!(sprites.contains("静香") || sprites.contains("char_shizuka"));
    assert!(sprites.contains("微笑"));
    assert!(sprites.contains("惊讶"));
    assert!(
        !sprites.contains("\"file\""),
        "plan_character_sprites 不应该为未生成的立绘绑定 file: {sprites}"
    );
}

#[derive(Default)]
struct StructuredStoryHarnessState {
    created_character_preview: Option<String>,
    scene_header_preview: Option<String>,
    dialogue_preview: Option<String>,
    branch_preview: Option<String>,
    sprite_plan_preview: Option<String>,
}

fn clone_harness_messages(messages: &[AiMessageInput]) -> Vec<AiMessageInput> {
    messages
        .iter()
        .map(|message| AiMessageInput {
            role: message.role.clone(),
            content: message.content.clone(),
            tool_calls: message.tool_calls.as_ref().map(|calls| {
                calls
                    .iter()
                    .map(|call| ToolCallInput {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        arguments: call.arguments.clone(),
                    })
                    .collect()
            }),
            tool_call_id: message.tool_call_id.clone(),
        })
        .collect()
}

fn real_model_harness_tools() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_scenes".to_string(),
            description: "列出项目场景。调用写入工具时用 file 字段里的文件名。".to_string(),
            parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
        },
        ToolDef {
            name: "read_scene".to_string(),
            description: "读取场景脚本，返回带行号 WebGAL txt。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "场景文件名，如 start.txt" }
                },
                "required": ["name"]
            }),
        },
        ToolDef {
            name: "list_characters".to_string(),
            description: "列出项目中的角色（id、名字、别名）。".to_string(),
            parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
        },
        ToolDef {
            name: "get_character".to_string(),
            description: "读取角色完整设定，含 sprites 表情列表。id 可传角色 id、名字或别名。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "角色 id、名字或别名" }
                },
                "required": ["id"]
            }),
        },
        ToolDef {
            name: "search_assets".to_string(),
            description: "查询素材库。figure 素材会带 character 与 emotion，引用素材不要编造文件名。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string" },
                    "query": { "type": "string" }
                },
                "required": []
            }),
        },
        ToolDef {
            name: "insert_figure".to_string(),
            description: "插入角色立绘节点。优先用这个工具，不要手写 changeFigure 路径；只提供角色、表情、位置和插入行，系统会解析真实文件并生成预览。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "目标场景文件名" },
                    "afterLine": { "description": "在该 txt 行号后插入；正整数或字符串 end" },
                    "anchorText": { "type": "string", "description": "afterLine 对应行原文" },
                    "character": { "type": "string", "description": "角色名、id 或别名" },
                    "emotion": { "type": "string", "description": "角色 sprites 中的表情名" },
                    "position": { "type": "string", "enum": ["left", "center", "right"] },
                    "next": { "type": "boolean" }
                },
                "required": ["file", "afterLine", "character", "emotion"]
            }),
        },
    ]
}

fn real_model_structured_harness_tools() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_scenes".to_string(),
            description: "列出项目场景。调用写入工具时用 file 字段里的文件名。".to_string(),
            parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
        },
        ToolDef {
            name: "read_scene".to_string(),
            description: "读取场景脚本，返回带行号 WebGAL txt。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "场景文件名，如 start.txt" }
                },
                "required": ["name"]
            }),
        },
        ToolDef {
            name: "list_characters".to_string(),
            description: "列出项目中的角色（id、名字、别名）。新建角色前可先查重。".to_string(),
            parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
        },
        ToolDef {
            name: "get_character".to_string(),
            description: "读取角色完整设定，含 sprites 表情列表。id 可传角色 id、名字或别名。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "角色 id、名字或别名" }
                },
                "required": ["id"]
            }),
        },
        ToolDef {
            name: "search_assets".to_string(),
            description: "查询素材库。没有查到真实素材时，不要编造 asset 或 file。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string" },
                    "query": { "type": "string" }
                },
                "required": []
            }),
        },
        ToolDef {
            name: "create_character".to_string(),
            description: "新建一个角色设定卡。只填写基础设定与可选 sprites 表情槽；sprites 只能写 emotion/prompt，不绑定 file。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "角色主名称，会用于脚本对白" },
                    "aliases": { "type": "array", "items": { "type": "string" } },
                    "description": { "type": "string" },
                    "personality": { "type": "string" },
                    "stance": { "type": "string" },
                    "keywords": { "type": "array", "items": { "type": "string" } },
                    "dialogueStyle": { "type": "string" },
                    "gender": { "type": "string" },
                    "age": { "type": "string" },
                    "voiceTimbre": { "type": "string" },
                    "colorTheme": { "type": "string" },
                    "notes": { "type": "string" },
                    "sprites": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "emotion": { "type": "string" },
                                "prompt": { "type": "string" }
                            },
                            "required": ["emotion"]
                        }
                    }
                },
                "required": ["name"]
            }),
        },
        ToolDef {
            name: "set_scene_header".to_string(),
            description: "设置场景章节名和大纲。用于组织故事结构，不要手写注释行。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "目标场景文件名" },
                    "chapter": { "type": "string", "description": "章节名" },
                    "outline": { "type": "string", "description": "场景大纲/简述" }
                },
                "required": ["file"]
            }),
        },
        ToolDef {
            name: "insert_dialogue_block".to_string(),
            description: "向场景插入一段结构化剧情块，由系统生成合法 WebGAL txt。没有素材时省略素材命令，不要编造 asset。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "目标场景文件名" },
                    "afterLine": { "description": "在该 txt 行号之后插入；可为正整数，或字符串 end 表示文件末尾" },
                    "anchorText": { "type": "string", "description": "afterLine 对应行原文" },
                    "lines": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": ["narrator", "dialogue", "intro", "background", "figure", "bgm", "effect", "video", "jump", "call", "label", "end", "comment"] },
                                "text": { "type": "string" },
                                "character": { "type": "string" },
                                "emotion": { "type": "string" },
                                "position": { "type": "string", "enum": ["left", "center", "right"] },
                                "asset": { "type": "string" },
                                "target": { "type": "string" },
                                "label": { "type": "string" },
                                "next": { "type": "boolean" }
                            },
                            "required": ["type"]
                        }
                    }
                },
                "required": ["file", "afterLine", "lines"]
            }),
        },
        ToolDef {
            name: "create_branch".to_string(),
            description: "插入选项分支并暂存创建每个目标场景。choices 至少两个，每项包含 text 与 targetScene。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "插入 choose 的源场景文件名" },
                    "afterLine": { "description": "在该 txt 行号之后插入 choose；可为正整数，或字符串 end" },
                    "anchorText": { "type": "string" },
                    "choices": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": { "type": "string" },
                                "targetScene": { "type": "string" },
                                "chapter": { "type": "string" },
                                "outline": { "type": "string" },
                                "contentLines": { "type": "array", "items": { "type": "object" } }
                            },
                            "required": ["text", "targetScene"]
                        }
                    }
                },
                "required": ["file", "afterLine", "choices"]
            }),
        },
        ToolDef {
            name: "plan_character_sprites".to_string(),
            description: "给已有角色规划/追加表情槽与生图提示词。不调用生图模型、不绑定素材文件；sprites 只能写 emotion/prompt。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "character": { "type": "string", "description": "角色 id、名字或别名" },
                    "sprites": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "emotion": { "type": "string" },
                                "prompt": { "type": "string" }
                            },
                            "required": ["emotion", "prompt"]
                        }
                    }
                },
                "required": ["character", "sprites"]
            }),
        },
    ]
}

fn real_model_harness_system_prompt() -> String {
    [
        "# 角色",
        "你是 WebGAL 视觉小说的故事编辑助手。",
        "# 工具",
        "需要插入角色立绘时，优先调用 insert_figure。不要自己拼 figure 路径。",
        "如果缺少角色或表情信息，先调用 list_characters / get_character / search_assets 查询。",
        "当前场景文件名已经明确是 start.txt；调用 insert_figure 的 file 直接使用 start.txt，不要把场景当素材查询。",
        "工具返回 staged=true 后，只简短说明预览已生成并等待用户在界面确认，不要说“告知我应用”或暗示你能直接落盘。",
        "# WebGAL txt 格式",
        "立绘最终应是 changeFigure:文件名 -figureCharacter=角色 -figureEmotion=表情 -left/-right/-center -next;",
        "# 当前上下文",
        "当前场景：start.txt",
        "当前脚本（左侧数字是 txt 行号）：\n1: :静香站在门口，紧紧攥着袖口;\n2: 静香:我已经不会再退让了;",
    ]
    .join("\n\n")
}

fn real_model_structured_harness_system_prompt() -> String {
    [
        "# 角色",
        "你是 WebGAL 视觉小说的故事编辑助手。",
        "# Harness 目标",
        "这是一个真实模型工具选择测试。你必须调用以下写工具各一次: create_character、set_scene_header、insert_dialogue_block、create_branch、plan_character_sprites。",
        "不要只用文字说明完成结果;不要调用不存在的工具;不要用底层 patch 代替高层工具。",
        "所有写工具只生成预览/staged 结果,不会直接落盘。工具返回 staged=true 后继续完成剩余工具,直到五个写工具都调用完成。",
        "# 角色与素材约束",
        "如果用户要求新角色,调用 create_character,参数是顶层字段 name/personality/dialogueStyle 等,不要包在 draft 里。",
        "当前没有可用生图模型。create_character 的 sprites 和 plan_character_sprites 的 sprites 只能包含 emotion 与 prompt,绝对不要填写 file/asset。",
        "给已有角色补表情槽时调用 plan_character_sprites,不要编造真实立绘文件。",
        "# 故事结构工具",
        "章节/大纲用 set_scene_header。连续剧情用 insert_dialogue_block。选项分支和目标场景用 create_branch。",
        "当前场景文件名是 start.txt。插入到末尾时 afterLine 使用 end。",
        "# 当前项目",
        "现有场景: start.txt",
        "start.txt 当前脚本（左侧数字是 txt 行号）：\n1: :雨夜的教室只剩下静香;\n2: 静香:如果现在放弃,一切都会结束。;",
        "现有角色: 静香(id=char_shizuka, alias=小静),已有 sprites: 默认。没有角色陆岚。",
    ]
    .join("\n\n")
}

fn run_real_model_harness_tool(
    name: &str,
    args: &serde_json::Value,
    preview: &mut Option<String>,
) -> serde_json::Value {
    match name {
        "list_scenes" => serde_json::json!({
            "scenes": [
                { "file": "start.txt", "chapter": "测试章节", "outline": "静香在门口压抑怒意" }
            ]
        }),
        "read_scene" => serde_json::json!({
            "name": "start.txt",
            "totalLines": 2,
            "truncated": false,
            "text": "1: :静香站在门口，紧紧攥着袖口;\n2: 静香:我已经不会再退让了;"
        }),
        "list_characters" => serde_json::json!({
            "characters": [
                { "id": "char_shizuka", "name": "静香", "aliases": ["小静"] }
            ]
        }),
        "get_character" => serde_json::json!({
            "id": "char_shizuka",
            "name": "静香",
            "aliases": ["小静"],
            "personality": "克制、敏感，但被逼到极限时会直接表达愤怒。",
            "dialogueStyle": "句子短，情绪强时语气冷硬。",
            "sprites": [
                { "emotion": "默认", "file": "shizuka_default.png" },
                { "emotion": "生气", "file": "char_shizuka/静香_生气_1700000000.png" }
            ]
        }),
        "search_assets" => {
            let category = args.get("category").and_then(|v| v.as_str()).unwrap_or("figure");
            if category != "figure" {
                return serde_json::json!({
                    "error": format!("测试 harness 只有 figure 素材；场景请用 list_scenes/read_scene，不要用 search_assets 查询 {category}。")
                });
            }
            serde_json::json!({
                "total": 2,
                "truncated": false,
                "assets": [
                    { "name": "shizuka_default.png", "category": "figure", "character": "静香", "emotion": "默认" },
                    { "name": "char_shizuka/静香_生气_1700000000.png", "category": "figure", "character": "静香", "emotion": "生气" }
                ]
            })
        }
        "insert_figure" => {
            let character = args.get("character").and_then(|v| v.as_str()).unwrap_or("");
            let emotion = args.get("emotion").and_then(|v| v.as_str()).unwrap_or("");
            let position = args.get("position").and_then(|v| v.as_str()).unwrap_or("center");
            if !["静香", "小静", "char_shizuka"].contains(&character) {
                return serde_json::json!({ "staged": false, "error": format!("找不到角色：{character}") });
            }
            if emotion != "生气" {
                return serde_json::json!({ "staged": false, "error": format!("角色静香没有表情：{emotion}") });
            }
            let position_flag = match position {
                "left" => " -left",
                "right" => " -right",
                _ => "",
            };
            let next = if args.get("next").and_then(|v| v.as_bool()) == Some(false) {
                ""
            } else {
                " -next"
            };
            let line = format!(
                "changeFigure:char_shizuka/静香_生气_1700000000.png -figureCharacter=静香 -figureEmotion=生气{position_flag}{next};"
            );
            let after = format!(
                ":静香站在门口，紧紧攥着袖口;\n{line}\n静香:我已经不会再退让了;\n"
            );
            *preview = Some(after.clone());
            serde_json::json!({
                "staged": true,
                "message": "已生成修改预览。",
                "preview": after,
            })
        }
        other => serde_json::json!({ "error": format!("未知工具：{other}") }),
    }
}

fn run_real_model_structured_harness_tool(
    name: &str,
    args: &serde_json::Value,
    state: &mut StructuredStoryHarnessState,
) -> serde_json::Value {
    match name {
        "list_scenes" => serde_json::json!({
            "scenes": [
                { "file": "start.txt", "chapter": "", "outline": "雨夜教室里静香面临选择" }
            ]
        }),
        "read_scene" => {
            let scene = string_arg(args, "name").unwrap_or("start.txt");
            if scene != "start.txt" {
                return serde_json::json!({ "error": format!("测试 harness 中场景尚不存在：{scene}") });
            }
            serde_json::json!({
                "name": "start.txt",
                "totalLines": 2,
                "truncated": false,
                "text": "1: :雨夜的教室只剩下静香;\n2: 静香:如果现在放弃,一切都会结束。;"
            })
        }
        "list_characters" => serde_json::json!({
            "characters": [
                { "id": "char_shizuka", "name": "静香", "aliases": ["小静"] }
            ]
        }),
        "get_character" => {
            let id = string_arg(args, "id").unwrap_or("");
            if !is_shizuka(id) {
                return serde_json::json!({ "error": format!("找不到角色：{id}") });
            }
            serde_json::json!({
                "id": "char_shizuka",
                "name": "静香",
                "aliases": ["小静"],
                "personality": "克制、敏感，在关键时刻会直面选择。",
                "dialogueStyle": "句子短，先压抑后坚定。",
                "sprites": [
                    { "emotion": "默认", "file": "shizuka_default.png" }
                ]
            })
        }
        "search_assets" => serde_json::json!({
            "total": 1,
            "truncated": false,
            "assets": [
                { "name": "shizuka_default.png", "category": "figure", "character": "静香", "emotion": "默认" }
            ],
            "note": "没有陆岚素材，也没有静香的微笑/惊讶立绘；需要用 plan_character_sprites 只生成 emotion/prompt 框架。"
        }),
        "create_character" => {
            let Some(name) = string_arg(args, "name") else {
                return serde_json::json!({
                    "staged": false,
                    "error": "create_character 需要顶层 name 字段；不要把参数包在 draft 里。"
                });
            };
            if name != "陆岚" {
                return serde_json::json!({
                    "staged": false,
                    "error": format!("本 harness 要求创建角色陆岚,但收到：{name}")
                });
            }
            let preview = serde_json::to_string_pretty(args).unwrap();
            state.created_character_preview = Some(preview.clone());
            serde_json::json!({
                "staged": true,
                "message": "已暂存新建角色设定卡。",
                "preview": preview
            })
        }
        "set_scene_header" => {
            let file = string_arg(args, "file").unwrap_or("");
            let chapter = string_arg(args, "chapter").unwrap_or("");
            let outline = string_arg(args, "outline").unwrap_or("");
            if file != "start.txt" {
                return serde_json::json!({ "staged": false, "error": format!("目标场景必须是 start.txt,收到：{file}") });
            }
            if chapter.is_empty() || outline.is_empty() {
                return serde_json::json!({ "staged": false, "error": "本 harness 要求同时填写 chapter 和 outline。" });
            }
            let preview = format!(
                "start.txt\n; 章节: {chapter}\n; 大纲: {outline}\n:雨夜的教室只剩下静香;\n静香:如果现在放弃,一切都会结束。;"
            );
            state.scene_header_preview = Some(preview.clone());
            serde_json::json!({
                "staged": true,
                "message": "已暂存章节/大纲修改。",
                "preview": preview
            })
        }
        "insert_dialogue_block" => {
            let file = string_arg(args, "file").unwrap_or("");
            if file != "start.txt" {
                return serde_json::json!({ "staged": false, "error": format!("目标场景必须是 start.txt,收到：{file}") });
            }
            if args.get("afterLine").is_none() {
                return serde_json::json!({ "staged": false, "error": "insert_dialogue_block 需要 afterLine。" });
            }
            let Some(lines) = args.get("lines").and_then(|v| v.as_array()) else {
                return serde_json::json!({ "staged": false, "error": "insert_dialogue_block 需要非空 lines。" });
            };
            if lines.is_empty() {
                return serde_json::json!({ "staged": false, "error": "insert_dialogue_block 需要非空 lines。" });
            }
            match structured_dialogue_text(lines) {
                Ok(text) => {
                    state.dialogue_preview = Some(text.clone());
                    serde_json::json!({
                        "staged": true,
                        "message": "已暂存剧情块插入。",
                        "preview": text
                    })
                }
                Err(error) => serde_json::json!({ "staged": false, "error": error }),
            }
        }
        "create_branch" => {
            let file = string_arg(args, "file").unwrap_or("");
            if file != "start.txt" {
                return serde_json::json!({ "staged": false, "error": format!("分支源场景必须是 start.txt,收到：{file}") });
            }
            if args.get("afterLine").is_none() {
                return serde_json::json!({ "staged": false, "error": "create_branch 需要 afterLine。" });
            }
            let Some(choices) = args.get("choices").and_then(|v| v.as_array()) else {
                return serde_json::json!({ "staged": false, "error": "create_branch 至少需要两个 choices。" });
            };
            if choices.len() < 2 {
                return serde_json::json!({ "staged": false, "error": "create_branch 至少需要两个 choices。" });
            }
            match structured_branch_preview(choices) {
                Ok(preview) => {
                    state.branch_preview = Some(preview.clone());
                    serde_json::json!({
                        "staged": true,
                        "message": "已暂存分支和目标场景创建。",
                        "preview": preview
                    })
                }
                Err(error) => serde_json::json!({ "staged": false, "error": error }),
            }
        }
        "plan_character_sprites" => {
            let character = string_arg(args, "character").unwrap_or("");
            if !is_shizuka(character) {
                return serde_json::json!({ "staged": false, "error": format!("本 harness 要求给静香规划表情槽,收到：{character}") });
            }
            let Some(sprites) = args.get("sprites").and_then(|v| v.as_array()) else {
                return serde_json::json!({ "staged": false, "error": "plan_character_sprites 需要非空 sprites。" });
            };
            if sprites.is_empty() {
                return serde_json::json!({ "staged": false, "error": "plan_character_sprites 需要非空 sprites。" });
            }
            let preview = serde_json::to_string_pretty(args).unwrap();
            state.sprite_plan_preview = Some(preview.clone());
            serde_json::json!({
                "staged": true,
                "message": "已暂存表情槽提示词规划。",
                "preview": preview
            })
        }
        other => serde_json::json!({ "error": format!("未知工具：{other}") }),
    }
}

fn string_arg<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn is_shizuka(value: &str) -> bool {
    matches!(value, "静香" | "小静" | "char_shizuka")
}

fn structured_dialogue_text(lines: &[serde_json::Value]) -> Result<String, String> {
    let rendered: Result<Vec<_>, _> = lines.iter().map(structured_dialogue_line).collect();
    rendered.map(|lines| lines.join("\n"))
}

fn structured_dialogue_line(line: &serde_json::Value) -> Result<String, String> {
    if !line.is_object() {
        return Err("剧情行必须是对象。".to_string());
    }
    let kind = string_arg(line, "type").unwrap_or("");
    let text = string_arg(line, "text").unwrap_or("");
    let asset = string_arg(line, "asset").unwrap_or("");
    match kind {
        "narrator" => {
            if text.is_empty() {
                Err("narrator 行缺少 text。".to_string())
            } else {
                Ok(format!(":{text};"))
            }
        }
        "dialogue" => {
            let character = string_arg(line, "character").unwrap_or("");
            if character.is_empty() || text.is_empty() {
                Err("dialogue 行需要 character 和 text。".to_string())
            } else {
                Ok(format!("{character}:{text};"))
            }
        }
        "intro" => {
            if text.is_empty() {
                Err("intro 行缺少 text。".to_string())
            } else {
                Ok(format!("intro:{};", text.replace('\n', "|")))
            }
        }
        "background" => {
            if asset.is_empty() {
                Err("background 行缺少 asset。".to_string())
            } else {
                Ok(format!("changeBg:{asset}{};", next_flag(line)))
            }
        }
        "figure" => {
            let character = string_arg(line, "character").unwrap_or("");
            let emotion = string_arg(line, "emotion").unwrap_or("");
            if asset.is_empty() && (character.is_empty() || emotion.is_empty()) {
                return Err("figure 行需要 asset,或 character + emotion。".to_string());
            }
            if asset.is_empty() && !(is_shizuka(character) && emotion == "默认") {
                return Err("测试 harness 只有静香 默认立绘；其他表情请用 plan_character_sprites 规划提示词。".to_string());
            }
            let figure_asset = if asset.is_empty() {
                "shizuka_default.png"
            } else {
                asset
            };
            let character_flag = if character.is_empty() {
                String::new()
            } else {
                format!(" -figureCharacter={character}")
            };
            let emotion_flag = if emotion.is_empty() {
                String::new()
            } else {
                format!(" -figureEmotion={emotion}")
            };
            Ok(format!(
                "changeFigure:{figure_asset}{character_flag}{emotion_flag}{}{};",
                position_flag(line),
                next_flag(line)
            ))
        }
        "bgm" => {
            if asset.is_empty() {
                Err("bgm 行缺少 asset。".to_string())
            } else {
                Ok(format!("bgm:{asset};"))
            }
        }
        "effect" => {
            if asset.is_empty() {
                Err("effect 行缺少 asset。".to_string())
            } else {
                Ok(format!("playEffect:{asset};"))
            }
        }
        "video" => {
            if asset.is_empty() {
                Err("video 行缺少 asset。".to_string())
            } else {
                Ok(format!("playVideo:{asset};"))
            }
        }
        "jump" => {
            let target = string_arg(line, "target").unwrap_or("");
            if target.is_empty() {
                Err("jump 行缺少 target。".to_string())
            } else {
                Ok(format!("changeScene:{};", normalize_scene_filename(target)))
            }
        }
        "call" => {
            let target = string_arg(line, "target").unwrap_or("");
            if target.is_empty() {
                Err("call 行缺少 target。".to_string())
            } else {
                Ok(format!("callScene:{};", normalize_scene_filename(target)))
            }
        }
        "label" => {
            let label = string_arg(line, "label").unwrap_or(text);
            if label.is_empty() {
                Err("label 行缺少 label。".to_string())
            } else {
                Ok(format!("label:{label};"))
            }
        }
        "end" => Ok("end;".to_string()),
        "comment" => {
            if text.is_empty() {
                Err("comment 行缺少 text。".to_string())
            } else {
                Ok(format!(";{text}"))
            }
        }
        _ => Err(format!("不支持的剧情行类型：{kind}")),
    }
}

fn position_flag(value: &serde_json::Value) -> &'static str {
    match string_arg(value, "position") {
        Some("left") => " -left",
        Some("right") => " -right",
        _ => "",
    }
}

fn next_flag(value: &serde_json::Value) -> &'static str {
    if value.get("next").and_then(|v| v.as_bool()) == Some(false) {
        ""
    } else {
        " -next"
    }
}

fn normalize_scene_filename(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.ends_with(".txt") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.txt")
    }
}

fn structured_branch_preview(choices: &[serde_json::Value]) -> Result<String, String> {
    let mut parts = Vec::new();
    let mut created = Vec::new();
    for choice in choices {
        if !choice.is_object() {
            return Err("choice 必须是对象。".to_string());
        }
        let text = string_arg(choice, "text").unwrap_or("");
        let target = string_arg(choice, "targetScene")
            .or_else(|| string_arg(choice, "target"))
            .or_else(|| string_arg(choice, "file"))
            .unwrap_or("");
        if text.is_empty() || target.is_empty() {
            return Err("choice 需要 text 和 targetScene。".to_string());
        }
        let target_file = normalize_scene_filename(target);
        parts.push(format!(
            "{}:{}",
            escape_choice_part(text),
            escape_choice_part(&target_file)
        ));

        let chapter = string_arg(choice, "chapter").unwrap_or("");
        let outline = string_arg(choice, "outline").unwrap_or("");
        let content = choice
            .get("contentLines")
            .and_then(|v| v.as_array())
            .map(|lines| structured_dialogue_text(lines))
            .transpose()?
            .unwrap_or_default();
        created.push(format!(
            "create {target_file} chapter={chapter} outline={outline} content={content}"
        ));
    }
    Ok(format!("choose:{};\n{}", parts.join("|"), created.join("\n")))
}

fn escape_choice_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '|' | ':' | ';' | '\n' | '\r' => ' ',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string()
}
