//! Fetch a chat provider's live model list for the settings "获取模型" button.
//!
//! Modelled on cc-switch's `model_fetch`: build one or more candidate
//! `…/models` URLs from the Base URL, pick the auth header the provider's
//! protocol expects, try each candidate in turn (moving on only on 404/405),
//! and accept both the OpenAI/Anthropic `data[]` shape and the Gemini
//! `models[]` shape. On top of that, the result is filtered down to chat
//! models, because `/models` also lists embedding, speech, image and
//! moderation models that the chat picker must never offer.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use reqwest::StatusCode;
use serde::Deserialize;

use super::config::AiConfig;
use super::gateway::transport::{http_client, is_placeholder_base_url, resolved_base_url};
use super::registry::{self, Modality};

const FETCH_TIMEOUT_SECS: u64 = 15;
/// Keep an HTML 404 page from flooding the error shown in the settings panel.
const ERROR_BODY_MAX_CHARS: usize = 300;
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Substrings that mark a model as something other than a text chat model.
/// Matched against the lower-cased id.
const NON_CHAT_MARKERS: &[&str] = &[
    "embed",
    "embedding",
    "whisper",
    "tts",
    "transcribe",
    "speech",
    "audio",
    "realtime",
    "native-audio",
    "dall-e",
    "image",
    "imagen",
    "imagine",
    "sora",
    "veo",
    "video",
    "moderation",
    "rerank",
    "davinci",
    "babbage",
    "-instruct",
    "aqa",
    "-live",
    "computer-use",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    OpenAi,
    Anthropic,
    Gemini,
}

fn protocol_for(provider: &str) -> Option<Protocol> {
    match provider {
        "openai" | "deepseek" | "xai" | "custom" => Some(Protocol::OpenAi),
        "anthropic" => Some(Protocol::Anthropic),
        "gemini" => Some(Protocol::Gemini),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<DataEntry>>,
    models: Option<Vec<GeminiEntry>>,
}

#[derive(Debug, Deserialize)]
struct DataEntry {
    id: String,
}

#[derive(Debug, Deserialize)]
struct GeminiEntry {
    name: String,
    #[serde(default, rename = "supportedGenerationMethods")]
    supported_generation_methods: Vec<String>,
}

/// Fetch the chat models `cfg` can reach, using the unsaved form values.
/// Returns the endpoint that answered alongside the sorted model ids.
pub async fn fetch_chat_models(cfg: &AiConfig) -> Result<(String, Vec<String>), String> {
    let provider = cfg.provider.trim().to_ascii_lowercase();
    let protocol = protocol_for(&provider)
        .ok_or_else(|| format!("供应商 '{}' 不支持在线获取模型", cfg.provider.trim()))?;
    if registry::modality_spec(&provider, Modality::Chat).is_none() {
        return Err(format!("供应商 '{}' 不提供对话模型", cfg.provider.trim()));
    }
    if is_placeholder_base_url(&cfg.base_url) {
        return Err("Base URL 仍是示例地址，请填写真实接口地址".into());
    }
    let base = resolved_base_url(&provider, Modality::Chat, &cfg.base_url);
    if base.trim().is_empty() {
        return Err("该供应商没有内置地址，请先填写 Base URL".into());
    }
    let api_key = cfg.api_key.trim();
    let requires_key = registry::find(&provider).is_some_and(|p| p.requires_api_key);
    if api_key.is_empty() && requires_key {
        return Err("请先填写 API Key".into());
    }

    let candidates = models_url_candidates(protocol, &base)?;
    let headers = auth_headers(protocol, api_key)?;
    let client = http_client();
    let mut last_err = String::new();

    for url in &candidates {
        let response = client
            .get(url)
            .headers(headers.clone())
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
            .send()
            .await
            .map_err(|e| redact(&format!("获取模型列表失败: {e}"), api_key))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("读取模型列表响应失败: {e}"))?;
        if status.is_success() {
            let ids = parse_model_ids(&body)?;
            return Ok((url.clone(), filter_chat_models(ids)));
        }
        let message = format!("HTTP {status}: {}", truncate(&redact(&body, api_key)));
        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            last_err = message;
            continue;
        }
        return Err(format!("获取模型列表失败（{url}）{message}"));
    }
    Err(format!(
        "获取模型列表失败，所有候选地址均不可用：{last_err}"
    ))
}

