//! Unified request/response shapes for media generation.
//!
//! Every provider adaptor converts *from* these types into its own protocol
//! and *back* into [`GeneratedMedia`]. Callers (Tauri commands, the pipeline
//! executor, the asset queue) only ever see these, so adding or reworking a
//! provider cannot change what the rest of the app handles.

use serde::Serialize;

/// Generated media handed back to the frontend: base64 payload plus the
/// extension the bytes actually are (which is not always the requested
/// format — Qwen-TTS returns wav regardless of what was asked for).
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedMedia {
    pub base64_data: String,
    pub extension: String,
}

/// An input image for image-to-image generation. Only some providers accept
/// one; the rest ignore it rather than failing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageReference {
    pub mime: String,
    pub base64: String,
}

impl ImageReference {
    /// `data:<mime>;base64,<payload>` — the form Volcengine Seedream and
    /// several OpenAI-compatible gateways expect.
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, self.base64)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ImageRequest<'a> {
    pub model: &'a str,
    pub prompt: &'a str,
    pub reference: Option<&'a ImageReference>,
}

#[derive(Debug, Clone, Copy)]
pub struct TtsRequest<'a> {
    pub model: &'a str,
    pub text: &'a str,
    /// Free-text voice hint. Each adaptor maps it onto its own voice naming
    /// (an OpenAI voice name, an ElevenLabs voice id, a CosyVoice speaker…).
    pub voice_prompt: &'a str,
    /// Normalized container/codec, already passed through
    /// [`normalize_audio_format`].
    pub format: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct MusicRequest<'a> {
    pub model: &'a str,
    pub prompt: &'a str,
    pub format: &'a str,
}

/// Progress for long-running media jobs (currently DashScope's async image
/// task). Emitted on the `ai-media-generation-progress` Tauri event.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiMediaGenerationProgress {
    pub provider: String,
    pub model: String,
    pub phase: String,
    pub attempt: u8,
    pub total_attempts: u8,
    pub message: String,
}

/// Clamp a user-supplied audio format onto one we know how to name and store.
pub fn normalize_audio_format(value: &str) -> &'static str {
    match value
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "opus" => "opus",
        "aac" => "aac",
        "flac" => "flac",
        "wav" => "wav",
        "pcm" => "pcm",
        _ => "mp3",
    }
}

/// File extension for a response MIME type, falling back to the requested
/// format when the MIME is unknown or generic.
pub fn extension_from_mime(mime_type: &str, fallback: &str) -> String {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        _ => fallback,
    }
    .to_string()
}

/// Strip a `data:...;base64,` prefix if present. Providers are inconsistent
/// about whether they include one.
pub fn strip_data_url_prefix(value: &str) -> &str {
    value.split_once(',').map(|(_, data)| data).unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_format_falls_back_to_mp3_and_tolerates_dotted_input() {
        assert_eq!(normalize_audio_format(".WAV"), "wav");
        assert_eq!(normalize_audio_format("pcm"), "pcm");
        assert_eq!(normalize_audio_format("something-else"), "mp3");
    }

    #[test]
    fn extension_prefers_the_mime_then_the_requested_format() {
        assert_eq!(extension_from_mime("audio/wav", "mp3"), "wav");
        assert_eq!(extension_from_mime("application/octet-stream", "mp3"), "mp3");
    }

    #[test]
    fn data_url_prefix_is_stripped_only_when_present() {
        assert_eq!(strip_data_url_prefix("data:image/png;base64,QUJD"), "QUJD");
        assert_eq!(strip_data_url_prefix("QUJD"), "QUJD");
    }

    #[test]
    fn image_reference_renders_the_data_url_providers_expect() {
        let reference = ImageReference {
            mime: "image/png".to_string(),
            base64: "QUJD".to_string(),
        };
        assert_eq!(reference.data_url(), "data:image/png;base64,QUJD");
    }
}
