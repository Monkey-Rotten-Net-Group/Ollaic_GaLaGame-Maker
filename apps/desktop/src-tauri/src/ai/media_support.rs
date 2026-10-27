use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::config::{self, AiConfig, AiProviderConfig};
use super::gateway::transport::is_placeholder_base_url;
use super::gateway::types::GeneratedMedia;
use super::provider_capability::{capability_for_config, RequiredCapability};
use super::registry;
use super::safe_media_fetch::{self, FetchPolicy, MediaKind};
use base64::Engine;
use std::time::Duration;

const MAX_LOG_FIELD_CHARS: usize = 50_000;

#[derive(Serialize)]
struct LogEntry<'a> {
    timestamp_ms: u128,
    action: &'a str,
    provider: &'a str,
    model: &'a str,
    endpoint: &'a str,
    success: bool,
    message: &'a str,
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
    if cfg.api_key.trim().is_empty()
        && registry::find(&cfg.provider).is_none_or(|spec| spec.requires_api_key)
    {
        return Err(format!("尚未配置{capability} API Key"));
    }
    Ok(())
}

pub(crate) fn log_provider_event(
    action: &str,
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    success: bool,
    message: &str,
) {
    let redacted_endpoint = sanitize(&redact_known_secret(endpoint, &cfg.api_key));
    let redacted_message = sanitize(&redact_known_secret(message, &cfg.api_key));
    let entry = LogEntry {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        action,
        provider: &cfg.provider,
        model,
        endpoint: &redacted_endpoint,
        success,
        message: &redacted_message,
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = config::append_log_line(&line);
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

fn sanitize(value: &str) -> String {
    truncate_log_field(&redact_common_secrets(value))
}
fn redact_known_secret(value: &str, secret: &str) -> String {
    if secret.trim().is_empty() {
        value.to_string()
    } else {
        value.replace(secret.trim(), "[REDACTED]")
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
        let lower = output.to_ascii_lowercase();
        if let Some(start) = lower.find(marker) {
            output.replace_range(start + marker.len().., "[REDACTED]");
        }
    }
    output
}

pub(crate) fn as_chat_config(cfg: &AiProviderConfig, model: &str) -> AiConfig {
    AiConfig {
        provider: cfg.provider.clone(),
        model: model.to_string(),
        api_key: cfg.api_key.clone(),
        base_url: cfg.base_url.clone(),
        capabilities: None,
    }
}

pub(crate) async fn download_generated_media(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    url: &str,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    if cfg.provider.trim().eq_ignore_ascii_case("custom") {
        let base =
            reqwest::Url::parse(cfg.base_url.trim()).map_err(|_| "自定义媒体 Base URL 无效")?;
        let target = reqwest::Url::parse(url).map_err(|_| "媒体下载 URL 无效")?;
        if base.scheme() != target.scheme()
            || base.host_str() != target.host_str()
            || base.port_or_known_default() != target.port_or_known_default()
        {
            return Err("自定义媒体下载 URL 必须与 Base URL 同源".into());
        }
    } else {
        capability_for_config(&as_chat_config(cfg, model))?
            .require(RequiredCapability::MediaUrlOutput)?;
    }
    let kind = if action.contains("image") {
        MediaKind::Image
    } else {
        MediaKind::Audio
    };
    let bytes = safe_media_fetch::fetch_media(
        url,
        &safe_media_fetch::SystemMediaDnsResolver,
        &FetchPolicy {
            total_deadline: Duration::from_secs(180),
            kind,
            allow_address: Box::new(|_, ip| safe_media_fetch::is_public_download_ip(ip)),
        },
    )
    .await?;
    log_provider_event(action, cfg, model, endpoint, true, "media generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
        extension: extension.to_string(),
    })
}
