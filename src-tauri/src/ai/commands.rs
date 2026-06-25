use super::config::{self, AiConfig, AiProviderConfig};
use futures::{SinkExt, StreamExt};
use genai::adapter::AdapterKind;
use genai::chat::{
    ChatMessage, ChatRequest, ChatStreamEvent, StreamChunk, Tool, ToolCall, ToolResponse,
};
use genai::resolver::{AuthData, Endpoint, ServiceTargetResolver};
use genai::{Client, ModelIden, ServiceTarget};
use base64::Engine;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_LOG_LIMIT: usize = 500;
const DEFAULT_LOG_LIMIT: usize = 100;
const MAX_LOG_FIELD_CHARS: usize = 1000;
const MAX_TRACE_FIELD_CHARS: usize = 50_000;
const HTTP_REQUEST_TIMEOUT_SECS: u64 = 180;

/// A reqwest client with the standard request timeout applied. Using this
/// everywhere prevents media/TTS HTTP calls from hanging forever when a
/// provider stalls. Falls back to a default client if the builder fails.
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

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
#[serde(rename_all = "camelCase")]
pub struct GeneratedMedia {
    pub base64_data: String,
    pub extension: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiMediaGenerationProgress {
    pub provider: String,
    pub model: String,
    pub phase: String,
    pub attempt: u8,
    pub total_attempts: u8,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageResponse {
    data: Vec<OpenAiImageItem>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageItem {
    #[serde(default)]
    b64_json: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTaskCreateResponse {
    output: DashScopeTaskOutput,
}

#[derive(Debug, Deserialize)]
struct DashScopeTaskOutput {
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    task_status: Option<String>,
    #[serde(default)]
    results: Vec<DashScopeImageResult>,
}

#[derive(Debug, Deserialize)]
struct DashScopeImageResult {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTtsResponse {
    #[serde(default)]
    output: Option<DashScopeTtsOutput>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTtsOutput {
    #[serde(default)]
    audio: Option<DashScopeTtsAudio>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTtsAudio {
    /// 流式合成时为 Base64 音频数据；非流式时为空。
    #[serde(default)]
    data: Option<String>,
    /// 非流式合成时为音频文件 URL（有效期 24 小时）。
    #[serde(default)]
    url: Option<String>,
}

/// 火山引擎 HTTP 单向流式 TTS 的单个分块。接口以流式返回多行 JSON，
/// 每行一个该结构；`data` 为该块的 Base64 音频（结束块通常为空）。
#[derive(Debug, Deserialize)]
struct VolcengineTtsChunk {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    data: Option<String>,
}

/// 阿里云 CosyVoice WebSocket 服务端文本事件。音频不在 JSON 内，单独走 binary 帧；
/// 这里只解析 header 用于判定任务状态（task-started/result-generated/task-finished/task-failed）。
#[derive(Debug, Deserialize)]
struct CosyVoiceEvent {
    header: CosyVoiceEventHeader,
}

#[derive(Debug, Deserialize)]
struct CosyVoiceEventHeader {
    #[serde(default)]
    event: String,
    #[serde(default)]
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiGenerateResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    #[serde(default)]
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiPart {
    #[serde(default)]
    inline_data: Option<GeminiInlineData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiInlineData {
    #[serde(default)]
    mime_type: String,
    data: String,
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

#[tauri::command]
pub fn get_ai_config() -> AiConfig {
    config::load_config()
}

#[tauri::command]
pub fn set_ai_config(config: AiConfig) -> Result<(), String> {
    config::save_config(&config)
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
    let cfg = config::load_image_config();
    validate_provider_config_basics(&cfg, "图片")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("尚未选择图片生成模型".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("图片生成描述为空".to_string());
    }

    // 可选参考图（图生图）：读成 (mime, base64)，仅部分 provider 适配，其余忽略。
    let reference = match reference_image_path {
        Some(path) if !path.trim().is_empty() => Some(read_image_as_base64(path.trim())?),
        _ => None,
    };

    match cfg.provider.trim() {
        "openai" | "custom" | "zhipu" | "siliconflow" | "midjourney" => {
            generate_openai_compatible_image(&cfg, model, &prompt, reference.as_ref()).await
        }
        "volcengine" => {
            // 火山引擎 Seedream 4.x 支持 base64 参考图（图生图），按官方文档以
            // data:image/<格式>;base64,<编码> 形式传入 image 字段，实现角色一致性。
            generate_openai_compatible_image(&cfg, model, &prompt, reference.as_ref()).await
        }
        "aliyun" => generate_dashscope_image(&app_handle, &cfg, model, &prompt).await,
        "gemini" => generate_gemini_image(&cfg, model, &prompt, reference.as_ref()).await,
        "sd-webui" => generate_sd_webui_image(&cfg, &prompt).await,
        "stability" => Err("Stability AI 图片接口需要 multipart/form-data；当前客户端尚未启用该格式，请先通过自定义 OpenAI 兼容网关接入。".to_string()),
        "baidu" => Err("百度千帆/文心一格图片接口需要 Access Token 获取流程；当前配置不足以直连。请使用 OpenAI 兼容网关或后续补充 OAuth 配置。".to_string()),
        "tencent" => Err("腾讯混元图像接口需要 TC3 签名参数；当前配置不足以直连。请使用 OpenAI 兼容网关或后续补充 SecretId/SecretKey/Region 配置。".to_string()),
        "minimax" => Err("MiniMax 图片接口是原生 /v1/image_generation 协议，不是 OpenAI /v1/images/generations；当前客户端尚未适配原生请求体，请先通过 OpenAI 兼容网关接入。".to_string()),
        "replicate" | "fal" => Err("Replicate/fal.ai 图片接口是任务式 API，且不同模型路由不同；当前模型字段不足以稳定直连。请先通过自定义网关接入。".to_string()),
        "comfyui" => Err("ComfyUI 需要完整 workflow JSON 才能生成图片；当前 UI 只有模型选择，尚未适配 workflow 提交。".to_string()),
        other => Err(format!("当前暂未适配 {other} 图片生成接口，请使用 OpenAI 兼容 Base URL 或选择已适配供应商。")),
    }
}

#[tauri::command]
pub async fn ai_generate_tts(
    text: String,
    voice_prompt: String,
    model: String,
    format: String,
) -> Result<GeneratedMedia, String> {
    let cfg = config::load_tts_config();
    validate_provider_config_basics(&cfg, "音频")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("尚未选择音频生成模型".to_string());
    }
    if text.trim().is_empty() {
        return Err("语音文本为空".to_string());
    }

    let response_format = normalize_audio_format(&format);
    match cfg.provider.trim() {
        "openai" | "custom" => {
            generate_openai_compatible_tts(&cfg, model, &text, &voice_prompt, response_format).await
        }
        "elevenlabs" => generate_elevenlabs_tts(&cfg, model, &text, &voice_prompt, response_format).await,
        "aliyun" => generate_dashscope_tts(&cfg, model, &text, &voice_prompt, response_format).await,
        "volcengine" => generate_volcengine_tts(&cfg, model, &text, &voice_prompt, response_format).await,
        other => Err(format!("当前暂未适配 {other} 音频生成接口，请使用 OpenAI 兼容 Base URL 或选择已适配供应商。")),
    }
}

/// Generate background music (BGM) from a text prompt via an OpenAI-compatible /
/// custom audio endpoint. The custom gateway is expected to accept
/// `{model, input, response_format}` and return raw audio bytes.
#[tauri::command]
pub async fn generate_music(
    prompt: String,
    model: String,
    format: String,
) -> Result<GeneratedMedia, String> {
    let cfg = config::load_music_config();
    validate_provider_config_basics(&cfg, "音乐")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("尚未选择音乐生成模型".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("音乐生成描述为空".to_string());
    }

    if cfg.provider.trim() == "custom" && cfg.base_url.trim().is_empty() {
        return Err("自定义音乐端点未填写 Base URL，请在 AI 设置的音乐 Tab 填写返回音频的接口地址".to_string());
    }

    let response_format = normalize_audio_format(&format);
    match cfg.provider.trim() {
        "openai" | "custom" | "siliconflow" => {
            generate_openai_compatible_music(&cfg, model, &prompt, response_format).await
        }
        other => Err(format!(
            "当前暂未适配 {other} 音乐生成接口，请在 AI 设置的音乐 Tab 选择「自定义」并将 Base URL 指向返回音频字节的音乐端点。"
        )),
    }
}

async fn generate_openai_compatible_music(
    cfg: &AiProviderConfig,
    model: &str,
    prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, "audio/music");
    // Send both `input` and `prompt` so the same body works across gateways that
    // name the field differently.
    let body = serde_json::json!({
        "model": model,
        "input": prompt,
        "prompt": prompt,
        "response_format": response_format
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化音乐生成请求失败: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建音乐生成客户端失败: {e}"))?;
    let mut request = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .body(body);
    if !cfg.api_key.trim().is_empty() {
        request = request.bearer_auth(cfg.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("音乐生成请求失败: {e}"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        log_provider_event("music_generate", cfg, model, &endpoint, false, &text);
        return Err(format!("音乐生成失败 ({status}): {text}"));
    }

    // Raw audio bytes (the recommended custom-gateway contract): use directly.
    let mime = content_type.split(';').next().unwrap_or("").trim();
    if mime.starts_with("audio/")
        || mime == "application/octet-stream"
        || mime.starts_with("binary/")
    {
        let ext = extension_from_mime(mime, response_format);
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("读取音乐生成响应失败: {e}"))?;
        log_provider_event("music_generate", cfg, model, &endpoint, true, "music generated");
        return Ok(GeneratedMedia {
            base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
            extension: ext,
        });
    }

    // Otherwise treat as JSON/text and extract base64 or a downloadable URL so
    // gateways that return JSON still produce a valid, playable file (instead of
    // silently saving the JSON body as a broken audio file).
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取音乐生成响应失败: {e}"))?;
    parse_music_json_response(cfg, model, &endpoint, &text, response_format).await
}

async fn parse_music_json_response(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    text: &str,
    fallback_ext: &str,
) -> Result<GeneratedMedia, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| {
        format!("解析音乐生成响应失败: {e}; 响应: {}", truncate_log_field(text))
    })?;
    if let Some(b64) = find_audio_base64(&value) {
        log_provider_event("music_generate", cfg, model, endpoint, true, "music generated (base64)");
        return Ok(GeneratedMedia {
            base64_data: strip_data_url_prefix(&b64).to_string(),
            extension: fallback_ext.to_string(),
        });
    }
    if let Some(url) = find_audio_url(&value) {
        return download_generated_media(cfg, model, endpoint, &url, fallback_ext, "music_generate").await;
    }
    log_provider_event("music_generate", cfg, model, endpoint, false, text);
    Err(format!(
        "音乐生成响应中未找到音频数据。请让自定义端点直接返回音频字节（Content-Type: audio/*），或返回含 data/audio/b64_json/url 字段的 JSON。响应: {}",
        truncate_log_field(text)
    ))
}

/// Locate base64-encoded audio in common custom-gateway JSON shapes.
fn find_audio_base64(v: &serde_json::Value) -> Option<String> {
    for key in ["b64_json", "audio_base64", "audioContent", "audio", "data"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if !s.starts_with("http") && s.len() > 64 {
                return Some(s.to_string());
            }
        }
    }
    if let Some(first) = v
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
    {
        for key in ["b64_json", "audio_base64", "audio"] {
            if let Some(s) = first.get(key).and_then(|x| x.as_str()) {
                if !s.starts_with("http") {
                    return Some(s.to_string());
                }
            }
        }
    }
    // DashScope-like multimodal shape.
    v.pointer("/output/audio/data")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// Locate a downloadable audio URL in common custom-gateway JSON shapes.
fn find_audio_url(v: &serde_json::Value) -> Option<String> {
    for key in ["url", "audio_url", "output_url"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if s.starts_with("http") {
                return Some(s.to_string());
            }
        }
    }
    if let Some(first) = v
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
    {
        for key in ["url", "audio_url"] {
            if let Some(s) = first.get(key).and_then(|x| x.as_str()) {
                if s.starts_with("http") {
                    return Some(s.to_string());
                }
            }
        }
    }
    v.pointer("/output/audio/url")
        .and_then(|x| x.as_str())
        .filter(|s| s.starts_with("http"))
        .map(|s| s.to_string())
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
#[tauri::command]
pub async fn ai_chat_turn(
    messages: Vec<AiMessageInput>,
    tools: Vec<ToolDef>,
    character_context: Option<String>,
) -> Result<AiTurnResult, String> {
    let cfg = config::load_config();
    validate_config_basics(&cfg)?;

    let mut chat_messages: Vec<ChatMessage> = Vec::new();
    if let Some(ctx) = character_context {
        if !ctx.trim().is_empty() {
            chat_messages.push(ChatMessage::system(format!(
                "## 当前项目的角色设定\n{ctx}"
            )));
        }
    }
    chat_messages.extend(to_chat_messages(messages));

    let mut request = ChatRequest::new(chat_messages);
    if !tools.is_empty() {
        let genai_tools: Vec<Tool> = tools
            .into_iter()
            .map(|t| Tool::new(t.name).with_description(t.description).with_schema(t.parameters))
            .collect();
        request = request.with_tools(genai_tools);
    }

    let client = build_client(&cfg);
    let endpoint = effective_endpoint(&cfg);

    match client.exec_chat(&cfg.model, request, None).await {
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
            let default_endpoint = default_chat_endpoint(provider.as_str());

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

/// Default API endpoint for a chat provider. `None` means there is no built-in
/// default (e.g. "custom", which requires an explicit base URL). Single source
/// of truth shared by `build_client` and `effective_endpoint` so they can't drift.
fn default_chat_endpoint(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1/"),
        "anthropic" => Some("https://api.anthropic.com/v1/"),
        "gemini" => Some("https://generativelanguage.googleapis.com/v1beta/"),
        "deepseek" => Some("https://api.deepseek.com/v1/"),
        "groq" => Some("https://api.groq.com/openai/v1/"),
        "xai" => Some("https://api.x.ai/v1/"),
        "ollama" => Some("http://localhost:11434/v1/"),
        "cohere" => Some("https://api.cohere.com/v2/"),
        _ => None,
    }
}

fn effective_endpoint(cfg: &AiConfig) -> String {
    if !cfg.base_url.trim().is_empty() {
        return cfg.base_url.trim().to_string();
    }
    default_chat_endpoint(cfg.provider.as_str()).unwrap_or("").to_string()
}

fn media_endpoint(cfg: &AiProviderConfig, path: &str) -> String {
    let configured_base = cfg.base_url.trim();
    let should_use_configured_base =
        !configured_base.is_empty() && !is_placeholder_base_url(configured_base);
    let base = if should_use_configured_base {
        cfg.base_url.trim().trim_end_matches('/').to_string()
    } else {
        match cfg.provider.as_str() {
            "openai" => "https://api.openai.com/v1".to_string(),
            "volcengine" => "https://ark.cn-beijing.volces.com/api/v3".to_string(),
            "zhipu" => "https://open.bigmodel.cn/api/paas/v4".to_string(),
            "siliconflow" => "https://api.siliconflow.cn/v1".to_string(),
            _ => String::new(),
        }
    };
    if base.is_empty() {
        path.to_string()
    } else if base.ends_with(path) {
        base
    } else {
        format!("{base}/{path}")
    }
}

fn is_placeholder_base_url(value: &str) -> bool {
    value.to_ascii_lowercase().contains("api.example.com")
}

/// Read a local image file into `(mime_type, base64_without_prefix)` for use as
/// an image-to-image reference. Used by providers that support a reference image.
fn read_image_as_base64(path: &str) -> Result<(String, String), String> {
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
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((mime.to_string(), b64))
}

async fn generate_openai_compatible_image(
    cfg: &AiProviderConfig,
    model: &str,
    prompt: &str,
    reference: Option<&(String, String)>,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, "images/generations");
    let body = if is_seedream_model(model) {
        let mut body = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "size": "2K",
            "response_format": "url",
            "stream": false,
            "watermark": false,
            "sequential_image_generation": "disabled"
        });
        // Seedream 4.x 支持图生图：image 字段传参考图。
        // 火山引擎官方文档要求 data:image/<格式>;base64,<编码> 形式的 data URI，格式名小写。
        if let Some((mime, b64)) = reference {
            body["image"] = serde_json::json!(format!("data:{mime};base64,{b64}"));
        }
        body
    } else {
        // 非 Seedream 的 OpenAI 兼容图片接口（DALL·E/gpt-image 协议不同）暂忽略参考图。
        serde_json::json!({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
        "response_format": "b64_json"
        })
    };
    let text = post_json_text(cfg, &endpoint, body, "图片生成").await?;
    parse_openai_image_response(cfg, model, &endpoint, &text).await
}

async fn generate_dashscope_image(
    app_handle: &AppHandle,
    cfg: &AiProviderConfig,
    model: &str,
    prompt: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = dashscope_endpoint(cfg, "services/aigc/text2image/image-synthesis");
    let body = serde_json::json!({
        "model": model,
        "input": {
            "prompt": prompt
        },
        "parameters": {
            "size": "1024*1024",
            "n": 1
        }
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化阿里云图片生成请求失败: {e}"))?;
    let client = http_client();
    let response = client
        .post(&endpoint)
        .bearer_auth(cfg.api_key.trim())
        .header("Content-Type", "application/json")
        .header("X-DashScope-Async", "enable")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("阿里云图片生成请求失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读取阿里云图片生成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("image_generate", cfg, model, &endpoint, false, &text);
        return Err(format!("阿里云图片生成失败 ({status}): {text}"));
    }
    let parsed: DashScopeTaskCreateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析阿里云图片任务响应失败: {e}; 响应: {text}"))?;
    let task_id = parsed
        .output
        .task_id
        .ok_or_else(|| format!("阿里云图片任务响应缺少 task_id: {text}"))?;
    let task_endpoint = dashscope_endpoint(cfg, &format!("tasks/{task_id}"));
    emit_media_generation_progress(
        app_handle,
        cfg,
        model,
        "submitted",
        0,
        36,
        "阿里云图片任务已提交，等待生成结果...",
    );
    for attempt in 1..=36 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        emit_media_generation_progress(
            app_handle,
            cfg,
            model,
            "polling",
            attempt,
            36,
            "正在查询阿里云图片生成状态...",
        );
        let poll = client
            .get(&task_endpoint)
            .bearer_auth(cfg.api_key.trim())
            .send()
            .await
            .map_err(|e| format!("查询阿里云图片任务失败: {e}"))?;
        let status = poll.status();
        let text = poll.text().await.map_err(|e| format!("读取阿里云图片任务响应失败: {e}"))?;
        if !status.is_success() {
            log_provider_event("image_generate", cfg, model, &task_endpoint, false, &text);
            return Err(format!("查询阿里云图片任务失败 ({status}): {text}"));
        }
        let parsed: DashScopeTaskCreateResponse = serde_json::from_str(&text)
            .map_err(|e| format!("解析阿里云图片任务状态失败: {e}; 响应: {text}"))?;
        match parsed.output.task_status.as_deref() {
            Some("SUCCEEDED") => {
                emit_media_generation_progress(
                    app_handle,
                    cfg,
                    model,
                    "succeeded",
                    attempt,
                    36,
                    "阿里云图片生成完成，正在下载结果...",
                );
                let url = parsed
                    .output
                    .results
                    .into_iter()
                    .find_map(|item| item.url)
                    .ok_or_else(|| format!("阿里云图片任务完成但缺少图片 URL: {text}"))?;
                return download_generated_media(cfg, model, &task_endpoint, &url, "png", "image_generate").await;
            }
            Some("FAILED") | Some("CANCELED") | Some("UNKNOWN") => {
                emit_media_generation_progress(
                    app_handle,
                    cfg,
                    model,
                    "failed",
                    attempt,
                    36,
                    "阿里云图片任务失败。",
                );
                log_provider_event("image_generate", cfg, model, &task_endpoint, false, &text);
                return Err(format!("阿里云图片任务失败: {text}"));
            }
            _ => {}
        }
    }
    emit_media_generation_progress(
        app_handle,
        cfg,
        model,
        "timeout",
        36,
        36,
        "阿里云图片任务超时。",
    );
    Err("阿里云图片任务超时，请稍后查看任务或重试。".to_string())
}

fn emit_media_generation_progress(
    app_handle: &AppHandle,
    cfg: &AiProviderConfig,
    model: &str,
    phase: &str,
    attempt: u8,
    total_attempts: u8,
    message: &str,
) {
    let _ = app_handle.emit(
        "ai-media-generation-progress",
        AiMediaGenerationProgress {
            provider: cfg.provider.clone(),
            model: model.to_string(),
            phase: phase.to_string(),
            attempt,
            total_attempts,
            message: message.to_string(),
        },
    );
}

async fn generate_gemini_image(
    cfg: &AiProviderConfig,
    model: &str,
    prompt: &str,
    reference: Option<&(String, String)>,
) -> Result<GeneratedMedia, String> {
    let endpoint = gemini_endpoint(cfg, model, "generateContent");
    // 有参考图时走图生图：parts 追加 inline_data。
    let parts = match reference {
        Some((mime, b64)) => serde_json::json!([
            { "inline_data": { "mime_type": mime, "data": b64 } },
            { "text": prompt }
        ]),
        None => serde_json::json!([{ "text": prompt }]),
    };
    let body = serde_json::json!({
        "contents": [{
            "parts": parts
        }]
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化 Gemini 图片生成请求失败: {e}"))?;
    let response = http_client()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", cfg.api_key.trim())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Gemini 图片生成请求失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读取 Gemini 图片生成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("image_generate", cfg, model, &endpoint, false, &text);
        return Err(format!("Gemini 图片生成失败 ({status}): {text}"));
    }
    let parsed: GeminiGenerateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Gemini 图片生成响应失败: {e}; 响应: {text}"))?;
    for candidate in parsed.candidates {
        if let Some(content) = candidate.content {
            for part in content.parts {
                if let Some(inline) = part.inline_data {
                    let extension = extension_from_mime(&inline.mime_type, "png");
                    log_provider_event("image_generate", cfg, model, &endpoint, true, "image generated");
                    return Ok(GeneratedMedia {
                        base64_data: inline.data,
                        extension,
                    });
                }
            }
        }
    }
    Err("Gemini 图片生成响应中没有 inline image 数据".to_string())
}

async fn generate_sd_webui_image(
    cfg: &AiProviderConfig,
    prompt: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, "sdapi/v1/txt2img");
    let body = serde_json::json!({
        "prompt": prompt,
        "steps": 28,
        "width": 1024,
        "height": 1024,
        "batch_size": 1,
        "n_iter": 1
    });
    let text = post_json_text(cfg, &endpoint, body, "Stable Diffusion WebUI 图片生成").await?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Stable Diffusion WebUI 响应失败: {e}; 响应: {text}"))?;
    let b64 = parsed
        .get("images")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Stable Diffusion WebUI 响应中没有 images[0]: {text}"))?;
    log_provider_event("image_generate", cfg, cfg.model.trim(), &endpoint, true, "image generated");
    Ok(GeneratedMedia {
        base64_data: strip_data_url_prefix(b64).to_string(),
        extension: "png".to_string(),
    })
}

async fn generate_openai_compatible_tts(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, "audio/speech");
    let voice = openai_voice_from_prompt(voice_prompt);
    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": response_format
    });
    post_audio_bytes(cfg, model, &endpoint, body, response_format, "tts_generate").await
}

async fn generate_elevenlabs_tts(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    let voice_id = elevenlabs_voice_id(voice_prompt);
    let endpoint = if !cfg.base_url.trim().is_empty() {
        let base = cfg.base_url.trim().trim_end_matches('/');
        if base.contains("/text-to-speech/") {
            base.to_string()
        } else {
            format!("{base}/v1/text-to-speech/{voice_id}")
        }
    } else {
        format!("https://api.elevenlabs.io/v1/text-to-speech/{voice_id}")
    };
    let output_format = match response_format {
        "mp3" => "mp3_44100_128",
        "pcm" => "pcm_44100",
        "wav" => "pcm_44100",
        _ => "mp3_44100_128",
    };
    let body = serde_json::json!({
        "text": text,
        "model_id": model,
        "output_format": output_format
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化 ElevenLabs 请求失败: {e}"))?;
    let response = http_client()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("xi-api-key", cfg.api_key.trim())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs 音频生成请求失败: {e}"))?;
    response_to_generated_media(response, cfg, model, &endpoint, response_format, "tts_generate").await
}

async fn generate_dashscope_tts(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    // Qwen-TTS 非实时 HTTP 接口：POST .../multimodal-generation/generation。
    // 请求体为 {model, input:{text, voice}}，不接受 format/sample_rate 字段；
    // 非流式响应音频在 output.audio.url（wav，24h 有效），需再下载。
    // 流式（X-DashScope-SE）才会返回 output.audio.data 的 Base64 PCM，这里走非流式。
    // CosyVoice 走 WebSocket 协议（与本 HTTP 端点不同），单独走流式合成实现。
    // Sambert 系列同样不走本 HTTP 端点，且协议更老，暂不支持。
    let lower_model = model.to_ascii_lowercase();
    if lower_model.starts_with("cosyvoice") {
        return generate_dashscope_cosyvoice_ws(cfg, model, text, voice_prompt, response_format).await;
    }
    if lower_model.starts_with("sambert") {
        return Err(format!(
            "暂不支持 {model}（Sambert 系列需独立协议）。请改用 CosyVoice（如 cosyvoice-v2）或 Qwen-TTS（如 qwen3-tts-flash）。"
        ));
    }
    let endpoint = dashscope_endpoint(cfg, "services/aigc/multimodal-generation/generation");
    // Qwen-TTS 音色名（如 Cherry/Ethan）直接透传 voice_prompt，空时给默认音色。
    let voice = {
        let trimmed = voice_prompt.trim();
        if trimmed.is_empty() { "Cherry" } else { trimmed }
    };
    let body = serde_json::json!({
        "model": model,
        "input": {
            "text": text,
            "voice": voice
        }
    });
    let response_text = post_json_text(cfg, &endpoint, body, "阿里云语音合成").await?;
    let parsed: DashScopeTtsResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("解析阿里云语音合成响应失败: {e}; 响应: {response_text}"))?;
    let audio = parsed
        .output
        .and_then(|o| o.audio)
        .ok_or_else(|| format!("阿里云语音合成响应缺少 audio 字段: {response_text}"))?;
    if let Some(url) = audio.url.filter(|u| !u.is_empty()) {
        // Qwen-TTS 非流式返回 wav 文件 url，扩展名以 wav 为准（忽略用户所选格式）。
        return download_generated_media(cfg, model, &endpoint, &url, "wav", "tts_generate").await;
    }
    if let Some(data) = audio.data.filter(|d| !d.is_empty()) {
        log_provider_event("tts_generate", cfg, model, &endpoint, true, "audio generated");
        return Ok(GeneratedMedia {
            base64_data: strip_data_url_prefix(&data).to_string(),
            extension: response_format.to_string(),
        });
    }
    Err(format!("阿里云语音合成响应既无 url 也无 data: {response_text}"))
}

/// 生成 32 位 hex 的简易唯一 task_id（避免引入 uuid 依赖）。
/// 仅需在单次合成的 run/continue/finish 三个事件间保持一致且全局唯一即可。
fn simple_task_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    // 拼成 32 个 hex 字符：nanos(16) + seq(16)。
    format!("{nanos:016x}{seq:016x}")
}

/// 将用户填写的音色名自动对齐到模型版本要求：
/// - cosyvoice-v1：去掉 _v2 后缀
/// - cosyvoice-v2 及更新版本：补上 _v2 后缀（仅限纯字母/数字/下划线的标准音色名，
///   自定义克隆音色 ID 通常含连字符，原样透传）
fn normalize_cosyvoice_voice(voice: &str, lower_model: &str) -> String {
    let is_v1 = lower_model.starts_with("cosyvoice-v1");
    if is_v1 {
        voice.trim_end_matches("_v2").to_string()
    } else if !voice.ends_with("_v2")
        && voice.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        format!("{}_v2", voice)
    } else {
        voice.to_string()
    }
}

/// 阿里云 CosyVoice WebSocket 流式语音合成。
/// 流程：连接 → run-task → 等 task-started → continue-task(文本) → finish-task →
/// 持续接收（文本事件标识 + 二进制音频帧）→ task-finished 结束 → 拼接音频帧。
/// 音频通过 WebSocket binary 通道返回（非 base64），按事件顺序拼接即为完整音频。
async fn generate_dashscope_cosyvoice_ws(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err("阿里云 CosyVoice 需要填写 API Key".to_string());
    }
    let lower_model = model.to_ascii_lowercase();
    // CosyVoice 仅支持 WebSocket，地址固定；base_url 非 wss 时不复用，避免误用 HTTP 端点。
    let ws_url = {
        let configured = cfg.base_url.trim();
        if configured.starts_with("wss://") || configured.starts_with("ws://") {
            configured.trim_end_matches('/').to_string()
        } else {
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference".to_string()
        }
    };
    // 音色名与模型版本强相关：cosyvoice-v1 用无后缀音色（如 longxiaochun），
    // cosyvoice-v2 及以上用带 _v2 后缀的音色（如 longxiaochun_v2），混用会被引擎拒绝（418）。
    // 未填时给匹配的默认音色；填了则按模型版本自动纠正后缀，避免用户选错版本导致 418。
    let voice = {
        let trimmed = voice_prompt.trim();
        if trimmed.is_empty() {
            if lower_model.starts_with("cosyvoice-v1") {
                "longxiaochun".to_string()
            } else {
                "longxiaochun_v2".to_string()
            }
        } else {
            normalize_cosyvoice_voice(trimmed, &lower_model)
        }
    };
    // CosyVoice 支持 pcm/wav/mp3；wav 便于直接播放，作为默认。
    let format = match response_format {
        "mp3" => "mp3",
        "wav" => "wav",
        "pcm" => "pcm",
        _ => "wav",
    };
    let task_id = simple_task_id();

    let log_url = ws_url.clone();
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("构造 CosyVoice WebSocket 请求失败: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {api_key}")
            .parse()
            .map_err(|e| format!("设置 CosyVoice 鉴权头失败: {e}"))?,
    );

    let connect = tokio::time::timeout(
        Duration::from_secs(30),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "连接 CosyVoice WebSocket 超时".to_string())?;
    let (ws_stream, _resp) = connect.map_err(|e| {
        let message = format!("连接 CosyVoice WebSocket 失败: {e}");
        log_provider_event("tts_generate", cfg, model, &log_url, false, &message);
        message
    })?;
    let (mut write, mut read) = ws_stream.split();

    // 1) run-task：开启合成任务。
    let run_task = serde_json::json!({
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "model": model,
            "parameters": {
                "text_type": "PlainText",
                "voice": voice,
                "format": format,
                "sample_rate": 24000
            },
            "input": {}
        }
    });
    write
        .send(Message::Text(run_task.to_string()))
        .await
        .map_err(|e| format!("发送 CosyVoice run-task 失败: {e}"))?;

