//! Single source of truth for AI provider metadata.
//!
//! Before this table existed the same facts were spelled out in four places —
//! the frontend `*_PROVIDERS` presets, the chat capability match, the chat
//! default-endpoint match, and the media default-base match — and they had
//! already drifted apart (a provider selectable in one place was rejected by
//! another). Everything about "which providers exist, what they can do, and
//! where they live" now comes from here; `provider_capability`, the endpoint
//! resolver, and the settings UI all read this table instead of repeating it.
//!
//! A provider only appears in a modality list when the backend can actually
//! service that modality. Providers that exist solely to keep an older saved
//! config resolvable (`comfyui`, `edge-tts`) carry a capability entry but no
//! modality, so they never show up in a picker.

use serde::Serialize;

/// The four kinds of generation the app configures independently. Each has its
/// own saved config file and its own provider picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modality {
    Chat,
    Image,
    Tts,
    Music,
}

/// Chat-semantics capability flags. Media-only providers still carry these
/// because `download_generated_media` re-resolves a media config through the
/// chat capability table to gate `media_url_output`.
#[derive(Debug, Clone, Copy)]
pub struct CapabilitySpec {
    pub chat_tools: bool,
    pub json_mode: bool,
    pub streaming_cancellation: bool,
    pub media_url_output: bool,
    pub flow_step_deadline_ms: u64,
}

/// What one provider offers within one modality.
#[derive(Debug, Clone, Copy)]
pub struct ModalitySpec {
    /// Display name for this modality's picker (e.g. "OpenAI Images").
    pub label: &'static str,
    pub default_model: &'static str,
    pub models: &'static [&'static str],
    /// Built-in base URL used when the user leaves Base URL empty. Empty means
    /// there is no usable default and the user must supply one.
    pub default_base_url: &'static str,
    /// UI-only hint shown as the input placeholder. Never stored in the config,
    /// so an example address can never be saved and later rejected as a
    /// placeholder by the backend.
    pub base_url_placeholder: &'static str,
}

impl ModalitySpec {
    /// True when the user must type a Base URL because there is no built-in
    /// default to fall back on.
    pub fn needs_base_url(&self) -> bool {
        self.default_base_url.is_empty()
    }
}

pub struct ProviderSpec {
    pub id: &'static str,
    /// False for local services and OpenAI-compatible gateways that may be
    /// unauthenticated.
    pub requires_api_key: bool,
    pub capability: CapabilitySpec,
    pub chat: Option<ModalitySpec>,
    pub image: Option<ModalitySpec>,
    pub tts: Option<ModalitySpec>,
    pub music: Option<ModalitySpec>,
}

impl ProviderSpec {
    pub fn modality(&self, modality: Modality) -> Option<&ModalitySpec> {
        match modality {
            Modality::Chat => self.chat.as_ref(),
            Modality::Image => self.image.as_ref(),
            Modality::Tts => self.tts.as_ref(),
            Modality::Music => self.music.as_ref(),
        }
    }
}

const fn capability(
    chat_tools: bool,
    json_mode: bool,
    streaming_cancellation: bool,
    media_url_output: bool,
    flow_step_deadline_ms: u64,
) -> CapabilitySpec {
    CapabilitySpec {
        chat_tools,
        json_mode,
        streaming_cancellation,
        media_url_output,
        flow_step_deadline_ms,
    }
}

/// Hosted media providers: no chat/tools, but they do hand back media URLs.
const HOSTED_MEDIA: CapabilitySpec = capability(false, false, true, true, 600_000);
/// Locally hosted services: no media URLs, and generous deadlines because
/// consumer hardware is slow.
const LOCAL_MEDIA: CapabilitySpec = capability(false, false, false, false, 900_000);

const OPENAI_CHAT_MODELS: &[&str] = &[
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
    "gpt-4o-mini",
    "o3",
    "o4-mini",
];

const ANTHROPIC_CHAT_MODELS: &[&str] = &[
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
];

const GEMINI_CHAT_MODELS: &[&str] = &[
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
];

const DEEPSEEK_CHAT_MODELS: &[&str] = &[
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-chat",
    "deepseek-reasoner",
];

const GROQ_CHAT_MODELS: &[&str] = &[
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "groq/compound",
    "qwen-2.5-32b",
    "deepseek-r1-distill-llama-70b",
];

const XAI_CHAT_MODELS: &[&str] = &["grok-4.3", "grok-4.20", "grok-build-0.1"];

