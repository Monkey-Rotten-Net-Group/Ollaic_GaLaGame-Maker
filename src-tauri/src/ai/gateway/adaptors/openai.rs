//! OpenAI-compatible adaptor: `/images/generations`, `/audio/speech`, and a
//! `/audio/music` convention for BGM gateways.
//!
//! Also covers every provider that speaks the same dialect behind a different
//! host (Zhipu, SiliconFlow, Volcengine Ark, Midjourney-Proxy, and any
//! user-supplied `custom` gateway), plus the Volcengine Seedream request
//! variant, which is OpenAI-shaped but takes different parameters.

use serde::Deserialize;

use crate::ai::commands::download_generated_media;
use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{
    bearer_post, media_endpoint, post_audio_bytes, post_json_text, response_to_generated_media,
};
use crate::ai::gateway::types::{
    strip_data_url_prefix, GeneratedMedia, ImageRequest, MusicRequest, TtsRequest,
};
use crate::ai::registry::Modality;

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

pub async fn generate_image(
    cfg: &AiProviderConfig,
    request: &ImageRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, Modality::Image, "images/generations");
    let body = if is_seedream_model(request.model) {
        let mut body = serde_json::json!({
            "model": request.model,
            "prompt": request.prompt,
            "size": "2K",
            "response_format": "url",
            "stream": false,
            "watermark": false,
            "sequential_image_generation": "disabled"
        });
        // Seedream 4.x supports image-to-image. Volcengine's docs require the
        // reference as a `data:image/<fmt>;base64,<payload>` URI, which is what
        // keeps a character looking consistent across generated figures.
        if let Some(reference) = request.reference {
            body["image"] = serde_json::json!(reference.data_url());
        }
        body
    } else {
        // Non-Seedream OpenAI-compatible image APIs (DALL·E / gpt-image) use a
        // different protocol for references, so the reference is ignored here.
        serde_json::json!({
            "model": request.model,
            "prompt": request.prompt,
            "n": 1,
            "size": "1024x1024",
            "response_format": "b64_json"
        })
    };
    let text = post_json_text(cfg, &endpoint, body, "图片生成").await?;
    parse_image_response(cfg, request.model, &endpoint, &text).await
}

pub async fn parse_image_response(
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
        crate::ai::commands::log_provider_event(
            "image_generate",
            cfg,
            model,
            endpoint,
            true,
            "image generated",
        );
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

pub async fn generate_tts(
    cfg: &AiProviderConfig,
    request: &TtsRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, Modality::Tts, "audio/speech");
    let body = serde_json::json!({
        "model": request.model,
        "input": request.text,
        "voice": voice_from_prompt(request.voice_prompt),
        "response_format": request.format
    });
    post_audio_bytes(
        cfg,
        request.model,
        &endpoint,
        body,
        request.format,
        "tts_generate",
    )
    .await
}