    // 等待 task-started。
    let mut started = false;
    let mut audio_bytes: Vec<u8> = Vec::new();
    while !started {
        let item = tokio::time::timeout(Duration::from_secs(30), read.next())
            .await
            .map_err(|_| "等待 CosyVoice task-started 超时".to_string())?;
        match item {
            Some(Ok(Message::Text(text))) => {
                let event: CosyVoiceEvent = serde_json::from_str(&text)
                    .map_err(|e| format!("解析 CosyVoice 事件失败: {e}; 事件: {text}"))?;
                match event.header.event.as_str() {
                    "task-started" => started = true,
                    "task-failed" => {
                        let msg = event.header.error_message.unwrap_or_default();
                        let hint = if msg.contains("418") {
                            "（可能原因：音色 ID 与模型版本不匹配，或音色不存在。v2/v3 模型请用带 _v2 后缀的音色）"
                        } else {
                            ""
                        };
                        let full = format!("CosyVoice 任务失败: {msg}{hint}");
                        log_provider_event("tts_generate", cfg, model, &log_url, false, &full);
                        return Err(full);
                    }
                    _ => {} // 忽略其他事件，继续等 task-started
                }
            }
            Some(Ok(Message::Binary(bytes))) => audio_bytes.extend_from_slice(&bytes),
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(format!("CosyVoice WebSocket 接收错误: {e}")),
            None => return Err("CosyVoice WebSocket 在 task-started 前已关闭".to_string()),
        }
    }

