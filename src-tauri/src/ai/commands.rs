use super::chat_runs::ChatRunRegistry;
use super::config::{self, AiConfig, AiProviderConfig};
use super::gateway::transport::{is_placeholder_base_url, resolved_base_url};
use super::gateway::types::ImageReference;
// Re-exported: this module is the IPC facade, so callers keep importing the
// media result type from here rather than reaching into the gateway.
pub use super::gateway::types::GeneratedMedia;
use super::gateway::{self};
use super::provider_capability::{capability_for_config, ProviderCapability, RequiredCapability};
use super::registry::{self, Modality, ProviderCatalog};
use base64::Engine;
use futures::StreamExt;
use genai::adapter::AdapterKind;
use genai::chat::{
    ChatMessage, ChatOptions, ChatRequest, ChatResponseFormat, ChatStreamEvent, StreamChunk, Tool,
    ToolCall, ToolResponse,
};
use genai::resolver::{AuthData, Endpoint, ServiceTargetResolver};
use genai::{Client, ModelIden, ServiceTarget};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_LOG_LIMIT: usize = 500;
const DEFAULT_LOG_LIMIT: usize = 100;
const MAX_LOG_FIELD_CHARS: usize = 50_000;
const MAX_TRACE_FIELD_CHARS: usize = 50_000;
const HTTP_REQUEST_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Deserialize)]
pub struct ToolCallInput {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct AiMessageInput {
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// For assistant turns that requested tools: the tool calls to replay.
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCallInput>>,
    /// For role == "tool": the originating tool call id this content answers.
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ToolDef {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for the tool parameters.
    pub parameters: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTurnResult {
    pub text: Option<String>,
    pub tool_calls: Vec<AiToolCall>,
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

#[derive(Debug, Deserialize)]
struct RawAiLogEntry {
    timestamp_ms: u128,
    action: String,
    provider: String,
    model: String,
    endpoint: String,
    success: bool,
    message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiLogOutput {
    pub timestamp_ms: u128,
    pub action: String,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub success: bool,
    pub message: String,
}

/// The provider pickers for every settings tab, generated from the backend
/// registry. The UI used to hard-code these lists, which let them drift from
/// what the backend actually supports; it now renders whatever this returns.
#[tauri::command]
pub fn list_ai_providers() -> ProviderCatalog {
    registry::catalog()
}

#[tauri::command]
pub fn get_ai_config() -> AiConfig {
    config::load_config()
}

#[tauri::command]
pub fn set_ai_config(config: AiConfig) -> Result<(), String> {
    capability_for_config(&config)?;
    config::save_config(&config)
}

/// Resolve the live provider capability for the saved config (or an override
/// passed from the UI for preview). Re-reads from disk on every call so
/// changes to provider, model, or `flow_step_deadline_ms` show up the moment a
/// new Flow is created, without restarting the app.
#[tauri::command]
pub fn get_ai_provider_capability(config: Option<AiConfig>) -> Result<ProviderCapability, String> {
    let config = config.unwrap_or_else(config::load_config);
    capability_for_config(&config)
}

#[tauri::command]
pub fn get_ai_image_config() -> AiProviderConfig {
    config::load_image_config()
}

#[tauri::command]
pub fn set_ai_image_config(config: AiProviderConfig) -> Result<(), String> {
    config::save_image_config(&config)
}

#[tauri::command]
pub fn get_ai_tts_config() -> AiProviderConfig {
    config::load_tts_config()
}

#[tauri::command]
pub fn set_ai_tts_config(config: AiProviderConfig) -> Result<(), String> {
    config::save_tts_config(&config)
}

#[tauri::command]
pub fn get_ai_music_config() -> AiProviderConfig {
    config::load_music_config()
}

#[tauri::command]
pub fn set_ai_music_config(config: AiProviderConfig) -> Result<(), String> {
    config::save_music_config(&config)
}

#[tauri::command]
pub fn list_ai_logs(limit: Option<usize>) -> Result<Vec<AiLogOutput>, String> {
    let limit = normalize_log_limit(limit);
    let lines = config::read_log_lines(limit)?;
    Ok(parse_ai_log_lines(lines))
}

#[tauri::command]
pub fn clear_ai_logs() -> Result<(), String> {
    config::clear_log()
}

#[tauri::command]
pub fn get_ai_log_path() -> Result<String, String> {
    config::log_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_ai_agent_trace_path() -> Result<String, String> {
    config::agent_trace_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn append_ai_agent_trace(payload: serde_json::Value) -> Result<(), String> {
    let sanitized = sanitize_trace_value(payload);
    let line = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;
    config::append_agent_trace_line(&line)
}

#[tauri::command]
pub async fn ai_generate_image(
    app_handle: AppHandle,
    prompt: String,
    model: String,
    reference_image_path: Option<String>,
) -> Result<GeneratedMedia, String> {
    generate_image_media(Some(&app_handle), prompt, model, reference_image_path).await
}

pub(crate) async fn generate_image_media(
    app_handle: Option<&AppHandle>,
    prompt: String,
    model: String,
    reference_image_path: Option<String>,
) -> Result<GeneratedMedia, String> {
    // Optional reference image (image-to-image). Only some providers accept
    // one; the rest ignore it rather than failing.
    let reference = match reference_image_path {
        Some(path) if !path.trim().is_empty() => Some(read_image_reference(path.trim())?),
        _ => None,
    };
    gateway::generate_image(app_handle, &prompt, &model, reference.as_ref()).await
}

#[tauri::command]
pub async fn ai_generate_tts(
    text: String,
    voice_prompt: String,
    model: String,
    format: String,
) -> Result<GeneratedMedia, String> {
    generate_tts_media(text, voice_prompt, model, format).await
}

pub(crate) async fn generate_tts_media(
    text: String,
    voice_prompt: String,
    model: String,
    format: String,
) -> Result<GeneratedMedia, String> {
    gateway::generate_tts(&text, &voice_prompt, &model, &format).await
}

/// Generate background music (BGM) from a text prompt. The configured endpoint
/// is expected to accept `{model, input, response_format}` and return raw audio
/// bytes, or a JSON envelope carrying base64 audio or a downloadable URL.
#[tauri::command]
pub async fn generate_music(
    prompt: String,
    model: String,
    format: String,
) -> Result<GeneratedMedia, String> {
    generate_music_media(prompt, model, format).await
}

pub(crate) async fn generate_music_media(
    prompt: String,
    model: String,
    format: String,
) -> Result<GeneratedMedia, String> {
    gateway::generate_music(&prompt, &model, &format).await
}

#[tauri::command]
pub async fn validate_ai_config(config: AiConfig) -> Result<AiValidationResult, String> {
    validate_config_basics(&config)?;
    capability_for_config(&config)?;

    let endpoint = effective_endpoint(&config);
    let request = ChatRequest::new(vec![ChatMessage::user("Reply with exactly OK.")]);
    let client = build_client(&config);

    let options = chat_debug_options();
    match client
        .exec_chat(&config.model, request, Some(&options))
        .await
    {
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
    capability_for_config(&cfg)?;

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
        let options = chat_debug_options();
        match client
            .exec_chat_stream(&model, request, Some(&options))
            .await
        {
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

/// Convert frontend message inputs into genai chat messages, replaying tool
/// calls (assistant) and tool responses (tool role) so multi-step loops keep
/// full provider-side context.
fn to_chat_messages(messages: Vec<AiMessageInput>) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => out.push(ChatMessage::system(m.content)),
            "tool" => {
                let call_id = m.tool_call_id.unwrap_or_default();
                out.push(ToolResponse::new(call_id, m.content).into());
            }
            "assistant" => {
                if let Some(calls) = m.tool_calls {
                    if !calls.is_empty() {
                        let tool_calls: Vec<ToolCall> = calls
                            .into_iter()
                            .map(|c| ToolCall {
                                call_id: c.id,
                                fn_name: c.name,
                                fn_arguments: c.arguments,
                                thought_signatures: None,
                            })
                            .collect();
                        out.push(tool_calls.into());
                        continue;
                    }
                }
                out.push(ChatMessage::assistant(m.content));
            }
            _ => out.push(ChatMessage::user(m.content)),
        }
    }
    out
}

/// Single non-streaming turn used by the multi-step agent loop. Returns either
/// the model's tool calls (to be executed by the frontend) or its final text.
/// Internal helper. Not registered as a Tauri command. Callers must go
/// through [`ai_chat_turn_owned`] so a single `run_id` is owned by the
/// `ChatRunRegistry` and a Stop can revoke the in-flight provider work.
pub(crate) async fn ai_chat_turn(
    messages: Vec<AiMessageInput>,
    tools: Vec<ToolDef>,
    character_context: Option<String>,
) -> Result<AiTurnResult, String> {
    let cfg = config::load_config();
    validate_config_basics(&cfg)?;
    let capability = capability_for_config(&cfg)?;
    if !tools.is_empty() {
        capability.require(RequiredCapability::ChatTools)?;
    }

    let mut chat_messages: Vec<ChatMessage> = Vec::new();
    if let Some(ctx) = character_context {
        if !ctx.trim().is_empty() {
            chat_messages.push(ChatMessage::system(format!("## 当前项目的角色设定\n{ctx}")));
        }
    }
    chat_messages.extend(to_chat_messages(messages));

    let mut request = ChatRequest::new(chat_messages);
    if !tools.is_empty() {
        let genai_tools: Vec<Tool> = tools
            .into_iter()
            .map(|t| {
                Tool::new(t.name)
                    .with_description(t.description)
                    .with_schema(t.parameters)
            })
            .collect();
        request = request.with_tools(genai_tools);
    }

    let client = build_client(&cfg);
    let endpoint = effective_endpoint(&cfg);

    let options = chat_debug_options();
    match client.exec_chat(&cfg.model, request, Some(&options)).await {
        Ok(response) => {
            let text = response.first_text().map(|t| t.to_string());
            let tool_calls = response
                .into_tool_calls()
                .into_iter()
                .map(|c| AiToolCall {
                    id: c.call_id,
                    name: c.fn_name,
                    arguments: c.fn_arguments,
                })
                .collect();
            log_ai_event("chat_turn", &cfg, &endpoint, true, "turn completed");
            Ok(AiTurnResult { text, tool_calls })
        }
        Err(err) => {
            let message = err.to_string();
            log_ai_event("chat_turn", &cfg, &endpoint, false, &message);
            Err(message)
        }
    }
}

/// Public conversational entry point. Every awaited Provider turn runs
/// through the [`ChatRunRegistry`] so a later Stop can revoke it; the
/// unowned helper [`ai_chat_turn`] is **not** registered as a Tauri command.
#[tauri::command]
pub async fn ai_chat_turn_owned(
    runs: tauri::State<'_, ChatRunRegistry>,
    run_id: String,
    messages: Vec<AiMessageInput>,
    tools: Vec<ToolDef>,
    character_context: Option<String>,
) -> Result<AiTurnResult, String> {
    runs.run_cancellable(&run_id, ai_chat_turn(messages, tools, character_context))
        .await
}

/// Frontend Stop signal. Returns `true` if a live Run was signalled, `false`
/// if the id was already completed or never started. Idempotent.
#[tauri::command]
pub async fn ai_chat_cancel(
    runs: tauri::State<'_, ChatRunRegistry>,
    run_id: String,
) -> Result<bool, String> {
    Ok(runs.cancel(&run_id).await)
}

/// Pipeline Agent entry point. `None` means no usable chat model is configured,
/// so the caller may use an explicit local fallback. Provider failures remain
/// errors and must not be silently downgraded.
pub(crate) async fn complete_agent_text(
    system_prompt: &str,
    user_prompt: &str,
) -> Result<Option<(String, String, Option<u32>, Option<u32>)>, String> {
    let cfg = config::load_config();
    if validate_config_basics(&cfg).is_err() {
        return Ok(None);
    }
    let capability = capability_for_config(&cfg)?;
    let request = ChatRequest::new(vec![
        ChatMessage::system(system_prompt),
        ChatMessage::user(user_prompt),
    ]);
    let endpoint = effective_endpoint(&cfg);
    let options = if capability.json_mode {
        chat_debug_options().with_response_format(ChatResponseFormat::JsonMode)
    } else {
        chat_debug_options()
    };
    match build_client(&cfg)
        .exec_chat(&cfg.model, request, Some(&options))
        .await
    {
        Ok(response) => {
            let text = response
                .first_text()
                .map(str::to_string)
                .ok_or_else(|| "Agent model returned no text".to_string())?;
            log_ai_event(
                "pipeline_agent",
                &cfg,
                &endpoint,
                true,
                "agent turn completed",
            );
            Ok(Some((
                text,
                cfg.model,
                response
                    .usage
                    .prompt_tokens
                    .and_then(|value| u32::try_from(value).ok()),
                response
                    .usage
                    .completion_tokens
                    .and_then(|value| u32::try_from(value).ok()),
            )))
        }
        Err(error) => {
            let message = error.to_string();
            log_ai_event("pipeline_agent", &cfg, &endpoint, false, &message);
            Err(message)
        }
    }
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

            let forced_kind = match provider.as_str() {
                "openai" => Some(AdapterKind::OpenAI),
                "anthropic" => Some(AdapterKind::Anthropic),
                "gemini" => Some(AdapterKind::Gemini),
                "deepseek" => Some(AdapterKind::DeepSeek),
                "groq" => Some(AdapterKind::Groq),
                "xai" => Some(AdapterKind::Xai),
                "ollama" => Some(AdapterKind::Ollama),
                "cohere" => Some(AdapterKind::Cohere),
                // Custom OpenAI-compatible endpoints speak the OpenAI dialect but
                // have no built-in default URL (caller must set base_url).
                "custom" => Some(AdapterKind::OpenAI),
                _ => None,
            };
            let model = if let Some(kind) = forced_kind {
                ModelIden::new(kind, model.model_name)
            } else {
                model
            };

            let resolved = resolved_base_url(&provider, Modality::Chat, &base_url);
            if !resolved.is_empty() {
                endpoint = Endpoint::from_owned(resolved);
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

fn chat_debug_options() -> ChatOptions {
    ChatOptions::default().with_capture_raw_body(true)
}

fn validate_config_basics(cfg: &AiConfig) -> Result<(), String> {
    let provider = cfg.provider.trim();
    if provider.is_empty() {
        return Err("尚未选择 AI 供应商".into());
    }
    if cfg.model.trim().is_empty() {
        return Err("尚未配置模型名称".into());
    }
    if is_placeholder_base_url(&cfg.base_url) {
        return Err("Base URL 仍是示例地址，请填写真实接口地址".into());
    }
    let needs_base_url = registry::modality_spec(provider, Modality::Chat)
        .is_some_and(|spec| spec.needs_base_url());
    if needs_base_url && cfg.base_url.trim().is_empty() {
        return Err("该供应商没有内置地址，需要填写 Base URL".into());
    }
    if cfg.api_key.trim().is_empty() && requires_api_key(provider) {
        return Err("尚未配置 API Key，请先在 AI 设置中填写".into());
    }
    Ok(())
}

pub(crate) fn has_agent_chat_config() -> bool {
    validate_config_basics(&config::load_config()).is_ok()
}

fn effective_endpoint(cfg: &AiConfig) -> String {
    resolved_base_url(&cfg.provider, Modality::Chat, &cfg.base_url)
}

/// Read a local image file into an image-to-image reference. Used by the
/// providers that accept one; the rest ignore it.
fn read_image_reference(path: &str) -> Result<ImageReference, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取参考图失败 {path}: {e}"))?;
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    Ok(ImageReference {
        mime: mime.to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

pub(crate) async fn download_generated_media(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    url: &str,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    // Refuse providers that have not declared they hand back usable media
    // URLs. Otherwise a hostile or misconfigured provider can use this
    // path to pivot the SSRF guard into a real network fetch — and a
    // permissive `media_url_output` flag is exactly what we want to
    // gate behind explicit acknowledgement. `AiProviderConfig` does not
    // carry the optional `capabilities` declaration; the capability
    // resolver falls back to the table default in that case.
    let as_chat_config = AiConfig {
        provider: cfg.provider.clone(),
        model: cfg.model.clone(),
        api_key: cfg.api_key.clone(),
        base_url: cfg.base_url.clone(),
        capabilities: None,
    };
    let capability = capability_for_config(&as_chat_config)?;
    capability.require(RequiredCapability::MediaUrlOutput)?;
    let kind = if action.contains("image") {
        super::safe_media_fetch::MediaKind::Image
    } else {
        super::safe_media_fetch::MediaKind::Audio
    };
    let bytes = super::safe_media_fetch::fetch_media(
        url,
        &super::safe_media_fetch::SystemMediaDnsResolver,
        &super::safe_media_fetch::FetchPolicy {
            total_deadline: Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS),
            kind,
            allow_address: Box::new(|_, ip| super::safe_media_fetch::is_public_download_ip(ip)),
        },
    )
    .await?;
    log_provider_event(action, cfg, model, endpoint, true, "media generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
        extension: extension.to_string(),
    })
}

pub(crate) fn validate_provider_config_basics(
    cfg: &AiProviderConfig,
    capability: &str,
) -> Result<(), String> {
    if cfg.provider.trim().is_empty() {
        return Err(format!("尚未选择{capability} AI 供应商"));
    }
    if cfg.model.trim().is_empty() {
        return Err(format!("尚未配置{capability}模型"));
    }
    if is_placeholder_base_url(&cfg.base_url) {
        return Err(format!(
            "{capability} Base URL 仍是示例地址，请填写真实接口地址"
        ));
    }
    if cfg.api_key.trim().is_empty() && requires_api_key(&cfg.provider) {
        return Err(format!("尚未配置{capability} API Key"));
    }
    Ok(())
}

/// Whether this provider must have an API key. Local services and
/// OpenAI-compatible gateways are commonly unauthenticated, so the registry
/// decides rather than each call site keeping its own exemption list.
fn requires_api_key(provider: &str) -> bool {
    registry::find(provider).is_none_or(|spec| spec.requires_api_key)
}

pub(crate) fn log_provider_event(
    action: &str,
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    success: bool,
    message: &str,
) {
    let chat_cfg = AiConfig {
        provider: cfg.provider.clone(),
        model: model.to_string(),
        api_key: cfg.api_key.clone(),
        base_url: cfg.base_url.clone(),
        capabilities: None,
    };
    log_ai_event(action, &chat_cfg, endpoint, success, message);
}

fn log_ai_event(action: &str, cfg: &AiConfig, endpoint: &str, success: bool, message: &str) {
    let redacted_endpoint = sanitize_log_field(&redact_known_secret(endpoint, &cfg.api_key));
    let redacted_message = sanitize_log_field(&redact_known_secret(message, &cfg.api_key));
    let entry = AiLogEntry {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        action,
        provider: &cfg.provider,
        model: &cfg.model,
        endpoint: &redacted_endpoint,
        success,
        message: &redacted_message,
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = config::append_log_line(&line);
    }
}

fn normalize_log_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LOG_LIMIT).min(MAX_LOG_LIMIT)
}

fn parse_ai_log_lines(lines: Vec<String>) -> Vec<AiLogOutput> {
    lines
        .into_iter()
        .filter_map(|line| parse_ai_log_line(&line))
        .collect()
}

fn parse_ai_log_line(line: &str) -> Option<AiLogOutput> {
    let raw = serde_json::from_str::<RawAiLogEntry>(line).ok()?;
    Some(AiLogOutput {
        timestamp_ms: raw.timestamp_ms,
        action: sanitize_log_field(&raw.action),
        provider: sanitize_log_field(&raw.provider),
        model: sanitize_log_field(&raw.model),
        endpoint: sanitize_log_field(&raw.endpoint),
        success: raw.success,
        message: sanitize_log_field(&raw.message),
    })
}

fn sanitize_trace_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(sanitize_trace_field(&s)),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(sanitize_trace_value).collect())
        }
        serde_json::Value::Object(map) => {
            let sanitized = map
                .into_iter()
                .map(|(key, value)| {
                    let key_lower = key.to_ascii_lowercase();
                    let value = if key_lower.contains("apikey")
                        || key_lower.contains("api_key")
                        || key_lower == "key"
                        || key_lower.contains("token")
                        || key_lower.contains("authorization")
                    {
                        serde_json::Value::String("[REDACTED]".to_string())
                    } else {
                        sanitize_trace_value(value)
                    };
                    (sanitize_log_field(&key), value)
                })
                .collect();
            serde_json::Value::Object(sanitized)
        }
        other => other,
    }
}

fn sanitize_trace_field(value: &str) -> String {
    truncate_trace_field(&redact_common_secrets(value))
}

fn sanitize_log_field(value: &str) -> String {
    truncate_log_field(&redact_common_secrets(value))
}

fn redact_known_secret(value: &str, secret: &str) -> String {
    let secret = secret.trim();
    if secret.is_empty() {
        value.to_string()
    } else {
        value.replace(secret, "[REDACTED]")
    }
}

fn redact_common_secrets(value: &str) -> String {
    let mut output = value.to_string();
    for marker in [
        "authorization=bearer ",
        "api_key=",
        "apikey=",
        "access_token=",
        "token=",
        "key=",
        "authorization=",
        "bearer ",
    ] {
        output = redact_after_marker(&output, marker);
    }
    output
}

fn redact_after_marker(value: &str, marker: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut cursor = 0;
    let mut redacted = String::new();

    while let Some(relative_start) = lower[cursor..].find(marker) {
        let start = cursor + relative_start;
        let marker_end = start + marker.len();
        let mut end = marker_end;
        while end < value.len() {
            let ch = value.as_bytes()[end] as char;
            if ch == '&' || ch == '"' || ch == '\'' || ch.is_ascii_whitespace() {
                break;
            }
            end += 1;
        }

        redacted.push_str(&value[cursor..marker_end]);
        redacted.push_str("[REDACTED]");
        cursor = end;
    }

    if cursor == 0 {
        value.to_string()
    } else {
        redacted.push_str(&value[cursor..]);
        redacted
    }
}

pub(crate) fn truncate_log_field(value: &str) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(MAX_LOG_FIELD_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn truncate_trace_field(value: &str) -> String {
    let mut chars = value.chars();
    let truncated = chars
        .by_ref()
        .take(MAX_TRACE_FIELD_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

// ── Batch TTS ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTtsItem {
    pub voice_card_id: String,
    pub text: String,
    pub voice_prompt: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchTtsProgress {
    pub voice_card_id: String,
    pub index: usize,
    pub total: usize,
    pub status: String, // "generating" | "done" | "error"
    pub message: String,
    /// Name of the generated audio file on success.
    pub asset_name: Option<String>,
}

/// Generate TTS audio for multiple voice cards in sequence, emitting progress
/// events via `batch-tts-progress` so the UI can show per-item status.
#[tauri::command]
pub async fn generate_batch_tts(
    app_handle: tauri::AppHandle,
    project_path: String,
    items: Vec<BatchTtsItem>,
    model: String,
    format: String,
) -> Result<Vec<BatchTtsProgress>, String> {
    let cfg = config::load_tts_config();
    validate_provider_config_basics(&cfg, "音频")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("尚未选择音频生成模型".to_string());
    }

    let total = items.len();
    let mut results: Vec<BatchTtsProgress> = Vec::with_capacity(total);

    // Resolve a friendly filename stem for each card from its `target_stem`
    // (e.g. "vo_角色_场景_3"), so generated audio is easy for users to locate
    // instead of the opaque "vo_batch_<id>" naming.
    let stem_map: std::collections::HashMap<String, String> =
        crate::project_lock::with_project_lock(std::path::Path::new(&project_path), || {
            crate::assets::commands::read_asset_metadata(&project_path).map(|meta| {
                meta.voice_cards
                    .into_iter()
                    .filter(|(_, c)| !c.target_stem.trim().is_empty())
                    .map(|(id, c)| (id, c.target_stem))
                    .collect::<std::collections::HashMap<_, _>>()
            })
        })?;

    for (index, item) in items.iter().enumerate() {
        let progress_start = BatchTtsProgress {
            voice_card_id: item.voice_card_id.clone(),
            index,
            total,
            status: "generating".to_string(),
            message: format!("正在生成 {}/{}...", index + 1, total),
            asset_name: None,
        };
        let _ = app_handle.emit("batch-tts-progress", &progress_start);

        // Routing through the gateway keeps batch generation on exactly the
        // same provider set as single-clip generation; the config is resolved
        // once above rather than re-read for every item.
        let gen_result =
            gateway::generate_tts_with(&cfg, &item.text, &item.voice_prompt, model, &format).await;

        match gen_result {
            Ok(media) => {
                // Save the audio file to disk, preferring the card's friendly
                // target stem and falling back to the id-based name. Use the
                // extension reported by the provider (e.g. Qwen-TTS returns wav
                // regardless of the requested response_format) so the file's
                // contents and extension always match.
                let stem = stem_map
                    .get(&item.voice_card_id)
                    .cloned()
                    .unwrap_or_else(|| format!("vo_batch_{}", item.voice_card_id));
                let filename = format!("{}.{}", stem, media.extension);
                let save = crate::assets::commands::save_generated_asset(
                    project_path.clone(),
                    "vocal".to_string(),
                    filename.clone(),
                    media.base64_data.clone(),
                );
                let asset_name = match save {
                    Ok(info) => info.name,
                    Err(e) => {
                        let err_progress = BatchTtsProgress {
                            voice_card_id: item.voice_card_id.clone(),
                            index,
                            total,
                            status: "error".to_string(),
                            message: format!("保存音频文件失败: {e}"),
                            asset_name: None,
                        };
                        let _ = app_handle.emit("batch-tts-progress", &err_progress);
                        results.push(err_progress);
                        continue;
                    }
                };

                // Update VoiceAssetCard
                let metadata_update: Result<(), String> = crate::project_lock::with_project_lock(
                    std::path::Path::new(&project_path),
                    || {
                        let mut asset_meta =
                            crate::assets::commands::read_asset_metadata(&project_path)?;
                        if let Some(card) = asset_meta.voice_cards.get_mut(&item.voice_card_id) {
                            card.voice_asset = Some(asset_name.clone());
                            // Update tags
                            let tag_key = format!("vocal/{}", card.target_stem);
                            let mut tags: Vec<String> =
                                asset_meta.tags.get(&tag_key).cloned().unwrap_or_default();
                            tags.retain(|t| !t.starts_with("status:"));
                            tags.push("status:done".to_string());
                            tags.retain(|t| !t.starts_with("source:"));
                            tags.push("source:ai".to_string());
                            asset_meta.tags.insert(tag_key, tags);
                            crate::assets::commands::write_asset_metadata(
                                &project_path,
                                &asset_meta,
                            )?;
                        }
                        Ok(())
                    },
                );
                if let Err(error) = metadata_update {
                    let err_progress = BatchTtsProgress {
                        voice_card_id: item.voice_card_id.clone(),
                        index,
                        total,
                        status: "error".to_string(),
                        message: format!("更新音频素材信息失败: {error}"),
                        asset_name: Some(asset_name),
                    };
                    let _ = app_handle.emit("batch-tts-progress", &err_progress);
                    results.push(err_progress);
                    continue;
                }

                let progress_done = BatchTtsProgress {
                    voice_card_id: item.voice_card_id.clone(),
                    index,
                    total,
                    status: "done".to_string(),
                    message: format!("完成 {}/{}: {}", index + 1, total, asset_name),
                    asset_name: Some(asset_name),
                };
                let _ = app_handle.emit("batch-tts-progress", &progress_done);
                results.push(progress_done);
            }
            Err(err) => {
                let progress_err = BatchTtsProgress {
                    voice_card_id: item.voice_card_id.clone(),
                    index,
                    total,
                    status: "error".to_string(),
                    message: format!("生成失败: {err}"),
                    asset_name: None,
                };
                let _ = app_handle.emit("batch-tts-progress", &progress_err);
                results.push(progress_err);
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
fn list_ai_logs_from_path(
    path: &PathBuf,
    limit: Option<usize>,
) -> Result<Vec<AiLogOutput>, String> {
    let limit = normalize_log_limit(limit);
    let lines = config::read_log_lines_at(path, limit)?;
    Ok(parse_ai_log_lines(lines))
}

#[cfg(test)]
fn clear_ai_logs_at(path: &PathBuf) -> Result<(), String> {
    config::clear_log_at(path)
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