const COHERE_CHAT_MODELS: &[&str] = &["command-a-03-2025", "command-r-plus", "command-r"];

const OLLAMA_CHAT_MODELS: &[&str] = &[
    "qwen2.5:7b",
    "qwen2.5:14b",
    "qwen2.5:32b",
    "llama3.3:70b",
    "llama3.2:3b",
    "deepseek-r1:7b",
    "deepseek-r1:14b",
    "gemma2:9b",
    "mistral:7b",
    "phi4:14b",
];

const OPENAI_IMAGE_MODELS: &[&str] = &[
    "gpt-image-1",
    "gpt-image-1-mini",
    "gpt-image-1.5",
    "chatgpt-image-latest",
    "dall-e-3",
    "dall-e-2",
];

const GEMINI_IMAGE_MODELS: &[&str] = &[
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-2.5-flash-image",
    "nano-banana-pro-preview",
    "imagen-4.0-ultra-generate-001",
    "imagen-4.0-generate-001",
    "imagen-4.0-fast-generate-001",
];

const ALIYUN_IMAGE_MODELS: &[&str] = &[
    "wanx2.1-t2i-turbo",
    "wanx2.1-t2i-plus",
    "wanx2.1-imageedit",
    "wanx-v1",
    "wan2.2-t2i-flash",
    "wan2.2-t2i-plus",
    "wan2.5-t2i-preview",
    "wan2.6-t2i",
    "wan2.7-image",
    "wan2.7-image-pro",
    "qwen-image",
    "qwen-image-edit",
    "qwen-image-plus",
    "qwen-image-max",
    "qwen-image-2.0-pro",
    "z-image-turbo",
];

const VOLCENGINE_IMAGE_MODELS: &[&str] = &[
    "doubao-seedream-4-5-251128",
    "doubao-seedream-5-0-lite",
    "doubao-seedream-4-0-250828",
    "doubao-seededit-3-0-i2i-250628",
    "jimeng_high_aes_general_v21_L",
    "jimeng_high_aes_general_v20_L",
    "doubao-seedream-3-0-t2i-250415",
];

const ZHIPU_IMAGE_MODELS: &[&str] = &["cogview-3-flash", "cogview-3-plus", "cogview-4"];

const SILICONFLOW_IMAGE_MODELS: &[&str] = &[
    "Kwai-Kolors/Kolors",
    "black-forest-labs/FLUX.1-schnell",
    "black-forest-labs/FLUX.1-dev",
    "stabilityai/stable-diffusion-3-5-large",
    "stabilityai/stable-diffusion-xl-base-1.0",
    "Qwen/Qwen-Image",
    "Qwen/Qwen-Image-Edit",
];

const MIDJOURNEY_IMAGE_MODELS: &[&str] = &["midjourney", "niji"];

const SD_WEBUI_IMAGE_MODELS: &[&str] =
    &["local", "sdxl", "sd1.5", "sd3.5-large", "flux", "kolors"];

const OPENAI_TTS_MODELS: &[&str] = &[
    "gpt-4o-mini-tts",
    "gpt-4o-mini-tts-2025-03-20",
    "gpt-4o-mini-tts-2025-12-15",
    "tts-1",
    "tts-1-1106",
    "tts-1-hd",
    "tts-1-hd-1106",
];

const ELEVENLABS_TTS_MODELS: &[&str] = &[
    "eleven_v3",
    "eleven_multilingual_v2",
    "eleven_flash_v2_5",
    "eleven_flash_v2",
    "eleven_turbo_v2_5",
    "eleven_turbo_v2",
    "eleven_multilingual_sts_v2",
    "eleven_monolingual_v1",
];

const ALIYUN_TTS_MODELS: &[&str] = &[
    "cosyvoice-v2",
    "cosyvoice-v1",
    "cosyvoice-v3-flash",
    "cosyvoice-v3-plus",
    "qwen3-tts-flash",
    "qwen-tts",
    "qwen-tts-latest",
];

const VOLCENGINE_TTS_MODELS: &[&str] =
    &["seed-tts", "seed-tts-2.0", "mega-tts", "doubao-tts"];

const MUSIC_MODELS: &[&str] = &["music-1"];

const CUSTOM_CHAT_MODELS: &[&str] = &["gpt-4o-mini"];
const CUSTOM_IMAGE_MODELS: &[&str] = &["image-model"];
const CUSTOM_TTS_MODELS: &[&str] = &["tts-model"];

