//! Provider adaptors and the dispatch that picks one.
//!
//! [`MediaAdaptor`] is the single extension point: a provider is wired up by
//! adding a variant and one arm per modality it serves. Dispatch is a plain
//! `match` rather than a trait object because the set of adaptors is fixed at
//! compile time — that keeps it zero-dependency (no `async-trait`) and lets
//! the compiler prove every variant handles every modality it claims.

pub mod dashscope;
pub mod elevenlabs;
pub mod gemini;
pub mod minimax;
pub mod openai;
pub mod sd_webui;
pub mod volcengine;

use super::types::{GeneratedMedia, ImageRequest, TtsRequest};
use super::MediaCtx;
use crate::ai::registry::Modality;

/// Which protocol implementation serves a given (provider, modality) pair.
/// Several providers map onto [`MediaAdaptor::OpenAiCompatible`] because they
/// expose the same dialect behind a different host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaAdaptor {
    OpenAiCompatible,
    DashScope,
    Gemini,
    MiniMax,
    SdWebUi,
    ElevenLabs,
    Volcengine,
}

/// Resolve the adaptor for a provider within a modality.
///
/// Returns `None` when the provider does not serve that modality at all. The
/// registry is the authority on *whether* a pairing is offered; this function
/// only says *which code* implements it, and a test asserts the two agree.
pub fn adaptor_for(provider: &str, modality: Modality) -> Option<MediaAdaptor> {
    let provider = provider.trim().to_ascii_lowercase();
    match (provider.as_str(), modality) {
        // Volcengine image generation is OpenAI-shaped (Seedream variant).
        ("openai" | "custom" | "volcengine", Modality::Image) => {
            Some(MediaAdaptor::OpenAiCompatible)
        }
        ("aliyun", Modality::Image) => Some(MediaAdaptor::DashScope),
        ("gemini", Modality::Image) => Some(MediaAdaptor::Gemini),
        ("minimax", Modality::Image) => Some(MediaAdaptor::MiniMax),
        ("sd-webui", Modality::Image) => Some(MediaAdaptor::SdWebUi),

        ("openai" | "custom", Modality::Tts) => Some(MediaAdaptor::OpenAiCompatible),
        ("elevenlabs", Modality::Tts) => Some(MediaAdaptor::ElevenLabs),
        ("aliyun", Modality::Tts) => Some(MediaAdaptor::DashScope),
        ("volcengine", Modality::Tts) => Some(MediaAdaptor::Volcengine),

        _ => None,
    }
}

fn supported_image_request<'a>(
    config: &crate::ai::config::AiProviderConfig,
    request: &ImageRequest<'a>,
) -> ImageRequest<'a> {
    ImageRequest {
        reference: request.reference.filter(|_| {
            crate::ai::provider_capability::supports_reference_image(
                &config.provider,
                request.model,
            )
        }),
        ..*request
    }
}

impl MediaAdaptor {
    pub async fn image(
        self,
        ctx: &MediaCtx<'_>,
        request: &ImageRequest<'_>,
    ) -> Result<GeneratedMedia, String> {
        // Capability discovery reports the soft warning. Unsupported providers
        // still generate from text rather than failing every expression variant.
        let request = supported_image_request(ctx.cfg, request);
        let request = &request;
        match self {
            MediaAdaptor::OpenAiCompatible => openai::generate_image(ctx.cfg, request).await,
            MediaAdaptor::DashScope => dashscope::generate_image(ctx, request).await,
            MediaAdaptor::Gemini => gemini::generate_image(ctx.cfg, request).await,
            MediaAdaptor::MiniMax => minimax::generate_image(ctx.cfg, request).await,
            MediaAdaptor::SdWebUi => sd_webui::generate_image(ctx.cfg, request).await,
            MediaAdaptor::ElevenLabs | MediaAdaptor::Volcengine => {
                Err(unsupported(ctx.cfg.provider.trim(), "图片生成"))
            }
        }
    }

    pub async fn tts(
        self,
        ctx: &MediaCtx<'_>,
        request: &TtsRequest<'_>,
    ) -> Result<GeneratedMedia, String> {
        match self {
            MediaAdaptor::OpenAiCompatible => openai::generate_tts(ctx.cfg, request).await,
            MediaAdaptor::DashScope => dashscope::generate_tts(ctx.cfg, request).await,
            MediaAdaptor::ElevenLabs => elevenlabs::generate_tts(ctx.cfg, request).await,
            MediaAdaptor::Volcengine => volcengine::generate_tts(ctx.cfg, request).await,
            MediaAdaptor::Gemini | MediaAdaptor::MiniMax | MediaAdaptor::SdWebUi => {
                Err(unsupported(ctx.cfg.provider.trim(), "语音生成"))
            }
        }
    }
}

fn unsupported(provider: &str, label: &str) -> String {
    format!("当前暂未适配 {provider} {label}接口，请使用 OpenAI 兼容 Base URL 或选择已适配供应商。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::registry;

    /// The registry decides what the settings UI offers; this table decides
    /// what actually runs. If they disagree, a user can pick a provider that
    /// fails at request time — which is exactly the drift this layer exists
    /// to prevent.
    #[test]
    fn every_registry_modality_has_an_adaptor() {
        for modality in [Modality::Image, Modality::Tts] {
            for option in registry::options_for(modality) {
                assert!(
                    adaptor_for(&option.value, modality).is_some(),
                    "{} is offered for {:?} but has no adaptor",
                    option.value,
                    modality
                );
            }
        }
    }

    /// And the reverse: an adaptor for a pairing the registry does not offer
    /// is dead code the UI can never reach.
    #[test]
    fn every_adaptor_pairing_is_offered_by_the_registry() {
        for modality in [Modality::Image, Modality::Tts] {
            let offered: Vec<String> = registry::options_for(modality)
                .into_iter()
                .map(|option| option.value)
                .collect();
            for spec in registry::PROVIDERS {
                if adaptor_for(spec.id, modality).is_some() {
                    assert!(
                        offered.iter().any(|id| id == spec.id),
                        "{} has an adaptor for {:?} but the registry does not offer it",
                        spec.id,
                        modality
                    );
                }
            }
        }
    }

    #[test]
    fn provider_lookup_ignores_case_and_whitespace() {
        assert_eq!(
            adaptor_for("  OpenAI  ", Modality::Image),
            Some(MediaAdaptor::OpenAiCompatible)
        );
    }

    #[test]
    fn unknown_pairings_resolve_to_nothing() {
        assert_eq!(adaptor_for("anthropic", Modality::Image), None);
        assert_eq!(adaptor_for("elevenlabs", Modality::Image), None);
    }
    #[test]
    fn unsupported_references_softly_fall_back_to_text_generation() {
        let reference = crate::ai::gateway::types::ImageReference {
            mime: "image/png".into(),
            base64: "QUJD".into(),
        };
        for (provider, model) in [
            ("aliyun", "wan2.2-t2i-plus"),
            ("openai", "gpt-image-1"),
            ("gemini", "imagen-3.0"),
            ("custom", "unknown-model"),
        ] {
            let cfg = crate::ai::config::AiProviderConfig {
                provider: provider.into(),
                ..Default::default()
            };
            let request = ImageRequest {
                model,
                prompt: "portrait",
                reference: Some(&reference),
                aspect_ratio: Some("3:4"),
            };
            let effective = supported_image_request(&cfg, &request);
            assert!(effective.reference.is_none(), "{provider}");
            assert_eq!(effective.prompt, request.prompt);
            assert_eq!(effective.aspect_ratio, request.aspect_ratio);
        }
    }
}
