//! Stable Diffusion WebUI (AUTOMATIC1111) adaptor for local image generation.
//!
//! The model is selected inside the WebUI itself rather than per request, so
//! the configured model name is only carried into the log line.

use crate::ai::commands::log_provider_event;
use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{media_endpoint, post_json_text};
use crate::ai::gateway::types::{strip_data_url_prefix, GeneratedMedia, ImageRequest};
use crate::ai::registry::Modality;

pub async fn generate_image(
    cfg: &AiProviderConfig,
    request: &ImageRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, Modality::Image, "sdapi/v1/txt2img");
    let body = serde_json::json!({
        "prompt": request.prompt,
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