/// BGM generation. Unlike speech, music gateways disagree about whether they
/// return audio bytes or a JSON envelope, so the Content-Type decides which
/// path to take rather than assuming one and saving a JSON body as a broken
/// audio file.
pub async fn generate_music(
    cfg: &AiProviderConfig,
    request: &MusicRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, Modality::Music, "audio/music");
    // Send both `input` and `prompt` so the same body works across gateways
    // that name the field differently.
    let body = serde_json::json!({
        "model": request.model,
        "input": request.prompt,
        "prompt": request.prompt,
        "response_format": request.format
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化音乐生成请求失败: {e}"))?;
    let response = bearer_post(cfg, &endpoint, body)
        .send()
        .await
        .map_err(|e| format!("音乐生成请求失败: {e}"))?;

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();

    if response.status().is_success() && is_audio_mime(&mime) {
        return response_to_generated_media(
            response,
            cfg,
            request.model,
            &endpoint,
            &crate::ai::gateway::types::extension_from_mime(&mime, request.format),
            "music_generate",
        )
        .await;
    }

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取音乐生成响应失败: {e}"))?;
    if !status.is_success() {
        crate::ai::commands::log_provider_event(
            "music_generate",
            cfg,
            request.model,
            &endpoint,
            false,
            &text,
        );
        return Err(format!("音乐生成失败 ({status}): {text}"));
    }
    parse_music_json_response(cfg, request.model, &endpoint, &text, request.format).await
}

fn is_audio_mime(mime: &str) -> bool {
    mime.starts_with("audio/") || mime == "application/octet-stream" || mime.starts_with("binary/")
}

async fn parse_music_json_response(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    text: &str,
    fallback_ext: &str,
) -> Result<GeneratedMedia, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("解析音乐生成响应失败: {e}; 响应: {}", truncate(text)))?;
    if let Some(b64) = find_audio_base64(&value) {
        crate::ai::commands::log_provider_event(
            "music_generate",
            cfg,
            model,
            endpoint,
            true,
            "music generated (base64)",
        );
        return Ok(GeneratedMedia {
            base64_data: strip_data_url_prefix(&b64).to_string(),
            extension: fallback_ext.to_string(),
        });
    }
    if let Some(url) = find_audio_url(&value) {
        return download_generated_media(cfg, model, endpoint, &url, fallback_ext, "music_generate")
            .await;
    }
    crate::ai::commands::log_provider_event("music_generate", cfg, model, endpoint, false, text);
    Err(format!(
        "音乐生成响应中未找到音频数据。请让自定义端点直接返回音频字节（Content-Type: audio/*），或返回含 data/audio/b64_json/url 字段的 JSON。响应: {}",
        truncate(text)
    ))
}

fn truncate(value: &str) -> String {
    crate::ai::commands::truncate_log_field(value)
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

fn voice_from_prompt(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    for voice in [
        "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
    ] {
        if lower.contains(voice) {
            return voice.to_string();
        }
    }
    "alloy".to_string()
}

fn is_seedream_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("seedream")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seedream_detection_is_case_insensitive() {
        assert!(is_seedream_model("doubao-SeeDream-4-5-251128"));
        assert!(!is_seedream_model("dall-e-3"));
    }

    #[test]
    fn voice_prompt_maps_onto_a_known_openai_voice() {
        assert_eq!(voice_from_prompt("温柔的 nova 音色"), "nova");
        assert_eq!(voice_from_prompt("没有提到音色"), "alloy");
    }

    #[test]
    fn audio_mime_detection_accepts_the_shapes_gateways_actually_send() {
        assert!(is_audio_mime("audio/mpeg"));
        assert!(is_audio_mime("application/octet-stream"));
        assert!(!is_audio_mime("application/json"));
    }

    #[test]
    fn base64_audio_is_found_across_common_envelope_shapes() {
        let long = "A".repeat(80);
        let flat = serde_json::json!({ "b64_json": long });
        assert!(find_audio_base64(&flat).is_some());

        let nested = serde_json::json!({ "data": [{ "audio": "QUJD" }] });
        assert_eq!(find_audio_base64(&nested).as_deref(), Some("QUJD"));

        let dashscope = serde_json::json!({ "output": { "audio": { "data": "QUJD" } } });
        assert_eq!(find_audio_base64(&dashscope).as_deref(), Some("QUJD"));
    }

    /// A URL must never be mistaken for base64 payload, or the caller would
    /// save the URL text as the audio file.
    #[test]
    fn a_url_is_never_returned_as_base64() {
        let value = serde_json::json!({ "url": "https://cdn.test/a.mp3" });
        assert!(find_audio_base64(&value).is_none());
        assert_eq!(
            find_audio_url(&value).as_deref(),
            Some("https://cdn.test/a.mp3")
        );
    }

    #[test]
    fn non_http_url_fields_are_ignored() {
        let value = serde_json::json!({ "output": { "audio": { "url": "not-a-url" } } });
        assert!(find_audio_url(&value).is_none());
    }
}