/// Every provider the backend knows about. Order is the display order in the
/// settings pickers.
pub const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "openai",
        requires_api_key: true,
        capability: capability(true, true, true, true, 180_000),
        chat: Some(ModalitySpec {
            label: "OpenAI",
            default_model: "gpt-5.5",
            models: OPENAI_CHAT_MODELS,
            default_base_url: "https://api.openai.com/v1/",
            base_url_placeholder: "(默认 https://api.openai.com/v1/)",
        }),
        image: Some(ModalitySpec {
            label: "OpenAI Images",
            default_model: "gpt-image-1",
            models: OPENAI_IMAGE_MODELS,
            default_base_url: "https://api.openai.com/v1",
            base_url_placeholder: "(默认 https://api.openai.com/v1)",
        }),
        tts: Some(ModalitySpec {
            label: "OpenAI TTS",
            default_model: "gpt-4o-mini-tts",
            models: OPENAI_TTS_MODELS,
            default_base_url: "https://api.openai.com/v1",
            base_url_placeholder: "(默认 https://api.openai.com/v1)",
        }),
        music: Some(ModalitySpec {
            label: "OpenAI 兼容",
            default_model: "music-1",
            models: MUSIC_MODELS,
            default_base_url: "https://api.openai.com/v1",
            base_url_placeholder: "(默认 https://api.openai.com/v1)",
        }),
    },
    ProviderSpec {
        id: "anthropic",
        requires_api_key: true,
        capability: capability(true, false, true, false, 180_000),
        chat: Some(ModalitySpec {
            label: "Anthropic",
            default_model: "claude-opus-4-8",
            models: ANTHROPIC_CHAT_MODELS,
            default_base_url: "https://api.anthropic.com/v1/",
            base_url_placeholder: "(默认 https://api.anthropic.com/v1/)",
        }),
        image: None,
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "gemini",
        requires_api_key: true,
        capability: capability(true, true, true, true, 180_000),
        chat: Some(ModalitySpec {
            label: "Gemini",
            default_model: "gemini-3.5-flash",
            models: GEMINI_CHAT_MODELS,
            default_base_url: "https://generativelanguage.googleapis.com/v1beta/",
            base_url_placeholder: "(默认 https://generativelanguage.googleapis.com/v1beta/)",
        }),
        image: Some(ModalitySpec {
            label: "Google Gemini / Imagen",
            default_model: "gemini-3-pro-image-preview",
            models: GEMINI_IMAGE_MODELS,
            default_base_url: "https://generativelanguage.googleapis.com/v1beta",
            base_url_placeholder: "(默认 https://generativelanguage.googleapis.com/v1beta)",
        }),
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "deepseek",
        requires_api_key: true,
        capability: capability(true, true, true, false, 180_000),
        chat: Some(ModalitySpec {
            label: "DeepSeek",
            default_model: "deepseek-v4-flash",
            models: DEEPSEEK_CHAT_MODELS,
            default_base_url: "https://api.deepseek.com/v1/",
            base_url_placeholder: "(默认 https://api.deepseek.com/v1/)",
        }),
        image: None,
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "groq",
        requires_api_key: true,
        capability: capability(true, true, true, false, 120_000),
        chat: Some(ModalitySpec {
            label: "Groq",
            default_model: "llama-3.3-70b-versatile",
            models: GROQ_CHAT_MODELS,
            default_base_url: "https://api.groq.com/openai/v1/",
            base_url_placeholder: "(默认 https://api.groq.com/openai/v1/)",
        }),
        image: None,
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "xai",
        requires_api_key: true,
        capability: capability(true, true, true, false, 120_000),
        chat: Some(ModalitySpec {
            label: "xAI",
            default_model: "grok-4.3",
            models: XAI_CHAT_MODELS,
            default_base_url: "https://api.x.ai/v1/",
            base_url_placeholder: "(默认 https://api.x.ai/v1/)",
        }),
        image: None,
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "cohere",
        requires_api_key: true,
        capability: capability(true, true, true, false, 120_000),
        chat: Some(ModalitySpec {
            label: "Cohere",
            default_model: "command-a-03-2025",
            models: COHERE_CHAT_MODELS,
            default_base_url: "https://api.cohere.com/v2/",
            base_url_placeholder: "(默认 https://api.cohere.com/v2/)",
        }),
        image: None,
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "ollama",
        requires_api_key: false,
        capability: capability(false, true, false, false, 600_000),
        chat: Some(ModalitySpec {
            label: "Ollama (本地)",
            default_model: "qwen2.5:7b",
            models: OLLAMA_CHAT_MODELS,
            default_base_url: "http://localhost:11434/v1/",
            base_url_placeholder: "(默认 http://localhost:11434/v1/)",
        }),
        image: None,
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "aliyun",
        requires_api_key: true,
        capability: HOSTED_MEDIA,
        chat: None,
        image: Some(ModalitySpec {
            label: "阿里云 DashScope / 通义万相",
            default_model: "wanx2.1-t2i-turbo",
            models: ALIYUN_IMAGE_MODELS,
            default_base_url: "https://dashscope.aliyuncs.com/api/v1",
            base_url_placeholder: "(默认 https://dashscope.aliyuncs.com/api/v1)",
        }),
        tts: Some(ModalitySpec {
            label: "阿里云 DashScope / CosyVoice",
            default_model: "cosyvoice-v2",
            models: ALIYUN_TTS_MODELS,
            default_base_url: "https://dashscope.aliyuncs.com/api/v1",
            base_url_placeholder: "(默认 https://dashscope.aliyuncs.com/api/v1)",
        }),
        music: None,
    },
    ProviderSpec {
        id: "volcengine",
        requires_api_key: true,
        capability: HOSTED_MEDIA,
        chat: None,
        image: Some(ModalitySpec {
            label: "火山引擎 / 即梦 / 豆包",
            default_model: "doubao-seedream-4-5-251128",
            models: VOLCENGINE_IMAGE_MODELS,
            default_base_url: "https://ark.cn-beijing.volces.com/api/v3",
            base_url_placeholder: "(默认 https://ark.cn-beijing.volces.com/api/v3)",
        }),
        tts: Some(ModalitySpec {
            label: "火山引擎 / 豆包语音",
            default_model: "seed-tts",
            models: VOLCENGINE_TTS_MODELS,
            default_base_url: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
            base_url_placeholder: "(默认 https://openspeech.bytedance.com/api/v3/tts/unidirectional)",
        }),
        music: None,
    },
    ProviderSpec {
        id: "zhipu",
        requires_api_key: true,
        capability: HOSTED_MEDIA,
        chat: None,
        image: Some(ModalitySpec {
            label: "智谱 CogView",
            default_model: "cogview-3-flash",
            models: ZHIPU_IMAGE_MODELS,
            default_base_url: "https://open.bigmodel.cn/api/paas/v4",
            base_url_placeholder: "(默认 https://open.bigmodel.cn/api/paas/v4)",
        }),
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "siliconflow",
        requires_api_key: true,
        capability: HOSTED_MEDIA,
        chat: None,
        image: Some(ModalitySpec {
            label: "SiliconFlow",
            default_model: "Kwai-Kolors/Kolors",
            models: SILICONFLOW_IMAGE_MODELS,
            default_base_url: "https://api.siliconflow.cn/v1",
            base_url_placeholder: "(默认 https://api.siliconflow.cn/v1)",
        }),
        tts: None,
        music: Some(ModalitySpec {
            label: "SiliconFlow",
            default_model: "music-1",
            models: MUSIC_MODELS,
            default_base_url: "https://api.siliconflow.cn/v1",
            base_url_placeholder: "(默认 https://api.siliconflow.cn/v1)",
        }),
    },
    ProviderSpec {
        id: "elevenlabs",
        requires_api_key: true,
        capability: HOSTED_MEDIA,
        chat: None,
        image: None,
        tts: Some(ModalitySpec {
            label: "ElevenLabs",
            default_model: "eleven_multilingual_v2",
            models: ELEVENLABS_TTS_MODELS,
            default_base_url: "https://api.elevenlabs.io",
            base_url_placeholder: "(默认 https://api.elevenlabs.io)",
        }),
        music: None,
    },
    ProviderSpec {
        id: "midjourney",
        requires_api_key: true,
        capability: HOSTED_MEDIA,
        chat: None,
        image: Some(ModalitySpec {
            label: "Midjourney Proxy (OpenAI 兼容)",
            default_model: "midjourney",
            models: MIDJOURNEY_IMAGE_MODELS,
            default_base_url: "",
            base_url_placeholder: "必填，Midjourney-Proxy 的 OpenAI 兼容端点",
        }),
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "sd-webui",
        requires_api_key: false,
        capability: LOCAL_MEDIA,
        chat: None,
        image: Some(ModalitySpec {
            label: "Stable Diffusion WebUI (本地)",
            default_model: "local",
            models: SD_WEBUI_IMAGE_MODELS,
            default_base_url: "http://127.0.0.1:7860",
            base_url_placeholder: "(默认 http://127.0.0.1:7860)",
        }),
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "custom",
        requires_api_key: false,
        capability: capability(false, false, false, false, 180_000),
        chat: Some(ModalitySpec {
            label: "自定义 (OpenAI 兼容)",
            default_model: "gpt-4o-mini",
            models: CUSTOM_CHAT_MODELS,
            default_base_url: "",
            base_url_placeholder: "必填，OpenAI 兼容端点（Moonshot/通义/本地 vLLM 等）",
        }),
        image: Some(ModalitySpec {
            label: "自定义",
            default_model: "image-model",
            models: CUSTOM_IMAGE_MODELS,
            default_base_url: "",
            base_url_placeholder: "必填，OpenAI 兼容的图片接口端点",
        }),
        tts: Some(ModalitySpec {
            label: "自定义",
            default_model: "tts-model",
            models: CUSTOM_TTS_MODELS,
            default_base_url: "",
            base_url_placeholder: "必填，OpenAI 兼容的语音接口端点",
        }),
        music: Some(ModalitySpec {
            label: "自定义 (OpenAI 兼容音乐端点)",
            default_model: "music-1",
            models: MUSIC_MODELS,
            default_base_url: "",
            base_url_placeholder: "必填，指向返回音频字节的音乐生成端点",
        }),
    },
    // Retired from every picker, kept resolvable so an older saved config
    // still loads and reports a useful error instead of "未知 AI 供应商".
    ProviderSpec {
        id: "comfyui",
        requires_api_key: false,
        capability: LOCAL_MEDIA,
        chat: None,
        image: None,
        tts: None,
        music: None,
    },
    ProviderSpec {
        id: "edge-tts",
        requires_api_key: false,
        capability: LOCAL_MEDIA,
        chat: None,
        image: None,
        tts: None,
        music: None,
    },
];