    // 2) continue-task：发送待合成文本。
    let continue_task = serde_json::json!({
        "header": {
            "action": "continue-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": { "input": { "text": text } }
    });
    write
        .send(Message::Text(continue_task.to_string()))
        .await
        .map_err(|e| format!("发送 CosyVoice continue-task 失败: {e}"))?;

    // 3) finish-task：通知文本已发送完毕，触发剩余合成。
    let finish_task = serde_json::json!({
        "header": {
            "action": "finish-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": { "input": {} }
    });
    write
        .send(Message::Text(finish_task.to_string()))
        .await
        .map_err(|e| format!("发送 CosyVoice finish-task 失败: {e}"))?;

    // 4) 持续接收音频二进制帧，直到 task-finished / task-failed / 连接关闭。
    loop {
        let item = tokio::time::timeout(Duration::from_secs(60), read.next())
            .await
            .map_err(|_| "接收 CosyVoice 音频超时".to_string())?;
        match item {
            Some(Ok(Message::Binary(bytes))) => audio_bytes.extend_from_slice(&bytes),
            Some(Ok(Message::Text(text))) => {
                let event: CosyVoiceEvent = serde_json::from_str(&text)
                    .map_err(|e| format!("解析 CosyVoice 事件失败: {e}; 事件: {text}"))?;
                match event.header.event.as_str() {
                    "task-finished" => break,
                    "task-failed" => {
                        let msg = event.header.error_message.unwrap_or_default();
                        let hint = if msg.contains("418") {
                            "（可能原因：音色 ID 与模型版本不匹配，或音色不存在。v2/v3 模型请用带 _v2 后缀的音色）"
                        } else {
                            ""
                        };
                        let full = format!("CosyVoice 任务失败: {msg}{hint}");
                        log_provider_event("tts_generate", cfg, model, &log_url, false, &full);
                        return Err(full);
                    }
                    _ => {} // result-generated 等仅作标识，音频走 binary 通道
                }
            }
            Some(Ok(Message::Close(_))) => break,
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(format!("CosyVoice WebSocket 接收错误: {e}")),
            None => break,
        }
    }

    let _ = write.send(Message::Close(None)).await;

    if audio_bytes.is_empty() {
        let message = "CosyVoice 合成完成但未收到任何音频数据".to_string();
        log_provider_event("tts_generate", cfg, model, &log_url, false, &message);
        return Err(message);
    }
    log_provider_event("tts_generate", cfg, model, &log_url, true, "audio generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(&audio_bytes),
        extension: format.to_string(),
    })
}

/// 火山引擎 HTTP 单向流式语音合成（POST .../api/v3/tts/unidirectional）。
/// 鉴权用 X-Api-Key + X-Api-Resource-Id；响应是按行分隔的多段 JSON，
/// 每段 data 为一段 Base64 音频，需逐段解码拼接为完整音频后再整体编码。
async fn generate_volcengine_tts(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = if cfg.base_url.trim().is_empty() {
        "https://openspeech.bytedance.com/api/v3/tts/unidirectional".to_string()
    } else {
        cfg.base_url.trim().trim_end_matches('/').to_string()
    };
    // X-Api-Resource-Id 用模型字段承载（如 seed-tts-2.0）；speaker 用音色提示原文。
    let resource_id = if model.is_empty() { "seed-tts-2.0" } else { model };
    let speaker = {
        let trimmed = voice_prompt.trim();
        if trimmed.is_empty() {
            "zh_female_vv_uranus_bigtts"
        } else {
            trimmed
        }
    };
    // 火山采样率取常见值；wav/pcm/mp3 均支持，统一用 24000。
    let body = serde_json::json!({
        "req_params": {
            "text": text,
            "speaker": speaker,
            "audio_params": {
                "format": response_format,
                "sample_rate": 24000
            }
        }
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化火山语音合成请求失败: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建火山语音合成HTTP客户端失败: {e}"))?;
    let response = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("X-Api-Key", cfg.api_key.trim())
        .header("X-Api-Resource-Id", resource_id)
        .header("Connection", "keep-alive")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            let message = format!("火山语音合成请求失败: {e}");
            log_provider_event("tts_generate", cfg, model, &endpoint, false, &message);
            message
        })?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("读取火山语音合成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("tts_generate", cfg, model, &endpoint, false, &response_text);
        return Err(format!("火山语音合成失败 ({status}): {response_text}"));
    }
    // 流式响应：按行分隔的多个 JSON 块，逐行解析并拼接 data 的解码字节。
    let mut audio_bytes: Vec<u8> = Vec::new();
    let mut last_error: Option<String> = None;
    for line in response_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let chunk: VolcengineTtsChunk = match serde_json::from_str(line) {
            Ok(chunk) => chunk,
            Err(_) => continue, // 跳过非 JSON 行（如保活空行）
        };
        if chunk.code != 0 {
            last_error = Some(format!(
                "火山语音合成返回错误码 {}: {}",
                chunk.code,
                chunk.message.unwrap_or_default()
            ));
            continue;
        }
        if let Some(data) = chunk.data.filter(|d| !d.is_empty()) {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(strip_data_url_prefix(&data))
                .map_err(|e| format!("解码火山语音合成音频块失败: {e}"))?;
            audio_bytes.extend_from_slice(&decoded);
        }
    }
    if audio_bytes.is_empty() {
        if let Some(err) = last_error {
            log_provider_event("tts_generate", cfg, model, &endpoint, false, &err);
            return Err(err);
        }
        return Err(format!("火山语音合成响应中没有音频数据: {response_text}"));
    }
    log_provider_event("tts_generate", cfg, model, &endpoint, true, "audio generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(&audio_bytes),
        extension: response_format.to_string(),
    })
}

