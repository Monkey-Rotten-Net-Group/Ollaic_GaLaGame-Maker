//! OpenAI-compatible adaptor: `/images/generations` and `/audio/speech`.
//!
//! Also covers every provider that speaks the same dialect behind a different
//! host (Zhipu, SiliconFlow, Volcengine Ark, Midjourney-Proxy, and any
//! user-supplied `custom` gateway), plus the Volcengine Seedream request
//! variant, which is OpenAI-shaped but takes different parameters.

use serde::Deserialize;

use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{media_endpoint, post_audio_bytes, post_json_text};
use crate::ai::gateway::types::{strip_data_url_prefix, GeneratedMedia, ImageRequest, TtsRequest};
use crate::ai::media_support::download_generated_media;
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

fn image_request_body(request: &ImageRequest<'_>) -> serde_json::Value {
    if is_seedream_model(request.model) {
        let mut body = serde_json::json!({
            "model": request.model,
            "prompt": request.prompt,
            "size": seedream_size(request.aspect_ratio),
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
        // References are rejected by dispatch when this generation protocol
        // cannot represent them; never silently discard identity conditioning.
        serde_json::json!({
            "model": request.model,
            "prompt": request.prompt,
            "n": 1,
            "size": compatible_size(request.model, request.aspect_ratio),
            "response_format": "b64_json"
        })
    }
}

fn seedream_size(aspect_ratio: Option<&str>) -> &'static str {
    match aspect_ratio {
        Some("3:4") => "1728x2304",
        Some("16:9") => "2560x1440",
        _ => "2K",
    }
}

fn compatible_size(model: &str, aspect_ratio: Option<&str>) -> &'static str {
    let model = model.to_ascii_lowercase();
    match (model.as_str(), aspect_ratio) {
        ("dall-e-2", _) => "1024x1024",
        ("dall-e-3", Some("3:4")) => "1024x1792",
        ("dall-e-3", Some("16:9")) => "1792x1024",
        (_, Some("3:4")) => "1024x1536",
        (_, Some("16:9")) => "1536x1024",
        _ => "1024x1024",
    }
}

pub async fn generate_image(
    cfg: &AiProviderConfig,
    request: &ImageRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, Modality::Image, "images/generations");
    let body = image_request_body(request);
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
        crate::ai::media_support::log_provider_event(
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
    fn seedream_request_keeps_reference_and_explicit_canvas() {
        let reference = crate::ai::gateway::types::ImageReference {
            mime: "image/png".into(),
            base64: "QUJD".into(),
        };
        let request = ImageRequest {
            model: "doubao-seedream-4-5-251128",
            prompt: "portrait",
            reference: Some(&reference),
            aspect_ratio: Some("3:4"),
        };
        let body = image_request_body(&request);
        assert_eq!(body["image"], "data:image/png;base64,QUJD");
        assert_eq!(body["size"], "1728x2304");
        let body = image_request_body(&ImageRequest {
            reference: None,
            aspect_ratio: Some("16:9"),
            ..request
        });
        assert_eq!(body["size"], "2560x1440");
        assert!(body.get("image").is_none());
    }

    #[test]
    fn compatible_models_use_their_supported_portrait_and_landscape_sizes() {
        assert_eq!(compatible_size("gpt-image-1", Some("3:4")), "1024x1536");
        assert_eq!(compatible_size("gpt-image-1", Some("16:9")), "1536x1024");
        assert_eq!(compatible_size("dall-e-3", Some("3:4")), "1024x1792");
        assert_eq!(compatible_size("dall-e-3", Some("16:9")), "1792x1024");
        assert_eq!(compatible_size("dall-e-2", Some("16:9")), "1024x1024");
    }

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
}
