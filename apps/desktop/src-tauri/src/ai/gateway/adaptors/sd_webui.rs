//! Stable Diffusion WebUI (AUTOMATIC1111) adaptor for local image generation.
//!
//! The model is selected inside the WebUI itself rather than per request, so
//! the configured model name is only carried into the log line.

use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{media_endpoint, post_json_text};
use crate::ai::gateway::types::{strip_data_url_prefix, GeneratedMedia, ImageRequest};
use crate::ai::media_support::log_provider_event;
use crate::ai::registry::Modality;

/// Resolve pixel dimensions for an aspect ratio string.
/// - "3:4" -> (768, 1024) for character standing sprites
/// - "16:9" -> (1280, 720) for visual novel backgrounds
/// - default -> (1024, 1024)
pub fn resolve_dimensions_for_aspect_ratio(aspect_ratio: Option<&str>) -> (u32, u32) {
    match aspect_ratio {
        Some("3:4") => (768, 1024),
        Some("16:9") => (1280, 720),
        _ => (1024, 1024),
    }
}

fn image_request(request: &ImageRequest<'_>) -> (&'static str, serde_json::Value) {
    let (width, height) = resolve_dimensions_for_aspect_ratio(request.aspect_ratio);
    let (endpoint, body) = if let Some(reference) = request.reference {
        let endpoint = "sdapi/v1/img2img";
        let body = serde_json::json!({
            "init_images": [reference.base64],
            "denoising_strength": 0.45,
            "prompt": request.prompt,
            "steps": 28,
            "width": width,
            "height": height,
            "batch_size": 1,
            "n_iter": 1
        });
        (endpoint, body)
    } else {
        let endpoint = "sdapi/v1/txt2img";
        let body = serde_json::json!({
            "prompt": request.prompt,
            "steps": 28,
            "width": width,
            "height": height,
            "batch_size": 1,
            "n_iter": 1
        });
        (endpoint, body)
    };

    (endpoint, body)
}

pub async fn generate_image(
    cfg: &AiProviderConfig,
    request: &ImageRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let (path, body) = image_request(request);
    let endpoint = media_endpoint(cfg, Modality::Image, path);

    let text = post_json_text(cfg, &endpoint, body, "Stable Diffusion WebUI 图片生成").await?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Stable Diffusion WebUI 响应失败: {e}; 响应: {text}"))?;
    let b64 = parsed
        .get("images")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Stable Diffusion WebUI 响应中没有 images[0]: {text}"))?;
    log_provider_event(
        "image_generate",
        cfg,
        request.model,
        &endpoint,
        true,
        "image generated",
    );
    Ok(GeneratedMedia {
        base64_data: strip_data_url_prefix(b64).to_string(),
        extension: "png".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_routes_to_img2img_with_identity_preserving_strength() {
        let reference = crate::ai::gateway::types::ImageReference {
            mime: "image/png".into(),
            base64: "QUJD".into(),
        };
        let request = ImageRequest {
            model: "local-model",
            prompt: "smile",
            reference: Some(&reference),
            aspect_ratio: Some("3:4"),
        };
        let (path, body) = image_request(&request);
        assert_eq!(path, "sdapi/v1/img2img");
        assert_eq!(body["init_images"], serde_json::json!(["QUJD"]));
        assert_eq!(body["denoising_strength"], 0.45);
        assert_eq!(body["width"], 768);
        assert_eq!(body["height"], 1024);
        let (path, body) = image_request(&ImageRequest {
            reference: None,
            aspect_ratio: Some("16:9"),
            ..request
        });
        assert_eq!(path, "sdapi/v1/txt2img");
        assert!(body.get("init_images").is_none());
        assert!(body.get("denoising_strength").is_none());
        assert_eq!(body["width"], 1280);
        assert_eq!(body["height"], 720);
    }

    #[test]
    fn maps_aspect_ratios_to_expected_dimensions() {
        assert_eq!(
            resolve_dimensions_for_aspect_ratio(Some("3:4")),
            (768, 1024)
        );
        assert_eq!(
            resolve_dimensions_for_aspect_ratio(Some("16:9")),
            (1280, 720)
        );
        assert_eq!(resolve_dimensions_for_aspect_ratio(None), (1024, 1024));
        assert_eq!(
            resolve_dimensions_for_aspect_ratio(Some("unknown")),
            (1024, 1024)
        );
    }
}
