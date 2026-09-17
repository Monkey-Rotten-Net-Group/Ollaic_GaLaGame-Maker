//! Alibaba Cloud DashScope adaptor.
//!
//! Three different protocols live behind one provider id:
//! - **Image** is an async task API: submit, then poll `tasks/{id}` until it
//!   succeeds, then download the result URL.
//! - **Qwen-TTS** is a normal HTTP call whose audio arrives as a URL (or, in
//!   streaming mode, base64).
//! - **CosyVoice** is WebSocket-only, with audio on the binary channel and
//!   task state on the text channel.

use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::ai::commands::{download_generated_media, log_provider_event};
use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{
    encode_base64, http_client, media_endpoint, post_json_text, resolved_base_url,
};
use crate::ai::gateway::types::{
    strip_data_url_prefix, GeneratedMedia, ImageRequest, TtsRequest,
};
use crate::ai::gateway::{emit_media_generation_progress, MediaCtx};
use crate::ai::registry::Modality;

/// The async image task is polled every 2s; 36 attempts bounds a generation
/// at roughly 72 seconds before we report a timeout.
const IMAGE_POLL_ATTEMPTS: u8 = 36;
const IMAGE_POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
struct TaskCreateResponse {
    output: TaskOutput,
}

#[derive(Debug, Deserialize)]
struct TaskOutput {
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    task_status: Option<String>,
    #[serde(default)]
    results: Vec<ImageResult>,
}

#[derive(Debug, Deserialize)]
struct ImageResult {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TtsResponse {
    #[serde(default)]
    output: Option<TtsOutput>,
}

#[derive(Debug, Deserialize)]
struct TtsOutput {
    #[serde(default)]
    audio: Option<TtsAudio>,
}

#[derive(Debug, Deserialize)]
struct TtsAudio {
    /// Base64 audio, present only for streaming synthesis.
    #[serde(default)]
    data: Option<String>,
    /// Audio file URL for non-streaming synthesis (valid 24 hours).
    #[serde(default)]
    url: Option<String>,
}

/// CosyVoice server-side text event. Audio does not travel in the JSON — it
/// arrives as separate binary frames — so only the header is parsed, to track
/// task state (task-started / result-generated / task-finished / task-failed).
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

pub async fn generate_image(
    ctx: &MediaCtx<'_>,
    request: &ImageRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let cfg = ctx.cfg;
    let endpoint = media_endpoint(
        cfg,
        Modality::Image,
        "services/aigc/text2image/image-synthesis",
    );
    let body = serde_json::json!({
        "model": request.model,
        "input": { "prompt": request.prompt },
        "parameters": { "size": "1024*1024", "n": 1 }
    });
    let body =
        serde_json::to_string(&body).map_err(|e| format!("序列化阿里云图片生成请求失败: {e}"))?;
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
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取阿里云图片生成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("image_generate", cfg, request.model, &endpoint, false, &text);
        return Err(format!("阿里云图片生成失败 ({status}): {text}"));
    }
    let parsed: TaskCreateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析阿里云图片任务响应失败: {e}; 响应: {text}"))?;
    let task_id = parsed
        .output
        .task_id
        .ok_or_else(|| format!("阿里云图片任务响应缺少 task_id: {text}"))?;
    let task_endpoint = media_endpoint(cfg, Modality::Image, &format!("tasks/{task_id}"));