async fn post_json_text(
    cfg: &AiProviderConfig,
    endpoint: &str,
    body: serde_json::Value,
    action_label: &str,
) -> Result<String, String> {
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化{action_label}请求失败: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建{action_label}HTTP客户端失败: {e}"))?;
    let mut request = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .body(body);
    if !cfg.api_key.trim().is_empty() {
        request = request.bearer_auth(cfg.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| {
            let message = format!("{action_label}请求失败: {e}");
            log_provider_event("media_generate", cfg, cfg.model.trim(), endpoint, false, &message);
            message
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取{action_label}响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("media_generate", cfg, cfg.model.trim(), endpoint, false, &text);
        return Err(format!("{action_label}失败 ({status}): {text}"));
    }
    Ok(text)
}

async fn post_audio_bytes(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    body: serde_json::Value,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化音频生成请求失败: {e}"))?;
    let mut request = http_client()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .body(body);
    if !cfg.api_key.trim().is_empty() {
        request = request.bearer_auth(cfg.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("音频生成请求失败: {e}"))?;
    response_to_generated_media(response, cfg, model, endpoint, extension, action).await
}

async fn response_to_generated_media(
    response: reqwest::Response,
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        log_provider_event(action, cfg, model, endpoint, false, &text);
        return Err(format!("音频生成失败 ({status}): {text}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取音频生成响应失败: {e}"))?;
    log_provider_event(action, cfg, model, endpoint, true, "audio generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
        extension: extension.to_string(),
    })
}

async fn parse_openai_image_response(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    text: &str,
) -> Result<GeneratedMedia, String> {
    let parsed: OpenAiImageResponse = serde_json::from_str(text)
        .map_err(|e| format!("解析图片生成响应失败: {e}; 响应: {text}"))?;
    let item = parsed
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "图片生成响应中没有图片数据".to_string())?;
    if let Some(b64) = item.b64_json {
        log_provider_event("image_generate", cfg, model, endpoint, true, "image generated");
        return Ok(GeneratedMedia {
            base64_data: strip_data_url_prefix(&b64).to_string(),
            extension: "png".to_string(),
        });
    }
    if let Some(url) = item.url {
        return download_generated_media(cfg, model, endpoint, &url, "png", "image_generate").await;
    }
    Err("图片生成响应中没有 b64_json 或 url".to_string())
}

async fn download_generated_media(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    url: &str,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载生成媒体失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("读取生成媒体失败: {e}"))?;
    log_provider_event(action, cfg, model, endpoint, true, "media generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
        extension: extension.to_string(),
    })
}