/// Candidate list endpoints, tried in order. A Base URL that already ends in a
/// version segment (`/v1`, `/v4`) gets `/models` appended; otherwise
/// `/v1/models` comes first with `/models` as the fallback.
fn models_url_candidates(protocol: Protocol, base_url: &str) -> Result<Vec<String>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Base URL 为空".into());
    }
    let candidates = match protocol {
        Protocol::Gemini => {
            let root = base
                .strip_suffix("/v1beta")
                .or_else(|| base.strip_suffix("/v1"))
                .unwrap_or(base);
            vec![format!("{root}/v1beta/models?pageSize=1000")]
        }
        Protocol::Anthropic => {
            let root = base.strip_suffix("/v1").unwrap_or(base);
            vec![format!("{root}/v1/models?limit=1000")]
        }
        Protocol::OpenAi if ends_with_version_segment(base) => vec![format!("{base}/models")],
        Protocol::OpenAi => vec![format!("{base}/v1/models"), format!("{base}/models")],
    };
    Ok(candidates)
}

fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn auth_headers(protocol: Protocol, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    if protocol == Protocol::Anthropic {
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
    }
    if api_key.is_empty() {
        return Ok(headers);
    }
    let invalid = |_| "API Key 含有无法放入请求头的字符".to_string();
    match protocol {
        Protocol::OpenAi => {
            let value = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(invalid)?;
            headers.insert(AUTHORIZATION, value);
        }
        Protocol::Anthropic => {
            let value = HeaderValue::from_str(api_key).map_err(invalid)?;
            headers.insert(HeaderName::from_static("x-api-key"), value);
        }
        // Sent as a header rather than `?key=` so it never lands in a URL or log line.
        Protocol::Gemini => {
            let value = HeaderValue::from_str(api_key).map_err(invalid)?;
            headers.insert(HeaderName::from_static("x-goog-api-key"), value);
        }
    }
    Ok(headers)
}

/// Accept the OpenAI/Anthropic `data[].id` shape and the Gemini `models[].name`
/// shape. Gemini entries that cannot `generateContent` are not chat models.
fn parse_model_ids(body: &str) -> Result<Vec<String>, String> {
    let parsed: ModelsResponse =
        serde_json::from_str(body).map_err(|e| format!("模型列表响应不是可识别的格式: {e}"))?;
    if let Some(data) = parsed.data {
        return Ok(data.into_iter().map(|entry| entry.id).collect());
    }
    Ok(parsed
        .models
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| {
            entry.supported_generation_methods.is_empty()
                || entry
                    .supported_generation_methods
                    .iter()
                    .any(|method| method == "generateContent")
        })
        .map(|entry| {
            entry
                .name
                .strip_prefix("models/")
                .unwrap_or(&entry.name)
                .to_string()
        })
        .collect())
}

/// Keep only text chat models, sorted and de-duplicated.
fn filter_chat_models(ids: Vec<String>) -> Vec<String> {
    let mut models: Vec<String> = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .filter(|id| {
            let lower = id.to_ascii_lowercase();
            !NON_CHAT_MARKERS.iter().any(|marker| lower.contains(marker))
        })
        .collect();
    models.sort();
    models.dedup();
    models
}

fn redact(text: &str, secret: &str) -> String {
    if secret.len() < 6 {
        return text.to_string();
    }
    text.replace(secret, "***")
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= ERROR_BODY_MAX_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(ERROR_BODY_MAX_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
#[path = "model_list_tests.rs"]
mod tests;
