//! Built-in mood audio fallback pack.
//!
//! Provides lightweight, royalty-free synthesized ambient audio clips for six
//! standard Galgame scene moods (Daily, Mystery, Tension, Warm, Sad, Climax).
//! When a project does not have user-imported audio and AI audio generation is
//! unavailable or local fallback is active, these clips ensure that the exported
//! WebGAL game always has complete, playable background music and soundscapes.

use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioMood {
    Daily,
    Mystery,
    Tension,
    Warm,
    Sad,
    Climax,
}

impl AudioMood {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            AudioMood::Daily => "daily",
            AudioMood::Mystery => "mystery",
            AudioMood::Tension => "tension",
            AudioMood::Warm => "warm",
            AudioMood::Sad => "sad",
            AudioMood::Climax => "climax",
        }
    }

    #[allow(dead_code)]
    pub fn default_filename(&self) -> &'static str {
        match self {
            AudioMood::Daily => "bgm_mood_daily.wav",
            AudioMood::Mystery => "bgm_mood_mystery.wav",
            AudioMood::Tension => "bgm_mood_tension.wav",
            AudioMood::Warm => "bgm_mood_warm.wav",
            AudioMood::Sad => "bgm_mood_sad.wav",
            AudioMood::Climax => "bgm_mood_climax.wav",
        }
    }

    pub fn audio_bytes(&self) -> &'static [u8] {
        match self {
            AudioMood::Daily => &DAILY_WAV,
            AudioMood::Mystery => &MYSTERY_WAV,
            AudioMood::Tension => &TENSION_WAV,
            AudioMood::Warm => &WARM_WAV,
            AudioMood::Sad => &SAD_WAV,
            AudioMood::Climax => &CLIMAX_WAV,
        }
    }
}

/// Detect the best fitting audio mood from scene prompt, emotional arc, or target stem.
pub fn detect_audio_mood(text: &str) -> AudioMood {
    let lower = text.to_lowercase();

    // Check for high-intensity climax keywords first
    if lower.contains("climax")
        || lower.contains("决意")
        || lower.contains("决战")
        || lower.contains("高潮")
        || lower.contains("逆转")
        || lower.contains("激昂")
        || lower.contains("终章")
    {
        return AudioMood::Climax;
    }

    // Tension / conflict
    if lower.contains("tension")
        || lower.contains("紧张")
        || lower.contains("对峙")
        || lower.contains("危机")
        || lower.contains("冲突")
        || lower.contains("危险")
        || lower.contains("压迫")
        || lower.contains("紧迫")
    {
        return AudioMood::Tension;
    }

    // Mystery / investigation / suspense
    if lower.contains("mystery")
        || lower.contains("suspense")
        || lower.contains("悬疑")
        || lower.contains("探案")
        || lower.contains("调查")
        || lower.contains("秘密")
        || lower.contains("迷雾")
        || lower.contains("谜团")
        || lower.contains("困惑")
    {
        return AudioMood::Mystery;
    }

    // Sad / melancholy / sorrow
    if lower.contains("sad")
        || lower.contains("sorrow")
        || lower.contains("哀伤")
        || lower.contains("悲伤")
        || lower.contains("失落")
        || lower.contains("离别")
        || lower.contains("哭泣")
        || lower.contains("遗憾")
        || lower.contains("忧伤")
    {
        return AudioMood::Sad;
    }

    // Warm / healing / affectionate
    if lower.contains("warm")
        || lower.contains("healing")
        || lower.contains("温馨")
        || lower.contains("温柔")
        || lower.contains("治愈")
        || lower.contains("感动")
        || lower.contains("深情")
        || lower.contains("心意")
        || lower.contains("关怀")
    {
        return AudioMood::Warm;
    }

    // Default to gentle daily atmosphere
    AudioMood::Daily
}

const SAMPLE_RATE: u32 = 16_000;
const DURATION_SECS: f32 = 1.5;

