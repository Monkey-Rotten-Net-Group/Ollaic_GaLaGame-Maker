use serde::Serialize;

use super::config::{AiConfig, AiProviderConfig, ProviderCapabilityDeclaration};

const DEFAULT_CHAT_DEADLINE_MS: u64 = 120_000;
const DEFAULT_FLOW_DEADLINE_MS: u64 = 180_000;
const DEFAULT_MEDIA_FETCH_DEADLINE_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapability {
    pub chat_tools: bool,
    pub json_mode: bool,
    pub streaming_cancellation: bool,
    pub media_url_output: bool,
    pub chat_deadline_ms: u64,
    pub flow_step_deadline_ms: u64,
    pub media_fetch_deadline_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredCapability {
    ChatTools,
    MediaUrlOutput,
}

impl ProviderCapability {
    pub fn require(self, required: RequiredCapability) -> Result<(), String> {
        let (supported, label) = match required {
            RequiredCapability::ChatTools => (self.chat_tools, "工具调用"),
            RequiredCapability::MediaUrlOutput => (self.media_url_output, "媒体 URL 输出"),
        };
        supported
            .then_some(())
            .ok_or_else(|| format!("当前供应商/模型未声明支持{label}"))
    }
}

pub fn capability_for_config(config: &AiConfig) -> Result<ProviderCapability, String> {
    let provider = config.provider.trim().to_ascii_lowercase();
    let model = config.model.trim().to_ascii_lowercase();
    let mut capability = match provider.as_str() {
        "openai" => builtin(true, true, true, true, 180_000),
        "anthropic" => builtin(true, false, true, false, 180_000),
        "gemini" => builtin(true, true, true, true, 180_000),
        "deepseek" => builtin(true, true, true, false, 180_000),
        "groq" | "xai" | "cohere" => builtin(true, true, true, false, 120_000),
        "ollama" => builtin(false, true, false, false, 600_000),
        "aliyun" | "volcengine" | "zhipu" | "siliconflow" | "elevenlabs" => {
            builtin(false, false, true, true, 600_000)
        }
        "sd-webui" | "comfyui" | "edge-tts" => builtin(false, false, false, false, 900_000),
        "custom" => from_custom(config.capabilities.as_ref()),
        "" => return Err("尚未选择 AI 供应商".to_string()),
        _ => return Err(format!("未知 AI 供应商：{}", config.provider.trim())),
    };

    // Reasoning-only DeepSeek models do not accept tool definitions even though
    // the provider's chat endpoint does for its general chat models.
    if provider == "deepseek" && model.contains("reasoner") {
        capability.chat_tools = false;
    }
    validate_deadlines(capability)?;
    Ok(capability)
}

pub fn capability_for_provider_config(
    config: &AiProviderConfig,
) -> Result<ProviderCapability, String> {
    capability_for_config(&AiConfig {
        provider: config.provider.clone(),
        model: config.model.clone(),
        api_key: config.api_key.clone(),
        base_url: config.base_url.clone(),
        capabilities: config.capabilities.clone(),
    })
}

pub fn media_flow_step_deadline_ms(configs: &[AiProviderConfig]) -> Result<u64, String> {
    configs
        .iter()
        .map(capability_for_provider_config)
        .map(|capability| capability.map(|value| value.flow_step_deadline_ms))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .ok_or_else(|| "没有可用于媒体步骤的供应商配置".to_string())
}

fn builtin(
    chat_tools: bool,
    json_mode: bool,
    streaming_cancellation: bool,
    media_url_output: bool,
    flow_step_deadline_ms: u64,
) -> ProviderCapability {
    ProviderCapability {
        chat_tools,
        json_mode,
        streaming_cancellation,
        media_url_output,
        chat_deadline_ms: DEFAULT_CHAT_DEADLINE_MS,
        flow_step_deadline_ms,
        media_fetch_deadline_ms: DEFAULT_MEDIA_FETCH_DEADLINE_MS,
    }
}

fn from_custom(declaration: Option<&ProviderCapabilityDeclaration>) -> ProviderCapability {
    let declaration = declaration.cloned().unwrap_or_default();
    ProviderCapability {
        chat_tools: declaration.chat_tools,
        json_mode: declaration.json_mode,
        streaming_cancellation: declaration.streaming_cancellation,
        media_url_output: declaration.media_url_output,
        chat_deadline_ms: declaration
            .chat_deadline_ms
            .unwrap_or(DEFAULT_CHAT_DEADLINE_MS),
        flow_step_deadline_ms: declaration
            .flow_step_deadline_ms
            .unwrap_or(DEFAULT_FLOW_DEADLINE_MS),
        media_fetch_deadline_ms: declaration
            .media_fetch_deadline_ms
            .unwrap_or(DEFAULT_MEDIA_FETCH_DEADLINE_MS),
    }
}

fn validate_deadlines(capability: ProviderCapability) -> Result<(), String> {
    for (name, value) in [
        ("chat_deadline_ms", capability.chat_deadline_ms),
        ("flow_step_deadline_ms", capability.flow_step_deadline_ms),
        (
            "media_fetch_deadline_ms",
            capability.media_fetch_deadline_ms,
        ),
    ] {
        if value == 0 || value > 3_600_000 {
            return Err(format!("{name} 必须在 1 到 3600000 毫秒之间"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str, model: &str) -> AiConfig {
        AiConfig {
            provider: provider.to_string(),
            model: model.to_string(),
            api_key: String::new(),
            base_url: String::new(),
            capabilities: None,
        }
    }

    #[test]
    fn provider_capability_table_covers_configured_chat_providers() {
        for (provider, tools, json, local) in [
            ("openai", true, true, false),
            ("anthropic", true, false, false),
            ("gemini", true, true, false),
            ("deepseek", true, true, false),
            ("groq", true, true, false),
            ("xai", true, true, false),
            ("cohere", true, true, false),
            ("ollama", false, true, true),
        ] {
            let capability = capability_for_config(&config(provider, "model")).unwrap();
            assert_eq!(capability.chat_tools, tools, "{provider}");
            assert_eq!(capability.json_mode, json, "{provider}");
            assert_eq!(capability.flow_step_deadline_ms >= 120_000, true);
            assert_eq!(capability.flow_step_deadline_ms >= 600_000, local);
        }
    }

    #[test]
    fn model_class_can_remove_provider_level_tool_support() {
        let capability = capability_for_config(&config("deepseek", "deepseek-reasoner")).unwrap();
        assert!(!capability.chat_tools);
        assert!(capability.json_mode);
    }

    #[test]
    fn custom_declaration_is_resolved_and_legacy_config_is_conservative() {
        let legacy = capability_for_config(&config("custom", "legacy-model")).unwrap();
        assert!(!legacy.chat_tools);
        assert!(!legacy.json_mode);

        let mut declared = config("custom", "tool-model");
        declared.capabilities = Some(ProviderCapabilityDeclaration {
            chat_tools: true,
            json_mode: true,
            streaming_cancellation: true,
            media_url_output: true,
            flow_step_deadline_ms: Some(240_000),
            ..Default::default()
        });
        let capability = capability_for_config(&declared).unwrap();
        assert!(capability.chat_tools);
        assert!(capability.media_url_output);
        assert_eq!(capability.flow_step_deadline_ms, 240_000);
    }

    #[test]
    fn unknown_provider_and_invalid_custom_deadline_fail_early() {
        assert!(capability_for_config(&config("mystery", "model"))
            .unwrap_err()
            .contains("未知"));

        let mut invalid = config("custom", "model");
        invalid.capabilities = Some(ProviderCapabilityDeclaration {
            chat_deadline_ms: Some(0),
            ..Default::default()
        });
        assert!(capability_for_config(&invalid)
            .unwrap_err()
            .contains("chat_deadline_ms"));
    }

    #[test]
    fn unsupported_capability_reports_before_request() {
        let capability = capability_for_config(&config("ollama", "qwen2.5:7b")).unwrap();
        assert!(capability
            .require(RequiredCapability::ChatTools)
            .unwrap_err()
            .contains("工具调用"));
    }

    #[test]
    fn media_provider_config_uses_the_same_capability_contract() {
        let config = AiProviderConfig {
            provider: "custom".to_string(),
            model: "image-model".to_string(),
            api_key: String::new(),
            base_url: "https://example.test/v1".to_string(),
            capabilities: Some(ProviderCapabilityDeclaration {
                media_url_output: true,
                flow_step_deadline_ms: Some(720_000),
                ..Default::default()
            }),
        };
        let capability = capability_for_provider_config(&config).unwrap();
        assert!(capability.media_url_output);
        assert_eq!(capability.flow_step_deadline_ms, 720_000);
    }

    #[test]
    fn asset_queue_uses_the_longest_declared_media_deadline() {
        let config_with_deadline = |deadline| AiProviderConfig {
            provider: "custom".to_string(),
            model: "media-model".to_string(),
            api_key: String::new(),
            base_url: "https://example.test/v1".to_string(),
            capabilities: Some(ProviderCapabilityDeclaration {
                flow_step_deadline_ms: Some(deadline),
                ..Default::default()
            }),
        };
        let deadline = media_flow_step_deadline_ms(&[
            config_with_deadline(240_000),
            config_with_deadline(900_000),
            config_with_deadline(600_000),
        ])
        .unwrap();
        assert_eq!(deadline, 900_000);
    }
}
