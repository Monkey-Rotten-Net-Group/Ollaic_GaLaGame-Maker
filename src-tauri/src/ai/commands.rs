use super::config::{self, AiConfig};
use futures::StreamExt;
use genai::adapter::AdapterKind;
use genai::chat::{ChatMessage, ChatRequest, ChatStreamEvent, StreamChunk};
use genai::resolver::{AuthData, Endpoint, ServiceTargetResolver};
use genai::{Client, ModelIden, ServiceTarget};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize)]
pub struct AiMessageInput {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Start,
    Chunk { content: String },
    Done,
    Error { message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiValidationResult {
    pub ok: bool,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
struct AiLogEntry<'a> {
    timestamp_ms: u128,
    action: &'a str,
    provider: &'a str,
    model: &'a str,
    endpoint: &'a str,
    success: bool,
    message: &'a str,
}

#[tauri::command]
pub fn get_ai_config() -> AiConfig {
    config::load_config()
}

#[tauri::command]
pub fn set_ai_config(config: AiConfig) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
pub async fn validate_ai_config(config: AiConfig) -> Result<AiValidationResult, String> {
    validate_config_basics(&config)?;

    let endpoint = effective_endpoint(&config);
    let request = ChatRequest::new(vec![ChatMessage::user("Reply with exactly OK.")]);
    let client = build_client(&config);

    match client.exec_chat(&config.model, request, None).await {
        Ok(response) => {
            let message = response
                .first_text()
                .map(|text| format!("连接成功，模型返回：{}", text.trim()))
                .unwrap_or_else(|| "连接成功，模型已响应。".to_string());
            log_ai_event("validate", &config, &endpoint, true, &message);
            Ok(AiValidationResult {
                ok: true,
                provider: config.provider,
                model: config.model,
                endpoint,
                message,
            })
        }
        Err(err) => {
            let message = err.to_string();
            log_ai_event("validate", &config, &endpoint, false, &message);
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    request_id: String,
    messages: Vec<AiMessageInput>,
    character_context: Option<String>,
) -> Result<(), String> {
    let cfg = config::load_config();
    validate_config_basics(&cfg)?;

    let mut chat_messages: Vec<ChatMessage> = Vec::new();
    let mut sys_text = config::default_system_prompt();

    if let Some(ref ctx) = character_context {
        if !ctx.is_empty() {
            if !sys_text.is_empty() {
                sys_text.push_str("\n\n");
            }
            sys_text.push_str("## 当前项目的角色设定\n");
            sys_text.push_str(ctx);
        }
    }

    if !sys_text.is_empty() {
        chat_messages.push(ChatMessage::system(&sys_text));
    }
    for m in messages {
        let msg = match m.role.as_str() {
            "user" => ChatMessage::user(m.content),
            "assistant" => ChatMessage::assistant(m.content),
            "system" => ChatMessage::system(m.content),
            _ => ChatMessage::user(m.content),
        };
        chat_messages.push(msg);
    }

    let request = ChatRequest::new(chat_messages);
    let client = build_client(&cfg);
    let model = cfg.model.clone();
    let endpoint = effective_endpoint(&cfg);
    let event_name = format!("ai-chat-{request_id}");

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app_handle.emit(&event_name, AiStreamEvent::Start);
        match client.exec_chat_stream(&model, request, None).await {
            Ok(chat_res) => {
                let mut stream = chat_res.stream;
                while let Some(event) = stream.next().await {
                    match event {
                        Ok(ChatStreamEvent::Chunk(StreamChunk { content })) => {
                            let _ = app_handle.emit(&event_name, AiStreamEvent::Chunk { content });
                        }
                        Ok(ChatStreamEvent::End(_)) => break,
                        Ok(_) => {}
                        Err(e) => {
                            let message = e.to_string();
                            log_ai_event("chat_stream", &cfg, &endpoint, false, &message);
                            let _ = app_handle.emit(&event_name, AiStreamEvent::Error { message });
                            return;
                        }
                    }
                }
                log_ai_event("chat_stream", &cfg, &endpoint, true, "stream completed");
                let _ = app_handle.emit(&event_name, AiStreamEvent::Done);
            }
            Err(e) => {
                let message = e.to_string();
                log_ai_event("chat_stream", &cfg, &endpoint, false, &message);
                let _ = app_handle.emit(&event_name, AiStreamEvent::Error { message });
            }
        }
    });

    Ok(())
}

fn build_client(cfg: &AiConfig) -> Client {
    let api_key = cfg.api_key.clone();
    let base_url = cfg.base_url.clone();
    let provider = cfg.provider.clone();

    let resolver = ServiceTargetResolver::from_resolver_fn(
        move |service_target: ServiceTarget| -> Result<ServiceTarget, genai::resolver::Error> {
            let ServiceTarget {
                mut endpoint,
                mut auth,
                model,
            } = service_target;

            let (forced_kind, default_endpoint) = match provider.as_str() {
                "openai" => (
                    Some(AdapterKind::OpenAI),
                    Some("https://api.openai.com/v1/"),
                ),
                "anthropic" => (
                    Some(AdapterKind::Anthropic),
                    Some("https://api.anthropic.com/v1/"),
                ),
                "gemini" => (
                    Some(AdapterKind::Gemini),
                    Some("https://generativelanguage.googleapis.com/v1beta/"),
                ),
                "deepseek" => (
                    Some(AdapterKind::DeepSeek),
                    Some("https://api.deepseek.com/v1/"),
                ),
                "groq" => (
                    Some(AdapterKind::Groq),
                    Some("https://api.groq.com/openai/v1/"),
                ),
                "xai" => (Some(AdapterKind::Xai), Some("https://api.x.ai/v1/")),
                "ollama" => (
                    Some(AdapterKind::Ollama),
                    Some("http://localhost:11434/v1/"),
                ),
                "cohere" => (
                    Some(AdapterKind::Cohere),
                    Some("https://api.cohere.com/v2/"),
                ),
                "custom" => (Some(AdapterKind::OpenAI), None),
                _ => (None, None),
            };

            let model = if let Some(kind) = forced_kind {
                ModelIden::new(kind, model.model_name)
            } else {
                model
            };

            if !base_url.is_empty() {
                endpoint = Endpoint::from_owned(base_url.clone());
            } else if let Some(default) = default_endpoint {
                endpoint = Endpoint::from_static(default);
            }

            if !api_key.is_empty() {
                auth = AuthData::from_single(api_key.clone());
            }

            Ok(ServiceTarget {
                endpoint,
                auth,
                model,
            })
        },
    );

    Client::builder()
        .with_service_target_resolver(resolver)
        .build()
}

fn validate_config_basics(cfg: &AiConfig) -> Result<(), String> {
    let provider = cfg.provider.trim();
    if provider.is_empty() {
        return Err("尚未选择 AI 供应商".into());
    }
    if cfg.model.trim().is_empty() {
        return Err("尚未配置模型名称".into());
    }
    if provider == "custom" && cfg.base_url.trim().is_empty() {
        return Err("自定义 OpenAI 兼容接口需要填写 Base URL".into());
    }
    if cfg.api_key.trim().is_empty() && provider != "ollama" && provider != "custom" {
        return Err("尚未配置 API Key，请先在 AI 设置中填写".into());
    }
    Ok(())
}

fn effective_endpoint(cfg: &AiConfig) -> String {
    if !cfg.base_url.trim().is_empty() {
        return cfg.base_url.trim().to_string();
    }
    match cfg.provider.as_str() {
        "openai" => "https://api.openai.com/v1/".to_string(),
        "anthropic" => "https://api.anthropic.com/v1/".to_string(),
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/".to_string(),
        "deepseek" => "https://api.deepseek.com/v1/".to_string(),
        "groq" => "https://api.groq.com/openai/v1/".to_string(),
        "xai" => "https://api.x.ai/v1/".to_string(),
        "ollama" => "http://localhost:11434/v1/".to_string(),
        "cohere" => "https://api.cohere.com/v2/".to_string(),
        "custom" => String::new(),
        _ => String::new(),
    }
}

fn log_ai_event(action: &str, cfg: &AiConfig, endpoint: &str, success: bool, message: &str) {
    let entry = AiLogEntry {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        action,
        provider: &cfg.provider,
        model: &cfg.model,
        endpoint,
        success,
        message,
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = config::append_log_line(&line);
    }
}
