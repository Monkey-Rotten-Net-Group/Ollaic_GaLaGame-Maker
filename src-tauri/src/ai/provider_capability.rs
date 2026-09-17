//! Resolves what a configured AI provider/model can do. Frontend routing,
//! conversational deadlines, Flow Step timeouts, and the media-fetch policy
//! all read from this struct so settings changes take effect on the next new
//! Flow / Run.
//!
//! The provider facts themselves live in [`super::registry`]; this module only
//! applies the per-config overlays on top of them (an explicit `custom`
//! declaration, model-class exceptions, and deadline validation).

use serde::Serialize;

use super::config::{AiConfig, AiProviderConfig, ProviderCapabilityDeclaration};
use super::registry::{self, Modality};

const DEFAULT_CHAT_DEADLINE_MS: u64 = 120_000;
const DEFAULT_FLOW_DEADLINE_MS: u64 = 180_000;
const DEFAULT_MEDIA_FETCH_DEADLINE_MS: u64 = 30_000;
/// Maximum allowed deadline. Anything larger is almost certainly a typo and
/// must surface as a config error rather than silently disable back-pressure.
pub const MAX_DEADLINE_MS: u64 = 3_600_000;

/// Capability surface consumed by the rest of the codebase. The fields are
/// stable, additive, and `serde(rename_all = "camelCase")` so they round-trip
/// to the frontend without renaming.
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

/// What a caller intends to use. `require` returns a localized error when
/// the current provider/model does not declare support, so the failure shows
/// up at config-validate time, not deep inside a request future.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredCapability {
    ChatTools,
    /// Gate for `download_generated_media`: refuse to fetch provider-returned
    /// media URLs unless the active config explicitly declares it can hand
    /// them out. Closes the SSRF pivot where an unknown provider would
    /// otherwise land us in arbitrary network fetches.
    MediaUrlOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaCapability {
    ImageGeneration,
    TtsGeneration,
    MusicGeneration,
}

impl MediaCapability {
    fn modality(self) -> Modality {
        match self {
            MediaCapability::ImageGeneration => Modality::Image,
            MediaCapability::TtsGeneration => Modality::Tts,
            MediaCapability::MusicGeneration => Modality::Music,
        }
    }

    fn label(self) -> &'static str {
        match self {
            MediaCapability::ImageGeneration => "图片生成",
            MediaCapability::TtsGeneration => "语音生成",
            MediaCapability::MusicGeneration => "音乐生成",
        }
    }
}

pub fn require_media_capability(
    config: &AiProviderConfig,
    required: MediaCapability,
) -> Result<(), String> {
    let label = required.label();
    let spec = registry::modality_spec(&config.provider, required.modality()).ok_or_else(|| {
        format!(
            "当前媒体供应商 '{}' 未声明支持{label}；请更换供应商、允许本地素材降级，或禁用素材步骤",
            config.provider.trim()
        )
    })?;
    // Providers without a built-in endpoint cannot be reached at all until the
    // user supplies one, so surface that here rather than letting the request
    // fail against a half-built URL.
    if spec.needs_base_url() && config.base_url.trim().is_empty() {
        return Err(format!(
            "{label}供应商 '{}' 未填写 Base URL；请填写真实接口地址或允许本地素材降级",
            config.provider.trim()
        ));
    }
    Ok(())
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

    /// Flow Step deadline as a `Duration`. Zero means "do not bound".
    pub fn flow_step_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.flow_step_deadline_ms)
    }
}