/// Look up a provider by id, tolerating surrounding whitespace and casing so a
/// hand-edited config file still resolves.
pub fn find(provider: &str) -> Option<&'static ProviderSpec> {
    let id = provider.trim();
    PROVIDERS
        .iter()
        .find(|spec| spec.id.eq_ignore_ascii_case(id))
}

/// The spec for `provider` within `modality`, or `None` when the provider is
/// unknown or does not serve that modality.
pub fn modality_spec(provider: &str, modality: Modality) -> Option<&'static ModalitySpec> {
    find(provider).and_then(|spec| spec.modality(modality))
}

/// Built-in base URL for `provider` in `modality`. `None` means the caller
/// must use the user-supplied Base URL.
pub fn default_base_url(provider: &str, modality: Modality) -> Option<&'static str> {
    modality_spec(provider, modality)
        .map(|spec| spec.default_base_url)
        .filter(|url| !url.is_empty())
}

/// Resolve the effective base URL: the user's Base URL when set, otherwise the
/// built-in default. Trailing slashes are preserved as authored because the
/// chat adapters expect the trailing form and the media resolver trims it.
pub fn resolve_base_url(
    provider: &str,
    modality: Modality,
    configured_base_url: &str,
) -> Option<String> {
    let configured = configured_base_url.trim();
    if !configured.is_empty() {
        return Some(configured.to_string());
    }
    default_base_url(provider, modality).map(str::to_string)
}

