//! In-process media gateway: one entry point per modality, one adaptor per
//! provider protocol.
//!
//! # Layering
//!
//! ```text
//! Tauri command / pipeline
//!         ↓  unified request DTO (types.rs)
//!     gateway::generate_*        ← validation + provider resolution
//!         ↓
//!     adaptors::MediaAdaptor     ← protocol conversion only
//!         ↓  transport.rs        ← one client, one timeout, one URL resolver
//!     provider
//! ```
//!
//! Adaptors convert protocols and nothing else. Logging, secret redaction,
//! and the SSRF-guarded download of provider-returned URLs stay with the host
//! (`ai::commands`) and are called into, mirroring how new-api keeps its
//! `relaykit` conversion module free of transport, auth, and persistence.
//!
//! Provider selection is not part of this layer: which provider serves a
//! modality is declared once in [`crate::ai::registry`], and
//! [`adaptors::adaptor_for`] only says which code implements that pairing.

pub mod adaptors;
pub mod transport;
pub mod types;

use tauri::{AppHandle, Emitter};

use crate::ai::config::{self, AiProviderConfig};
use crate::ai::provider_capability::{require_media_capability, MediaCapability};
use crate::ai::registry::Modality;
use adaptors::adaptor_for;
use types::{
    AiMediaGenerationProgress, GeneratedMedia, ImageReference, ImageRequest, MusicRequest,
    TtsRequest,
};

/// Everything an adaptor needs beyond its request: the resolved provider
/// config, and an optional app handle for progress events. Long-running jobs
/// invoked outside a Tauri command (tests, background pipeline steps) simply
/// pass `None` and emit nothing.
pub struct MediaCtx<'a> {
    pub cfg: &'a AiProviderConfig,
    pub app_handle: Option<&'a AppHandle>,
}

pub fn emit_media_generation_progress(
    ctx: &MediaCtx<'_>,
    model: &str,
    phase: &str,
    attempt: u8,
    total_attempts: u8,
    message: &str,
) {
    let Some(app_handle) = ctx.app_handle else {
        return;
    };
    let _ = app_handle.emit(
        "ai-media-generation-progress",
        AiMediaGenerationProgress {
            provider: ctx.cfg.provider.clone(),
            model: model.to_string(),
            phase: phase.to_string(),
            attempt,
            total_attempts,
            message: message.to_string(),
        },
    );
}

/// Generate an image with the saved image provider.
pub async fn generate_image(
    app_handle: Option<&AppHandle>,
    prompt: &str,
    model: &str,
    reference: Option<&ImageReference>,
) -> Result<GeneratedMedia, String> {
    let cfg = config::load_image_config();
    let model = prepare(&cfg, model, prompt, Modality::Image, "图片", "图片生成描述")?;
    let ctx = MediaCtx {
        cfg: &cfg,
        app_handle,
    };
    let request = ImageRequest {
        model: &model,
        prompt,
        reference,
    };
    resolve(&cfg, Modality::Image)?.image(&ctx, &request).await
}

/// Synthesize speech with the saved TTS provider.
pub async fn generate_tts(
    text: &str,
    voice_prompt: &str,
    model: &str,
    format: &str,
) -> Result<GeneratedMedia, String> {
    let cfg = config::load_tts_config();
    let model = prepare(&cfg, model, text, Modality::Tts, "音频", "语音文本")?;
    let ctx = MediaCtx {
        cfg: &cfg,
        app_handle: None,
    };
    let request = TtsRequest {
        model: &model,
        text,
        voice_prompt,
        format: types::normalize_audio_format(format),
    };
    resolve(&cfg, Modality::Tts)?.tts(&ctx, &request).await
}

/// Generate background music with the saved music provider.
pub async fn generate_music(
    prompt: &str,
    model: &str,
    format: &str,
) -> Result<GeneratedMedia, String> {
    let cfg = config::load_music_config();
    let model = prepare(
        &cfg,
        model,
        prompt,
        Modality::Music,
        "音乐",
        "音乐生成描述",
    )?;
    let ctx = MediaCtx {
        cfg: &cfg,
        app_handle: None,
    };
    let request = MusicRequest {
        model: &model,
        prompt,
        format: types::normalize_audio_format(format),
    };
    resolve(&cfg, Modality::Music)?.music(&ctx, &request).await
}

/// Reusable TTS entry for callers that already hold a config and want to
/// generate many clips without re-reading it from disk on every item.
pub async fn generate_tts_with(
    cfg: &AiProviderConfig,
    text: &str,
    voice_prompt: &str,
    model: &str,
    format: &str,
) -> Result<GeneratedMedia, String> {
    let ctx = MediaCtx {
        cfg,
        app_handle: None,
    };
    let request = TtsRequest {
        model,
        text,
        voice_prompt,
        format: types::normalize_audio_format(format),
    };
    resolve(cfg, Modality::Tts)?.tts(&ctx, &request).await
}

/// Validate the config and inputs that every modality shares, returning the
/// trimmed model name. Failing here keeps a misconfiguration from reaching
/// the network as a half-built request.
fn prepare(
    cfg: &AiProviderConfig,
    model: &str,
    input: &str,
    modality: Modality,
    capability_label: &str,
    input_label: &str,
) -> Result<String, String> {
    crate::ai::commands::validate_provider_config_basics(cfg, capability_label)?;
    require_media_capability(cfg, media_capability(modality))?;
    let model = model.trim();
    if model.is_empty() {
        return Err(format!("尚未选择{capability_label}生成模型"));
    }
    if input.trim().is_empty() {
        return Err(format!("{input_label}为空"));
    }
    Ok(model.to_string())
}

fn media_capability(modality: Modality) -> MediaCapability {
    match modality {
        Modality::Image => MediaCapability::ImageGeneration,
        Modality::Tts => MediaCapability::TtsGeneration,
        Modality::Music => MediaCapability::MusicGeneration,
        Modality::Chat => unreachable!("chat does not route through the media gateway"),
    }
}

/// `require_media_capability` already rejected providers the registry does not
/// offer, so a missing adaptor here means the registry and the dispatch table
/// disagree — which a test asserts can never happen.
fn resolve(
    cfg: &AiProviderConfig,
    modality: Modality,
) -> Result<adaptors::MediaAdaptor, String> {
    adaptor_for(&cfg.provider, modality).ok_or_else(|| {
        format!(
            "当前暂未适配 {} 的该生成接口，请使用 OpenAI 兼容 Base URL 或选择已适配供应商。",
            cfg.provider.trim()
        )
    })
}