    emit_media_generation_progress(
        ctx,
        request.model,
        "submitted",
        0,
        IMAGE_POLL_ATTEMPTS,
        "阿里云图片任务已提交，等待生成结果...",
    );
    for attempt in 1..=IMAGE_POLL_ATTEMPTS {
        tokio::time::sleep(IMAGE_POLL_INTERVAL).await;
        emit_media_generation_progress(
            ctx,
            request.model,
            "polling",
            attempt,
            IMAGE_POLL_ATTEMPTS,
            "正在查询阿里云图片生成状态...",
        );
        let poll = client
            .get(&task_endpoint)
            .bearer_auth(cfg.api_key.trim())
            .send()
            .await
            .map_err(|e| format!("查询阿里云图片任务失败: {e}"))?;
        let status = poll.status();
        let text = poll
            .text()
            .await
            .map_err(|e| format!("读取阿里云图片任务响应失败: {e}"))?;
        if !status.is_success() {
            log_provider_event(
                "image_generate",
                cfg,
                request.model,
                &task_endpoint,
                false,
                &text,
            );
            return Err(format!("查询阿里云图片任务失败 ({status}): {text}"));
        }
        let parsed: TaskCreateResponse = serde_json::from_str(&text)
            .map_err(|e| format!("解析阿里云图片任务状态失败: {e}; 响应: {text}"))?;
        match parsed.output.task_status.as_deref() {
            Some("SUCCEEDED") => {
                emit_media_generation_progress(
                    ctx,
                    request.model,
                    "succeeded",
                    attempt,
                    IMAGE_POLL_ATTEMPTS,
                    "阿里云图片生成完成，正在下载结果...",
                );
                let url = parsed
                    .output
                    .results
                    .into_iter()
                    .find_map(|item| item.url)
                    .ok_or_else(|| format!("阿里云图片任务完成但缺少图片 URL: {text}"))?;
                return download_generated_media(
                    cfg,
                    request.model,
                    &task_endpoint,
                    &url,
                    "png",
                    "image_generate",
                )
                .await;
            }
            Some("FAILED") | Some("CANCELED") | Some("UNKNOWN") => {
                emit_media_generation_progress(
                    ctx,
                    request.model,
                    "failed",
                    attempt,
                    IMAGE_POLL_ATTEMPTS,
                    "阿里云图片任务失败。",
                );
                log_provider_event(
                    "image_generate",
                    cfg,
                    request.model,
                    &task_endpoint,
                    false,
                    &text,
                );
                return Err(format!("阿里云图片任务失败: {text}"));
            }
            _ => {}
        }
    }
    emit_media_generation_progress(
        ctx,
        request.model,
        "timeout",
        IMAGE_POLL_ATTEMPTS,
        IMAGE_POLL_ATTEMPTS,
        "阿里云图片任务超时。",
    );
    Err("阿里云图片任务超时，请稍后查看任务或重试。".to_string())
}

pub async fn generate_tts(
    cfg: &AiProviderConfig,
    request: &TtsRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let lower_model = request.model.to_ascii_lowercase();
    if lower_model.starts_with("cosyvoice") {
        return generate_cosyvoice_ws(cfg, request).await;
    }
    if lower_model.starts_with("sambert") {
        return Err(format!(
            "暂不支持 {}（Sambert 系列需独立协议）。请改用 CosyVoice（如 cosyvoice-v2）或 Qwen-TTS（如 qwen3-tts-flash）。",
            request.model
        ));
    }
    // Qwen-TTS non-realtime HTTP endpoint. The body is `{model, input:{text,
    // voice}}` — it rejects format/sample_rate fields — and non-streaming
    // responses put the audio at output.audio.url (wav, 24h validity), which
    // then has to be downloaded. Only streaming (X-DashScope-SE) returns
    // output.audio.data as base64 PCM; this path is non-streaming.
    let endpoint = media_endpoint(
        cfg,
        Modality::Tts,
        "services/aigc/multimodal-generation/generation",
    );
    // Qwen-TTS voice names (Cherry/Ethan/…) pass through verbatim.
    let voice = {
        let trimmed = request.voice_prompt.trim();
        if trimmed.is_empty() {
            "Cherry"
        } else {
            trimmed
        }
    };
    let body = serde_json::json!({
        "model": request.model,
        "input": { "text": request.text, "voice": voice }
    });
    let response_text = post_json_text(cfg, &endpoint, body, "阿里云语音合成").await?;
    let parsed: TtsResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("解析阿里云语音合成响应失败: {e}; 响应: {response_text}"))?;
    let audio = parsed
        .output
        .and_then(|o| o.audio)
        .ok_or_else(|| format!("阿里云语音合成响应缺少 audio 字段: {response_text}"))?;
    if let Some(url) = audio.url.filter(|u| !u.is_empty()) {
        // Qwen-TTS hands back a wav file URL, so the extension follows the
        // actual bytes rather than the requested format.
        return download_generated_media(
            cfg,
            request.model,
            &endpoint,
            &url,
            "wav",
            "tts_generate",
        )
        .await;
    }
    if let Some(data) = audio.data.filter(|d| !d.is_empty()) {
        log_provider_event(
            "tts_generate",
            cfg,
            request.model,
            &endpoint,
            true,
            "audio generated",
        );
        return Ok(GeneratedMedia {
            base64_data: strip_data_url_prefix(&data).to_string(),
            extension: request.format.to_string(),
        });
    }
    Err(format!(
        "阿里云语音合成响应既无 url 也无 data: {response_text}"
    ))
}