fn dashscope_endpoint(cfg: &AiProviderConfig, path: &str) -> String {
    let base = if cfg.base_url.trim().is_empty() {
        "https://dashscope.aliyuncs.com/api/v1".to_string()
    } else {
        cfg.base_url.trim().trim_end_matches('/').to_string()
    };
    if base.ends_with(path) {
        base
    } else {
        format!("{base}/{path}")
    }
}

fn gemini_endpoint(_cfg: &AiProviderConfig, model: &str, action: &str) -> String {
    let base = if _cfg.base_url.trim().is_empty() {
        "https://generativelanguage.googleapis.com/v1beta".to_string()
    } else {
        _cfg.base_url.trim().trim_end_matches('/').to_string()
    };
    format!("{base}/models/{model}:{action}")
}

fn strip_data_url_prefix(value: &str) -> &str {
    value.split_once(',').map(|(_, data)| data).unwrap_or(value)
}

fn extension_from_mime(mime_type: &str, fallback: &str) -> String {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        _ => fallback,
    }
    .to_string()
}

fn is_seedream_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("seedream")
}

fn validate_provider_config_basics(cfg: &AiProviderConfig, capability: &str) -> Result<(), String> {
    if cfg.provider.trim().is_empty() {
        return Err(format!("尚未选择{capability} AI 供应商"));
    }
    if cfg.model.trim().is_empty() {
        return Err(format!("尚未配置{capability}模型"));
    }
    if cfg.provider == "custom" && is_placeholder_base_url(&cfg.base_url) {
        return Err(format!("自定义{capability} Base URL 仍是示例地址，请填写真实接口地址"));
    }
    if cfg.api_key.trim().is_empty()
        && cfg.provider != "sd-webui"
        && cfg.provider != "comfyui"
        && cfg.provider != "edge-tts"
    {
        return Err(format!("尚未配置{capability} API Key"));
    }
    Ok(())
}