/// Resolve the live capability for `config`. Re-reads the config at every
/// call so changing provider/model/deadline between Flows applies to the
/// next Run, not the singleton Orchestrator's startup snapshot.
pub fn capability_for_config(config: &AiConfig) -> Result<ProviderCapability, String> {
    let provider = config.provider.trim().to_ascii_lowercase();
    if provider.is_empty() {
        return Err("尚未选择 AI 供应商".to_string());
    }
    let model = config.model.trim().to_ascii_lowercase();
    let spec = registry::find(&provider)
        .ok_or_else(|| format!("未知 AI 供应商：{}", config.provider.trim()))?;

    // `custom` is the one provider whose capabilities the table cannot know,
    // so the user's own declaration wins there.
    let mut capability = if provider == "custom" {
        from_custom(config.capabilities.as_ref())
    } else {
        builtin(&spec.capability)
    };

    // Reasoning-only DeepSeek models do not accept tool definitions even
    // though the provider's chat endpoint does for its general chat models.
    if provider == "deepseek" && model.contains("reasoner") {
        capability.chat_tools = false;
    }
    validate_deadlines(capability)?;
    Ok(capability)
}

fn builtin(spec: &registry::CapabilitySpec) -> ProviderCapability {
    ProviderCapability {
        chat_tools: spec.chat_tools,
        json_mode: spec.json_mode,
        streaming_cancellation: spec.streaming_cancellation,
        media_url_output: spec.media_url_output,
        chat_deadline_ms: DEFAULT_CHAT_DEADLINE_MS,
        flow_step_deadline_ms: spec.flow_step_deadline_ms,
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
        if value == 0 {
            return Err(format!(
                "{name} 不能为 0；如果不需要超时，请在自定义能力声明里省略该字段（将使用默认值）"
            ));
        }
        if value > MAX_DEADLINE_MS {
            return Err(format!("{name} 不能超过 {MAX_DEADLINE_MS} 毫秒"));
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

    /// The settings pickers are generated from the registry, so anything a
    /// user can select must also resolve to a capability. A provider listed in
    /// a picker but missing from the capability path used to surface as
    /// "未知 AI 供应商" only once the user actually ran a generation.
    #[test]
    fn every_selectable_provider_resolves_a_capability() {
        for modality in [
            Modality::Chat,
            Modality::Image,
            Modality::Tts,
            Modality::Music,
        ] {
            for option in registry::options_for(modality) {
                let resolved = capability_for_config(&config(&option.value, &option.default_model));
                assert!(
                    resolved.is_ok(),
                    "{} is selectable but has no capability: {:?}",
                    option.value,
                    resolved.err()
                );
            }
        }
    }

    /// Every media provider the pickers offer must pass its own modality gate
    /// once a key and (where required) a Base URL are present. Otherwise the
    /// UI would offer a choice that the pipeline rejects before running.
    #[test]
    fn every_selectable_media_provider_passes_its_own_gate() {
        for (modality, required) in [
            (Modality::Image, MediaCapability::ImageGeneration),
            (Modality::Tts, MediaCapability::TtsGeneration),
            (Modality::Music, MediaCapability::MusicGeneration),
        ] {
            for option in registry::options_for(modality) {
                let cfg = AiProviderConfig {
                    provider: option.value.clone(),
                    model: option.default_model.clone(),
                    api_key: "key".to_string(),
                    base_url: if option.needs_base_url {
                        "https://gateway.test/v1".to_string()
                    } else {
                        String::new()
                    },
                };
                assert!(
                    require_media_capability(&cfg, required).is_ok(),
                    "{} is selectable for {:?} but fails its own gate",
                    option.value,
                    modality
                );
            }
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
            assert!(capability.flow_step_deadline_ms >= 120_000);
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
    fn media_url_output_gate_rejects_provider_that_does_not_declare_support() {
        // ollama is a local model whose API does not return downloadable
        // media URLs, so the gate must reject attempts to call
        // download_generated_media with it. The error message has to
        // surface before any network fetch happens.
        let capability = capability_for_config(&config("ollama", "qwen2.5:7b")).unwrap();
        assert!(capability
            .require(RequiredCapability::MediaUrlOutput)
            .unwrap_err()
            .contains("媒体 URL 输出"));

        // openai / aliyun etc. declare support, so the gate must let them
        // through.
        let openai = capability_for_config(&config("openai", "gpt-image-1")).unwrap();
        assert!(openai.require(RequiredCapability::MediaUrlOutput).is_ok());
    }

    #[test]
    fn media_provider_mapping_rejects_unsupported_capabilities_before_run() {
        let image = AiProviderConfig {
            provider: "anthropic".to_string(),
            model: "claude".to_string(),
            api_key: "key".to_string(),
            base_url: String::new(),
        };
        assert!(
            require_media_capability(&image, MediaCapability::ImageGeneration)
                .unwrap_err()
                .contains("未声明支持图片生成")
        );

        let tts = AiProviderConfig {
            provider: "elevenlabs".to_string(),
            model: "voice".to_string(),
            api_key: "key".to_string(),
            base_url: String::new(),
        };
        assert!(require_media_capability(&tts, MediaCapability::TtsGeneration).is_ok());
        assert!(require_media_capability(&tts, MediaCapability::MusicGeneration).is_err());
    }

    #[test]
    fn custom_media_capabilities_require_an_explicit_endpoint() {
        let mut custom = AiProviderConfig {
            provider: "custom".to_string(),
            model: "media-model".to_string(),
            api_key: "key".to_string(),
            base_url: String::new(),
        };

        for required in [
            MediaCapability::ImageGeneration,
            MediaCapability::TtsGeneration,
            MediaCapability::MusicGeneration,
        ] {
            let error = require_media_capability(&custom, required).unwrap_err();
            assert!(error.contains("Base URL"), "{required:?}: {error}");
        }

        custom.base_url = "https://media.example.test/v1".to_string();
        for required in [
            MediaCapability::ImageGeneration,
            MediaCapability::TtsGeneration,
            MediaCapability::MusicGeneration,
        ] {
            assert!(require_media_capability(&custom, required).is_ok());
        }
    }

    #[test]
    fn zero_deadline_message_points_users_at_the_omit_field_fix() {
        // The error for a 0 deadline must not just say "out of range" —
        // it should tell the user how to actually disable the timeout
        // (omit the field) so they do not silently end up with a clamped
        // default.
        let mut zero = config("custom", "model");
        zero.capabilities = Some(ProviderCapabilityDeclaration {
            flow_step_deadline_ms: Some(0),
            ..Default::default()
        });
        let error = capability_for_config(&zero).unwrap_err();
        assert!(error.contains("不能为 0"));
        assert!(error.contains("省略该字段"));
    }

    /// Regression for "running期间修改 Provider 配置后，新 Flow 使用新 deadline":
    /// two consecutive calls with different configs must each return the
    /// deadline the config describes, never a cached or singleton value.
    #[test]
    fn capability_re_reads_each_call_so_a_new_flow_sees_fresh_config() {
        let openai_deadline = capability_for_config(&config("openai", "gpt-4o-mini"))
            .unwrap()
            .flow_step_deadline_ms;
        let ollama_deadline = capability_for_config(&config("ollama", "qwen2.5:7b"))
            .unwrap()
            .flow_step_deadline_ms;
        assert!(ollama_deadline > openai_deadline);

        // Re-reading the original config still returns the original deadline;
        // the capability is not mutated by a call for a different config.
        let re_read = capability_for_config(&config("openai", "gpt-4o-mini"))
            .unwrap()
            .flow_step_deadline_ms;
        assert_eq!(re_read, openai_deadline);

        // A custom provider honors its explicit declaration; flipping the
        // value must change the resolved Flow deadline without restarting
        // the app.
        let mut declared = config("custom", "tool-model");
        declared.capabilities = Some(ProviderCapabilityDeclaration {
            flow_step_deadline_ms: Some(45_000),
            ..Default::default()
        });
        let custom = capability_for_config(&declared)
            .unwrap()
            .flow_step_deadline_ms;
        assert_eq!(custom, 45_000);
    }
}
