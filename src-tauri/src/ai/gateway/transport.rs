//! Shared HTTP plumbing and URL resolution for every media adaptor.
//!
//! Adaptors describe *what* to send; this module owns *how* it goes out —
//! one client with one timeout, one base-URL resolver, and one place where a
//! non-2xx response turns into a logged error. Before this existed each
//! provider function built its own `reqwest::Client` and its own endpoint
//! string, so a request and the log line describing it could disagree.

use std::time::Duration;

use base64::Engine;

use super::types::GeneratedMedia;
use crate::ai::commands::log_provider_event;
use crate::ai::config::AiProviderConfig;
use crate::ai::registry::{self, Modality};

pub const HTTP_REQUEST_TIMEOUT_SECS: u64 = 180;

/// The one client every media request goes through, so no provider can
/// accidentally omit the timeout and hang a Flow Step forever.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

/// Older configs could persist the `api.example.com` sample that earlier UI
/// presets wrote into the Base URL field. Treat it as unset so the registry
/// default takes over instead of building a request against a dead host.
pub fn is_placeholder_base_url(value: &str) -> bool {
    value.to_ascii_lowercase().contains("api.example.com")
}

fn usable_base_url(base_url: &str) -> &str {
    if is_placeholder_base_url(base_url) {
        ""
    } else {
        base_url
    }
}

/// Base URL for `provider` in `modality`: the user's value when set, otherwise
/// the registry default. Empty when neither exists.
pub fn resolved_base_url(provider: &str, modality: Modality, base_url: &str) -> String {
    registry::resolve_base_url(provider, modality, usable_base_url(base_url)).unwrap_or_default()
}

/// Join the resolved base URL with an API path. The only URL builder for
/// image/TTS/music requests, so a provider's endpoint cannot differ between
/// the request and the log line.
pub fn media_endpoint(cfg: &AiProviderConfig, modality: Modality, path: &str) -> String {
    let base = resolved_base_url(&cfg.provider, modality, &cfg.base_url);
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        path.to_string()
    } else if base.ends_with(path) {
        base.to_string()
    } else {
        format!("{base}/{path}")
    }
}

/// Gemini addresses the model in the path rather than the body, so it needs
/// its own join step on top of the shared base-URL resolution.
pub fn gemini_endpoint(
    cfg: &AiProviderConfig,
    modality: Modality,
    model: &str,
    action: &str,
) -> String {
    let base = resolved_base_url(&cfg.provider, modality, &cfg.base_url);
    format!("{}/models/{model}:{action}", base.trim_end_matches('/'))
}

/// POST a JSON body and return the response text, failing on any non-2xx.
/// `action_label` only shapes the user-facing error prefix.
pub async fn post_json_text(
    cfg: &AiProviderConfig,
    endpoint: &str,
    body: serde_json::Value,
    action_label: &str,
) -> Result<String, String> {
    let body =
        serde_json::to_string(&body).map_err(|e| format!("序列化{action_label}请求失败: {e}"))?;
    let response = bearer_post(cfg, endpoint, body)
        .send()
        .await
        .map_err(|e| {
            let message = format!("{action_label}请求失败: {e}");
            log_provider_event(
                "media_generate",
                cfg,
                cfg.model.trim(),
                endpoint,
                false,
                &message,
            );
            message
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取{action_label}响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event(
            "media_generate",
            cfg,
            cfg.model.trim(),
            endpoint,
            false,
            &text,
        );
        return Err(format!("{action_label}失败 ({status}): {text}"));
    }
    Ok(text)
}

/// POST a JSON body and treat the response as raw audio bytes.
pub async fn post_audio_bytes(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    body: serde_json::Value,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化音频生成请求失败: {e}"))?;
    let response = bearer_post(cfg, endpoint, body)
        .send()
        .await
        .map_err(|e| format!("音频生成请求失败: {e}"))?;
    response_to_generated_media(response, cfg, model, endpoint, extension, action).await
}

/// A JSON POST carrying the configured key as a bearer token, omitting the
/// header entirely when no key is set (local and unauthenticated gateways).
pub fn bearer_post(
    cfg: &AiProviderConfig,
    endpoint: &str,
    body: String,
) -> reqwest::RequestBuilder {
    let request = http_client()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .body(body);
    if cfg.api_key.trim().is_empty() {
        request
    } else {
        request.bearer_auth(cfg.api_key.trim())
    }
}

/// Turn a response whose body is the audio itself into [`GeneratedMedia`].
pub async fn response_to_generated_media(
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

pub fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider: &str, base_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: provider.to_string(),
            model: "model".to_string(),
            api_key: "key".to_string(),
            base_url: base_url.to_string(),
        }
    }

    #[test]
    fn endpoint_uses_the_registry_default_when_base_url_is_empty() {
        assert_eq!(
            media_endpoint(&cfg("openai", ""), Modality::Image, "images/generations"),
            "https://api.openai.com/v1/images/generations"
        );
        // aliyun previously had no default here, so an empty Base URL produced
        // a bare path that could never be requested.
        assert_eq!(
            media_endpoint(&cfg("aliyun", ""), Modality::Image, "tasks/abc"),
            "https://dashscope.aliyuncs.com/api/v1/tasks/abc"
        );
    }

    #[test]
    fn endpoint_prefers_a_configured_base_url_and_trims_slashes() {
        assert_eq!(
            media_endpoint(
                &cfg("openai", "https://proxy.test/v1/"),
                Modality::Image,
                "images/generations"
            ),
            "https://proxy.test/v1/images/generations"
        );
    }

    /// A Base URL that already points at the full endpoint must not have the
    /// path appended a second time.
    #[test]
    fn endpoint_is_not_double_joined() {
        assert_eq!(
            media_endpoint(
                &cfg("custom", "https://gw.test/v1/audio/speech"),
                Modality::Tts,
                "audio/speech"
            ),
            "https://gw.test/v1/audio/speech"
        );
    }

    #[test]
    fn leftover_example_base_url_falls_back_to_the_registry_default() {
        assert_eq!(
            media_endpoint(
                &cfg("openai", "https://api.example.com/v1"),
                Modality::Tts,
                "audio/speech"
            ),
            "https://api.openai.com/v1/audio/speech"
        );
    }

    #[test]
    fn gemini_endpoint_addresses_the_model_in_the_path() {
        assert_eq!(
            gemini_endpoint(&cfg("gemini", ""), Modality::Image, "m", "generateContent"),
            "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent"
        );
    }

    /// `custom` has no built-in endpoint, so the caller must have validated a
    /// Base URL first; the resolver returns the bare path rather than
    /// inventing a host.
    #[test]
    fn provider_without_a_default_yields_the_bare_path() {
        assert_eq!(
            media_endpoint(&cfg("custom", ""), Modality::Music, "audio/music"),
            "audio/music"
        );
    }
}