fn normalize_audio_format(value: &str) -> &'static str {
    match value.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "opus" => "opus",
        "aac" => "aac",
        "flac" => "flac",
        "wav" => "wav",
        "pcm" => "pcm",
        _ => "mp3",
    }
}

fn openai_voice_from_prompt(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    for voice in ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] {
        if lower.contains(voice) {
            return voice.to_string();
        }
    }
    "alloy".to_string()
}

fn elevenlabs_voice_id(value: &str) -> String {
    for token in value.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '，' || c == '；') {
        let token = token.trim();
        if token.len() >= 16 && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return token.to_string();
        }
    }
    "21m00Tcm4TlvDq8ikWAM".to_string()
}

fn log_provider_event(
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

fn truncate_log_field(value: &str) -> String {
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
    let truncated = chars.by_ref().take(MAX_TRACE_FIELD_CHARS).collect::<String>();
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
    let response_format = normalize_audio_format(&format);

    // Resolve a friendly filename stem for each card from its `target_stem`
    // (e.g. "vo_角色_场景_3"), so generated audio is easy for users to locate
    // instead of the opaque "vo_batch_<id>" naming.
    let stem_map: std::collections::HashMap<String, String> =
        crate::assets::commands::read_asset_metadata(&project_path)
            .map(|meta| {
                meta.voice_cards
                    .into_iter()
                    .filter(|(_, c)| !c.target_stem.trim().is_empty())
                    .map(|(id, c)| (id, c.target_stem))
                    .collect()
            })
            .unwrap_or_default();

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

        let gen_result = match cfg.provider.trim() {
            "openai" | "custom" => {
                generate_openai_compatible_tts(
                    &cfg, model, &item.text, &item.voice_prompt, response_format,
                ).await
            }
            "elevenlabs" => {
                generate_elevenlabs_tts(
                    &cfg, model, &item.text, &item.voice_prompt, response_format,
                ).await
            }
            "aliyun" => {
                generate_dashscope_tts(
                    &cfg, model, &item.text, &item.voice_prompt, response_format,
                ).await
            }
            other => Err(format!("批量生成暂不支持 {other}，请使用 Amazon 兼容或已适配供应商。")),
        };

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
                if let Ok(mut asset_meta) =
                    crate::assets::commands::read_asset_metadata(&project_path)
                {
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
                        let _ = crate::assets::commands::write_asset_metadata(
                            &project_path,
                            &asset_meta,
                        );
                    }
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
mod tests {
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
}
