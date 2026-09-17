//! Google Gemini / Imagen image adaptor.
//!
//! Gemini returns generated images inline as base64 parts rather than as a
//! URL, and authenticates with `x-goog-api-key` instead of a bearer token, so
//! it cannot share the OpenAI-compatible path.

use serde::Deserialize;

use crate::ai::commands::log_provider_event;
use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{gemini_endpoint, http_client};
use crate::ai::gateway::types::{extension_from_mime, GeneratedMedia, ImageRequest};
use crate::ai::registry::Modality;

#[derive(Debug, Deserialize)]
struct GenerateResponse {
    #[serde(default)]
    candidates: Vec<Candidate>,
}

#[derive(Debug, Deserialize)]
struct Candidate {
    #[serde(default)]
    content: Option<Content>,
}

#[derive(Debug, Deserialize)]
struct Content {
    #[serde(default)]
    parts: Vec<Part>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    #[serde(default)]
    inline_data: Option<InlineData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InlineData {
    #[serde(default)]
    mime_type: String,
    data: String,
}

pub async fn generate_image(
    cfg: &AiProviderConfig,
    request: &ImageRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let endpoint = gemini_endpoint(cfg, Modality::Image, request.model, "generateContent");
    // With a reference image this becomes image-to-image: the reference is
    // appended to `parts` as inline_data.
    let parts = match request.reference {
        Some(reference) => serde_json::json!([
            { "inline_data": { "mime_type": reference.mime, "data": reference.base64 } },
            { "text": request.prompt }
        ]),
        None => serde_json::json!([{ "text": request.prompt }]),
    };
    let body = serde_json::json!({ "contents": [{ "parts": parts }] });
    let body =
        serde_json::to_string(&body).map_err(|e| format!("序列化 Gemini 图片生成请求失败: {e}"))?;
    let response = http_client()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", cfg.api_key.trim())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Gemini 图片生成请求失败: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取 Gemini 图片生成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("image_generate", cfg, request.model, &endpoint, false, &text);
        return Err(format!("Gemini 图片生成失败 ({status}): {text}"));
    }
    let parsed: GenerateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Gemini 图片生成响应失败: {e}; 响应: {text}"))?;
    for candidate in parsed.candidates {
        let Some(content) = candidate.content else {
            continue;
        };
        for part in content.parts {
            if let Some(inline) = part.inline_data {
                log_provider_event(
                    "image_generate",
                    cfg,
                    request.model,
                    &endpoint,
                    true,
                    "image generated",
                );
                return Ok(GeneratedMedia {
                    extension: extension_from_mime(&inline.mime_type, "png"),
                    base64_data: inline.data,
                });
            }
        }
    }
    Err("Gemini 图片生成响应中没有 inline image 数据".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gemini can return text-only candidates (e.g. a safety refusal) before
    /// the image part, so parsing must skip past them rather than stop.
    #[test]
    fn inline_image_is_found_past_candidates_without_one() {
        let text = serde_json::json!({
            "candidates": [
                { "content": { "parts": [{ "text": "no image here" }] } },
                { "content": { "parts": [
                    { "inlineData": { "mimeType": "image/jpeg", "data": "QUJD" } }
                ] } }
            ]
        })
        .to_string();
        let parsed: GenerateResponse = serde_json::from_str(&text).unwrap();
        let found = parsed
            .candidates
            .into_iter()
            .filter_map(|c| c.content)
            .flat_map(|c| c.parts)
            .find_map(|p| p.inline_data)
            .expect("inline image");
        assert_eq!(found.data, "QUJD");
        assert_eq!(extension_from_mime(&found.mime_type, "png"), "jpg");
    }
}