static DAILY_WAV: LazyLock<Vec<u8>> = LazyLock::new(|| {
    synthesize_wav(
        &[(261.63, 0.4), (329.63, 0.3), (392.00, 0.3), (523.25, 0.2)],
        0.05,
        1.2,
    )
});

static MYSTERY_WAV: LazyLock<Vec<u8>> =
    LazyLock::new(|| synthesize_wav(&[(293.66, 0.4), (349.23, 0.35), (415.30, 0.3)], 0.1, 1.0));

static TENSION_WAV: LazyLock<Vec<u8>> =
    LazyLock::new(|| synthesize_wav(&[(110.00, 0.6), (116.54, 0.5), (233.08, 0.3)], 0.02, 0.8));

static WARM_WAV: LazyLock<Vec<u8>> = LazyLock::new(|| {
    synthesize_wav(
        &[(349.23, 0.35), (440.00, 0.3), (523.25, 0.25), (659.25, 0.2)],
        0.2,
        1.1,
    )
});

static SAD_WAV: LazyLock<Vec<u8>> =
    LazyLock::new(|| synthesize_wav(&[(220.00, 0.45), (261.63, 0.35), (329.63, 0.3)], 0.15, 1.2));

static CLIMAX_WAV: LazyLock<Vec<u8>> = LazyLock::new(|| {
    synthesize_wav(
        &[(293.66, 0.4), (440.00, 0.35), (587.33, 0.3), (739.99, 0.25)],
        0.04,
        1.3,
    )
});

fn synthesize_wav(freqs: &[(f32, f32)], attack_secs: f32, decay_secs: f32) -> Vec<u8> {
    let total_samples = (SAMPLE_RATE as f32 * DURATION_SECS) as usize;
    let mut samples = Vec::with_capacity(total_samples);

    for i in 0..total_samples {
        let t = i as f32 / SAMPLE_RATE as f32;
        let envelope = if t < attack_secs {
            t / attack_secs
        } else {
            let decay_progress = (t - attack_secs) / (decay_secs.max(0.1));
            (-2.5 * decay_progress).exp().max(0.0)
        };

        let mut signal = 0.0f32;
        for &(freq, weight) in freqs {
            signal += (2.0 * std::f32::consts::PI * freq * t).sin() * weight;
        }

        let amplitude = (signal * envelope * 24_000.0).clamp(-32_000.0, 32_000.0);
        samples.push(amplitude as i16);
    }

    encode_pcm_wav(SAMPLE_RATE, &samples)
}

fn encode_pcm_wav(sample_rate: u32, samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let riff_len = data_len + 36;
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);

    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_len.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size
    bytes.extend_from_slice(&1u16.to_le_bytes()); // AudioFormat (PCM)
    bytes.extend_from_slice(&1u16.to_le_bytes()); // NumChannels (mono)
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * 2;
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes()); // BlockAlign
    bytes.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());

    for &sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }

    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_mood_detects_keywords_correctly() {
        assert_eq!(detect_audio_mood("天台黄昏的日常对话"), AudioMood::Daily);
        assert_eq!(
            detect_audio_mood("旧校舍调查与悬疑谜团"),
            AudioMood::Mystery
        );
        assert_eq!(
            detect_audio_mood("突然的武装对峙与紧急冲突"),
            AudioMood::Tension
        );
        assert_eq!(
            detect_audio_mood("互相敞开心扉的温馨治愈时光"),
            AudioMood::Warm
        );
        assert_eq!(detect_audio_mood("不可挽回的离别与哀伤"), AudioMood::Sad);
        assert_eq!(detect_audio_mood("最终决意的逆转高潮"), AudioMood::Climax);

        assert_eq!(AudioMood::Daily.as_str(), "daily");
        assert_eq!(AudioMood::Daily.default_filename(), "bgm_mood_daily.wav");
    }

    #[test]
    fn mood_wav_has_valid_riff_header() {
        let bytes = AudioMood::Daily.audio_bytes();
        assert!(bytes.len() > 44);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[12..16], b"fmt ");
        assert_eq!(&bytes[36..40], b"data");
    }
}