/// A 32-hex-character task id, unique per synthesis. Only has to stay
/// consistent across this call's run/continue/finish events, so it avoids
/// pulling in a uuid dependency.
fn simple_task_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:016x}{seq:016x}")
}

/// Align a voice name with the model version: cosyvoice-v1 takes bare names,
/// v2 and newer take a `_v2` suffix. Mixing them is rejected by the engine
/// with a 418, so correct it rather than letting the user hit that.
/// Custom cloned voice ids usually contain hyphens and pass through untouched.
pub fn normalize_cosyvoice_voice(voice: &str, lower_model: &str) -> String {
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

/// CosyVoice WebSocket streaming synthesis.
/// Flow: connect → run-task → await task-started → continue-task(text) →
/// finish-task → receive (text events for state, binary frames for audio) →
/// task-finished → concatenate the audio frames.
async fn generate_cosyvoice_ws(
    cfg: &AiProviderConfig,
    request: &TtsRequest<'_>,
) -> Result<GeneratedMedia, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err("阿里云 CosyVoice 需要填写 API Key".to_string());
    }
    let lower_model = request.model.to_ascii_lowercase();
    // CosyVoice is WebSocket-only at a fixed address. A configured Base URL is
    // reused only when it is itself a ws(s) URL, so the HTTP endpoint saved for
    // Qwen-TTS cannot be dialled by mistake.
    let ws_url = {
        let configured = resolved_base_url(&cfg.provider, Modality::Tts, &cfg.base_url);
        let configured = configured.trim();
        if configured.starts_with("wss://") || configured.starts_with("ws://") {
            configured.trim_end_matches('/').to_string()
        } else {
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference".to_string()
        }
    };
    let voice = {
        let trimmed = request.voice_prompt.trim();
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
    // CosyVoice supports pcm/wav/mp3; wav plays back directly, so it is the
    // default for anything else.
    let format = match request.format {
        "mp3" => "mp3",
        "wav" => "wav",
        "pcm" => "pcm",
        _ => "wav",
    };
    let task_id = simple_task_id();

    let log_url = ws_url.clone();
    let mut ws_request = ws_url
        .into_client_request()
        .map_err(|e| format!("构造 CosyVoice WebSocket 请求失败: {e}"))?;
    ws_request.headers_mut().insert(
        "Authorization",
        format!("Bearer {api_key}")
            .parse()
            .map_err(|e| format!("设置 CosyVoice 鉴权头失败: {e}"))?,
    );

    let connect = tokio::time::timeout(
        Duration::from_secs(30),
        tokio_tungstenite::connect_async(ws_request),
    )
    .await
    .map_err(|_| "连接 CosyVoice WebSocket 超时".to_string())?;
    let (ws_stream, _resp) = connect.map_err(|e| {
        let message = format!("连接 CosyVoice WebSocket 失败: {e}");
        log_provider_event("tts_generate", cfg, request.model, &log_url, false, &message);
        message
    })?;
    let (mut write, mut read) = ws_stream.split();

    // 1) run-task: open the synthesis task.
    let run_task = serde_json::json!({
        "header": { "action": "run-task", "task_id": task_id, "streaming": "duplex" },
        "payload": {
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "model": request.model,
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
                        return Err(cosyvoice_failure(cfg, request.model, &log_url, event))
                    }
                    _ => {} // ignore other events while waiting for task-started
                }
            }
            Some(Ok(Message::Binary(bytes))) => audio_bytes.extend_from_slice(&bytes),
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(format!("CosyVoice WebSocket 接收错误: {e}")),
            None => return Err("CosyVoice WebSocket 在 task-started 前已关闭".to_string()),
        }
    }

    // 2) continue-task: send the text to synthesize.
    let continue_task = serde_json::json!({
        "header": { "action": "continue-task", "task_id": task_id, "streaming": "duplex" },
        "payload": { "input": { "text": request.text } }
    });
    write
        .send(Message::Text(continue_task.to_string()))
        .await
        .map_err(|e| format!("发送 CosyVoice continue-task 失败: {e}"))?;

    // 3) finish-task: no more text is coming; flush the remaining synthesis.
    let finish_task = serde_json::json!({
        "header": { "action": "finish-task", "task_id": task_id, "streaming": "duplex" },
        "payload": { "input": {} }
    });
    write
        .send(Message::Text(finish_task.to_string()))
        .await
        .map_err(|e| format!("发送 CosyVoice finish-task 失败: {e}"))?;

    // 4) Collect binary audio frames until task-finished / task-failed / close.
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
                        return Err(cosyvoice_failure(cfg, request.model, &log_url, event))
                    }
                    _ => {} // result-generated etc. are markers; audio is binary
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
        log_provider_event("tts_generate", cfg, request.model, &log_url, false, &message);
        return Err(message);
    }
    log_provider_event(
        "tts_generate",
        cfg,
        request.model,
        &log_url,
        true,
        "audio generated",
    );
    Ok(GeneratedMedia {
        base64_data: encode_base64(&audio_bytes),
        extension: format.to_string(),
    })
}