// ── Frontend catalog ───────────────────────────────────────────────────────

/// One selectable provider in a settings picker. Mirrors what the frontend
/// used to hard-code as `ProviderPreset`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOption {
    pub value: String,
    pub label: String,
    pub default_model: String,
    pub models: Vec<String>,
    pub default_base_url: String,
    pub base_url_placeholder: String,
    pub needs_base_url: bool,
    pub requires_api_key: bool,
}

/// The full set of pickers the settings dialog renders, one list per tab.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalog {
    pub chat: Vec<ProviderOption>,
    pub image: Vec<ProviderOption>,
    pub tts: Vec<ProviderOption>,
    pub music: Vec<ProviderOption>,
}

pub fn options_for(modality: Modality) -> Vec<ProviderOption> {
    PROVIDERS
        .iter()
        .filter_map(|provider| {
            let spec = provider.modality(modality)?;
            Some(ProviderOption {
                value: provider.id.to_string(),
                label: spec.label.to_string(),
                default_model: spec.default_model.to_string(),
                models: spec.models.iter().map(|m| m.to_string()).collect(),
                default_base_url: spec.default_base_url.to_string(),
                base_url_placeholder: spec.base_url_placeholder.to_string(),
                needs_base_url: spec.needs_base_url(),
                requires_api_key: provider.requires_api_key,
            })
        })
        .collect()
}

