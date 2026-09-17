//! Volcengine (ByteDance) unidirectional streaming TTS.
//!
//! Authentication is `X-Api-Key` plus `X-Api-Resource-Id` (which carries the
//! model), and the response is newline-delimited JSON where each line holds
//! one base64 audio chunk. The chunks must be decoded and concatenated before
//! re-encoding, so the response cannot go through the shared byte path.
//!
//! Image generation for this provider speaks the OpenAI-compatible dialect
//! and is handled by [`super::openai`].

use base64::Engine;
use serde::Deserialize;

use crate::ai::commands::log_provider_event;
use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{encode_base64, http_client, resolved_base_url};
use crate::ai::gateway::types::{strip_data_url_prefix, GeneratedMedia, TtsRequest};
use crate::ai::registry::Modality;

const DEFAULT_RESOURCE_ID: &str = "seed-tts-2.0";
const DEFAULT_SPEAKER: &str = "zh_female_vv_uranus_bigtts";

/// One chunk of the streamed response. `data` is this chunk's base64 audio
/// (usually empty on the terminating chunk).
#[derive(Debug, Deserialize)]
struct TtsChunk {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    data: Option<String>,
}

pub async fn generate_tts(
    cfg: &AiProviderConfig,
    request: &TtsRequest<'_>,
) -> Result<GeneratedMedia, String> {
    // The registry default for this provider is already the full endpoint, not
    // a base to join a path onto.
    let endpoint = resolved_base_url(&cfg.provider, Modality::Tts, &cfg.base_url)
        .trim_end_matches('/')
        .to_string();
    let resource_id = if request.model.is_empty() {
        DEFAULT_RESOURCE_ID
    } else {
        request.model
    };
    let speaker = {
        let trimmed = request.voice_prompt.trim();
        if trimmed.is_empty() {
            DEFAULT_SPEAKER
        } else {
            trimmed
        }
    };
    let body = serde_json::json!({
        "req_params": {
            "text": request.text,
            "speaker": speaker,
            "audio_params": { "format": request.format, "sample_rate": 24000 }
        }
    });
    let body =
        serde_json::to_string(&body).map_err(|e| format!("序列化火山语音合成请求失败: {e}"))?;
    let response = http_client()
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
            log_provider_event("tts_generate", cfg, request.model, &endpoint, false, &message);
            message
        })?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("读取火山语音合成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event(
            "tts_generate",
            cfg,
            request.model,
            &endpoint,
            false,
            &response_text,
        );
        return Err(format!("火山语音合成失败 ({status}): {response_text}"));
    }

    let (audio_bytes, last_error) = decode_stream(&response_text)?;
    if audio_bytes.is_empty() {
        if let Some(error) = last_error {
            log_provider_event("tts_generate", cfg, request.model, &endpoint, false, &error);
            return Err(error);
        }
        return Err(format!("火山语音合成响应中没有音频数据: {response_text}"));
    }
    log_provider_event(
        "tts_generate",
        cfg,
        request.model,
        &endpoint,
        true,
        "audio generated",
    );
    Ok(GeneratedMedia {
        base64_data: encode_base64(&audio_bytes),
        extension: request.format.to_string(),
    })
}

/// Decode the newline-delimited chunks into one audio buffer, remembering the
/// last error code so an all-empty stream can explain itself.
fn decode_stream(response_text: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let mut audio_bytes: Vec<u8> = Vec::new();
    let mut last_error: Option<String> = None;
    for line in response_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<TtsChunk>(line) else {
            continue; // skip non-JSON lines such as keep-alive blanks
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
    Ok((audio_bytes, last_error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_are_decoded_and_concatenated_in_order() {
        // "AB" then "CD" base64-encoded, plus an empty terminating chunk.
        let body = [
            r#"{"code":0,"data":"QUI="}"#,
            "",
            r#"{"code":0,"data":"Q0Q="}"#,
            r#"{"code":0,"data":""}"#,
        ]
        .join("\n");
        let (bytes, error) = decode_stream(&body).unwrap();
        assert_eq!(bytes, b"ABCD");
        assert!(error.is_none());
    }

    #[test]
    fn non_json_keepalive_lines_are_skipped() {
        let body = ["", ":keepalive", r#"{"code":0,"data":"QUI="}"#].join("\n");
        let (bytes, _) = decode_stream(&body).unwrap();
        assert_eq!(bytes, b"AB");
    }

    /// An error-only stream must surface the provider's own message rather
    /// than a generic "no audio" error.
    #[test]
    fn error_code_is_reported_when_no_audio_arrives() {
        let body = r#"{"code":1001,"message":"quota exceeded"}"#;
        let (bytes, error) = decode_stream(body).unwrap();
        assert!(bytes.is_empty());
        assert!(error.unwrap().contains("quota exceeded"));
    }
}