fn cosyvoice_failure(
    cfg: &AiProviderConfig,
    model: &str,
    log_url: &str,
    event: CosyVoiceEvent,
) -> String {
    let message = event.header.error_message.unwrap_or_default();
    let hint = if message.contains("418") {
        "（可能原因：音色 ID 与模型版本不匹配，或音色不存在。v2/v3 模型请用带 _v2 后缀的音色）"
    } else {
        ""
    };
    let full = format!("CosyVoice 任务失败: {message}{hint}");
    log_provider_event("tts_generate", cfg, model, log_url, false, &full);
    full
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_cosyvoice_voice_appends_v2_for_v2_model() {
        assert_eq!(
            normalize_cosyvoice_voice("longwanjun", "cosyvoice-v2"),
            "longwanjun_v2"
        );
        assert_eq!(
            normalize_cosyvoice_voice("longanrou", "cosyvoice-v3-flash"),
            "longanrou_v2"
        );
        // Already has _v2 — no double-append.
        assert_eq!(
            normalize_cosyvoice_voice("longxiaochun_v2", "cosyvoice-v2"),
            "longxiaochun_v2"
        );
    }

    #[test]
    fn normalize_cosyvoice_voice_strips_v2_for_v1_model() {
        assert_eq!(
            normalize_cosyvoice_voice("longxiaochun_v2", "cosyvoice-v1"),
            "longxiaochun"
        );
        assert_eq!(
            normalize_cosyvoice_voice("longwanjun", "cosyvoice-v1"),
            "longwanjun"
        );
    }

    #[test]
    fn normalize_cosyvoice_voice_passes_through_custom_clone_id() {
        // Clone IDs contain hyphens; must not be mangled.
        let clone_id = "speech-synthesizer-clone-v3-abc123-def456";
        assert_eq!(normalize_cosyvoice_voice(clone_id, "cosyvoice-v2"), clone_id);
    }

    #[test]
    fn task_ids_are_unique_and_fixed_width() {
        let first = simple_task_id();
        let second = simple_task_id();
        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