pub fn catalog() -> ProviderCatalog {
    ProviderCatalog {
        chat: options_for(Modality::Chat),
        image: options_for(Modality::Image),
        tts: options_for(Modality::Tts),
        music: options_for(Modality::Music),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_unique() {
        let mut ids: Vec<&str> = PROVIDERS.iter().map(|spec| spec.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "duplicate provider id in PROVIDERS");
    }

    #[test]
    fn every_modality_entry_offers_its_default_model() {
        for provider in PROVIDERS {
            for modality in [
                Modality::Chat,
                Modality::Image,
                Modality::Tts,
                Modality::Music,
            ] {
                let Some(spec) = provider.modality(modality) else {
                    continue;
                };
                assert!(
                    !spec.default_model.is_empty(),
                    "{} has an empty default model",
                    provider.id
                );
                assert!(
                    spec.models.contains(&spec.default_model),
                    "{} default model {} is missing from its model list",
                    provider.id,
                    spec.default_model
                );
            }
        }
    }

    /// A provider that needs a Base URL must explain what to type, and one
    /// with a built-in default must not claim it is required.
    #[test]
    fn base_url_requirement_matches_the_built_in_default() {
        for provider in PROVIDERS {
            for modality in [
                Modality::Chat,
                Modality::Image,
                Modality::Tts,
                Modality::Music,
            ] {
                let Some(spec) = provider.modality(modality) else {
                    continue;
                };
                assert!(
                    !spec.base_url_placeholder.is_empty(),
                    "{} has no Base URL placeholder",
                    provider.id
                );
                assert_eq!(
                    spec.needs_base_url(),
                    spec.default_base_url.is_empty(),
                    "{} disagrees about whether Base URL is required",
                    provider.id
                );
            }
        }
    }

    /// Placeholders are UI hints only. If one ever leaked into a saved config
    /// the backend would reject it as an example address, so no placeholder
    /// may look like the `api.example.com` sentinel.
    #[test]
    fn placeholders_never_contain_the_rejected_example_host() {
        for provider in PROVIDERS {
            for modality in [
                Modality::Chat,
                Modality::Image,
                Modality::Tts,
                Modality::Music,
            ] {
                let Some(spec) = provider.modality(modality) else {
                    continue;
                };
                assert!(
                    !spec.base_url_placeholder.contains("api.example.com"),
                    "{} placeholder still uses the rejected example host",
                    provider.id
                );
            }
        }
    }

    #[test]
    fn resolve_base_url_prefers_the_user_value_then_the_default() {
        assert_eq!(
            resolve_base_url("aliyun", Modality::Image, "  "),
            Some("https://dashscope.aliyuncs.com/api/v1".to_string()),
        );
        assert_eq!(
            resolve_base_url("aliyun", Modality::Image, " https://proxy.test/v1 "),
            Some("https://proxy.test/v1".to_string()),
        );
        // `custom` has no built-in default, so an empty value stays unresolved.
        assert_eq!(resolve_base_url("custom", Modality::Image, ""), None);
    }

    #[test]
    fn retired_providers_resolve_but_are_never_selectable() {
        for retired in ["comfyui", "edge-tts"] {
            assert!(
                find(retired).is_some(),
                "{retired} must stay resolvable for older saved configs"
            );
            for modality in [
                Modality::Chat,
                Modality::Image,
                Modality::Tts,
                Modality::Music,
            ] {
                assert!(
                    modality_spec(retired, modality).is_none(),
                    "{retired} must not appear in any picker"
                );
            }
        }
    }

    #[test]
    fn catalog_lists_every_provider_that_serves_the_modality() {
        let catalog = catalog();
        let chat_ids: Vec<&str> = catalog.chat.iter().map(|o| o.value.as_str()).collect();
        assert!(chat_ids.contains(&"cohere"), "cohere must be selectable");
        let image_ids: Vec<&str> = catalog.image.iter().map(|o| o.value.as_str()).collect();
        assert!(
            image_ids.contains(&"midjourney"),
            "midjourney must be selectable"
        );
        assert!(!catalog.tts.is_empty());
        assert!(!catalog.music.is_empty());
    }
}
