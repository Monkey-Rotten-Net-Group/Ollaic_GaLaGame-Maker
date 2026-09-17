//! ElevenLabs TTS adaptor.
//!
//! The voice is part of the URL rather than the body, authentication uses
//! `xi-api-key`, and the output format is a compound name (codec + sample
//! rate + bitrate) instead of a bare container.

use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{http_client, resolved_base_url, response_to_generated_media};
use crate::ai::gateway::types::{GeneratedMedia, TtsRequest};
use crate::ai::registry::Modality;

/// Rachel — ElevenLabs' default public voice, used when the prompt carries no
/// recognizable voice id.
const DEFAULT_VOICE_ID: &str = "21m00Tcm4TlvDq8ikWAM";

pub async fn generate_tts(
    cfg: &AiProviderConfig,
    request: &TtsRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let voice_id = voice_id_from_prompt(request.voice_prompt);
    let endpoint = endpoint_for(cfg, &voice_id);
    let body = serde_json::json!({
        "text": request.text,
        "model_id": request.model,
        "output_format": output_format(request.format)
    });
    let body =
        serde_json::to_string(&body).map_err(|e| format!("序列化 ElevenLabs 请求失败: {e}"))?;
    let response = http_client()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("xi-api-key", cfg.api_key.trim())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs 音频生成请求失败: {e}"))?;
    response_to_generated_media(
        response,
        cfg,
        request.model,
        &endpoint,
        request.format,
        "tts_generate",
    )
    .await
}

/// A Base URL already pointing at a `/text-to-speech/` path is used verbatim
/// (the user pinned a specific voice); otherwise the voice is appended.
fn endpoint_for(cfg: &AiProviderConfig, voice_id: &str) -> String {
    let base = resolved_base_url(&cfg.provider, Modality::Tts, &cfg.base_url);
    let base = base.trim_end_matches('/');
    if base.contains("/text-to-speech/") {
        base.to_string()
    } else {
        format!("{base}/v1/text-to-speech/{voice_id}")
    }
}

fn output_format(format: &str) -> &'static str {
    match format {
        "pcm" | "wav" => "pcm_44100",
        _ => "mp3_44100_128",
    }
}

/// Pull an ElevenLabs voice id out of a free-text voice prompt. Ids are long
/// alphanumeric tokens, so anything shorter is prose and gets skipped.
fn voice_id_from_prompt(value: &str) -> String {
    for token in
        value.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '，' || c == '；')
    {
        let token = token.trim();
        if token.len() >= 16
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return token.to_string();
        }
    }
    DEFAULT_VOICE_ID.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(base_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: "elevenlabs".to_string(),
            model: "eleven_multilingual_v2".to_string(),
            api_key: "key".to_string(),
            base_url: base_url.to_string(),
        }
    }

    #[test]
    fn voice_id_is_extracted_from_prose_or_falls_back() {
        assert_eq!(
            voice_id_from_prompt("温柔女声 21m00Tcm4TlvDq8ikWAM"),
            "21m00Tcm4TlvDq8ikWAM"
        );
        assert_eq!(voice_id_from_prompt("温柔女声"), DEFAULT_VOICE_ID);
    }

    #[test]
    fn default_endpoint_appends_the_voice_path() {
        assert_eq!(
            endpoint_for(&cfg(""), "abc"),
            "https://api.elevenlabs.io/v1/text-to-speech/abc"
        );
    }

    /// A Base URL that already names a voice must be left alone, or the path
    /// would be appended twice and 404.
    #[test]
    fn pinned_voice_endpoint_is_used_verbatim() {
        let pinned = "https://api.elevenlabs.io/v1/text-to-speech/pinned";
        assert_eq!(endpoint_for(&cfg(pinned), "abc"), pinned);
    }

    #[test]
    fn wav_and_pcm_both_request_raw_pcm() {
        assert_eq!(output_format("wav"), "pcm_44100");
        assert_eq!(output_format("pcm"), "pcm_44100");
        assert_eq!(output_format("mp3"), "mp3_44100_128");
    }
}
