use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_DIR: &str = "ollaic";
const CONFIG_FILE: &str = "ai.json";
const IMAGE_CONFIG_FILE: &str = "ai-image.json";
const TTS_CONFIG_FILE: &str = "ai-tts.json";
/// Per-provider credentials and model pools, so switching provider in the
/// settings restores that provider's own Key instead of carrying the
/// previous one over. The active config files above stay the source of truth
/// for what is in use; this file only remembers the other providers.
const PROFILES_FILE: &str = "ai-profiles.json";
const LOG_FILE: &str = "ai-log.jsonl";
const AGENT_TRACE_FILE: &str = "ai-agent-trace.jsonl";

fn empty_model_pool() -> Vec<String> {
    Vec::new()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProviderCapabilityDeclaration {
    pub chat_tools: bool,
    pub json_mode: bool,
    pub streaming_cancellation: bool,
    pub media_url_output: bool,
    pub chat_deadline_ms: Option<u64>,
    pub flow_step_deadline_ms: Option<u64>,
    pub media_fetch_deadline_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    pub provider: String,
    pub model: String,
    #[serde(default = "empty_model_pool")]
    pub models: Vec<String>,
    pub api_key: String,
    pub base_url: String,
    /// Optional user declaration of capabilities for the `custom` provider.
    /// When absent, `provider_capability::from_custom` returns conservative
    /// defaults so legacy configs keep working.
    pub capabilities: Option<ProviderCapabilityDeclaration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiProviderConfig {
    pub provider: String,
    pub model: String,
    #[serde(default = "empty_model_pool")]
    pub models: Vec<String>,
    pub api_key: String,
    pub base_url: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "openai".into(),
            model: "gpt-5.5".into(),
            models: vec!["gpt-5.5".into()],
            api_key: String::new(),
            base_url: String::new(),
            capabilities: None,
        }
    }
}

impl AiProviderConfig {
    fn image_default() -> Self {
        Self {
            provider: "openai".into(),
            model: "gpt-image-2.5-flare".into(),
            models: vec!["gpt-image-2.5-flare".into()],
            api_key: String::new(),
            base_url: String::new(),
        }
    }

    fn tts_default() -> Self {
        Self {
            provider: "openai".into(),
            model: "gpt-4o-mini-tts".into(),
            models: vec!["gpt-4o-mini-tts".into()],
            api_key: String::new(),
            base_url: String::new(),
        }
    }
}

impl Default for AiProviderConfig {
    fn default() -> Self {
        Self::image_default()
    }
}

/// What is remembered for one provider within one modality.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct ProviderProfile {
    pub model: String,
    pub models: Vec<String>,
    pub api_key: String,
    pub base_url: String,
}

/// Remembered profiles keyed by lower-cased provider id, one map per modality.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct ProviderProfiles {
    pub chat: BTreeMap<String, ProviderProfile>,
    pub image: BTreeMap<String, ProviderProfile>,
    pub tts: BTreeMap<String, ProviderProfile>,
}

#[derive(Debug, Clone, Copy)]
pub enum ProfileKind {
    Chat,
    Image,
    Tts,
}

impl ProviderProfiles {
    fn map_mut(&mut self, kind: ProfileKind) -> &mut BTreeMap<String, ProviderProfile> {
        match kind {
            ProfileKind::Chat => &mut self.chat,
            ProfileKind::Image => &mut self.image,
            ProfileKind::Tts => &mut self.tts,
        }
    }

    /// Record `profile` as the latest for `provider`. An empty provider id is
    /// ignored so a half-filled form cannot create a nameless entry.
    pub fn remember(&mut self, kind: ProfileKind, provider: &str, profile: ProviderProfile) {
        let key = provider.trim().to_ascii_lowercase();
        if !key.is_empty() {
            self.map_mut(kind).insert(key, profile);
        }
    }
}

fn profile_of(model: &str, models: &[String], api_key: &str, base_url: &str) -> ProviderProfile {
    ProviderProfile {
        model: model.to_string(),
        models: models.to_vec(),
        api_key: api_key.to_string(),
        base_url: base_url.to_string(),
    }
}

/// Remembered profiles with the three active configs laid over them, so the
/// provider in use always reports what is actually saved, and a config
/// written before the profiles file existed is still remembered.
pub fn load_profiles() -> ProviderProfiles {
    let mut profiles = config_path(PROFILES_FILE)
        .map(|path| read_profiles_at(&path))
        .unwrap_or_default();
    let chat = load_config();
    profiles.remember(
        ProfileKind::Chat,
        &chat.provider,
        profile_of(&chat.model, &chat.models, &chat.api_key, &chat.base_url),
    );
    for (kind, media) in [
        (ProfileKind::Image, load_image_config()),
        (ProfileKind::Tts, load_tts_config()),
    ] {
        profiles.remember(
            kind,
            &media.provider,
            profile_of(&media.model, &media.models, &media.api_key, &media.base_url),
        );
    }
    profiles
}

fn read_profiles_at(path: &Path) -> ProviderProfiles {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Remember the profile of the provider just saved. Runs after the active
/// config is written, so a failure here never loses the active config.
fn remember_saved_profile(
    kind: ProfileKind,
    provider: &str,
    profile: ProviderProfile,
) -> Result<(), String> {
    let path = config_path(PROFILES_FILE)
        .ok_or_else(|| "Unable to locate user config directory".to_string())?;
    remember_profile_at(&path, kind, provider, profile)
}

fn remember_profile_at(
    path: &Path,
    kind: ProfileKind,
    provider: &str,
    profile: ProviderProfile,
) -> Result<(), String> {
    let mut profiles = read_profiles_at(path);
    profiles.remember(kind, provider, profile);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Failed to write provider profiles: {e}"))
}

pub fn default_system_prompt() -> String {
    r##"You are a WebGAL story editing assistant.

The frontend provides the current scene, numbered script lines, available assets, characters, and project memory in system messages. Follow those higher-detail instructions exactly.

Core output protocol:
- When editing the script, output one JSON object: {"patches":[...]}.
- When only discussing the story, output one JSON object: {"type":"chat","message":"..."}.
- Do not use Markdown fences.
- Do not claim that files have already been changed. The app will preview changes and the user decides whether to apply them.

Patch rules:
- Supported patch types: insert, delete, replace.
- Patch file must be the current scene file.
- Line numbers refer to the numbered WebGAL txt script supplied by the app.
- Include anchorText when possible by copying the target original line exactly.
- insert.afterLine can be a positive line number or "end".
- delete/replace require startLine <= endLine.
- For insert/replace, text is raw WebGAL txt, with one command per line.

WebGAL txt reminders:
- Narration: :text;
- Dialogue: Character:text;
- Comment: ;comment text
- Background: changeBg:file -next;
- Figure: changeFigure:file -left/-right/-center -next;
- BGM: bgm:file;
- Sound effect: playEffect:file;
- Choice: choose:Label A:sceneA.txt|Label B:sceneB.txt;
- Scene jump: changeScene:scene.txt;

Use only asset filenames listed by the app. If a required asset is missing, return chat explaining the missing asset instead of inventing a filename.
"##
    .to_string()
}

/// Directory holding every AI config and log file.
///
/// `OLLAIC_CONFIG_DIR` overrides the per-user location so headless callers —
/// the `agent-harness` CLI, CI — can point at a throwaway profile instead of
/// reading (or clobbering) the desktop app's saved settings.
pub fn config_root() -> Option<PathBuf> {
    match std::env::var("OLLAIC_CONFIG_DIR") {
        Ok(dir) if !dir.trim().is_empty() => Some(PathBuf::from(dir.trim())),
        _ => Some(dirs::config_dir()?.join(CONFIG_DIR)),
    }
}

fn config_path(file_name: &str) -> Option<PathBuf> {
    Some(config_root()?.join(file_name))
}

pub fn load_config() -> AiConfig {
    let Some(path) = config_path(CONFIG_FILE) else {
        return AiConfig::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return AiConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_config(config: &AiConfig) -> Result<(), String> {
    save_active_config(config)?;
    remember_saved_profile(
        ProfileKind::Chat,
        &config.provider,
        profile_of(
            &config.model,
            &config.models,
            &config.api_key,
            &config.base_url,
        ),
    )
}

/// Write the active chat config without remembering it as a provider
/// profile. For callers that stage a temporary override and restore it
/// afterwards, which must not leave the override behind in the profiles.
pub fn save_active_config(config: &AiConfig) -> Result<(), String> {
    let path = config_path(CONFIG_FILE)
        .ok_or_else(|| "Unable to locate user config directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {e}"))
}

pub fn load_image_config() -> AiProviderConfig {
    load_provider_config(IMAGE_CONFIG_FILE, AiProviderConfig::image_default)
}

pub fn save_image_config(config: &AiProviderConfig) -> Result<(), String> {
    save_provider_config(IMAGE_CONFIG_FILE, config)?;
    remember_media_profile(ProfileKind::Image, config)
}

pub fn load_tts_config() -> AiProviderConfig {
    load_provider_config(TTS_CONFIG_FILE, AiProviderConfig::tts_default)
}

pub fn save_tts_config(config: &AiProviderConfig) -> Result<(), String> {
    save_provider_config(TTS_CONFIG_FILE, config)?;
    remember_media_profile(ProfileKind::Tts, config)
}

fn remember_media_profile(kind: ProfileKind, config: &AiProviderConfig) -> Result<(), String> {
    remember_saved_profile(
        kind,
        &config.provider,
        profile_of(
            &config.model,
            &config.models,
            &config.api_key,
            &config.base_url,
        ),
    )
}

fn load_provider_config(
    file_name: &str,
    default: impl FnOnce() -> AiProviderConfig,
) -> AiProviderConfig {
    let Some(path) = config_path(file_name) else {
        return default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return default();
    };
    serde_json::from_str(&text).unwrap_or_else(|_| default())
}

fn save_provider_config(file_name: &str, config: &AiProviderConfig) -> Result<(), String> {
    let path = config_path(file_name)
        .ok_or_else(|| "Unable to locate user config directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {e}"))
}

pub fn log_path() -> Result<PathBuf, String> {
    Ok(config_root()
        .ok_or_else(|| "Unable to locate user config directory".to_string())?
        .join(LOG_FILE))
}

pub fn agent_trace_path() -> Result<PathBuf, String> {
    Ok(config_root()
        .ok_or_else(|| "Unable to locate user config directory".to_string())?
        .join(AGENT_TRACE_FILE))
}

pub fn append_log_line(line: &str) -> Result<(), String> {
    append_log_line_at(&log_path()?, line)
}

pub fn append_agent_trace_line(line: &str) -> Result<(), String> {
    append_log_line_at(&agent_trace_path()?, line)
}

pub fn append_log_line_at(path: &PathBuf, line: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Unable to locate log directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create log directory: {e}"))?;

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("Failed to write log: {e}"))
}

pub fn read_log_lines(limit: usize) -> Result<Vec<String>, String> {
    read_log_lines_at(&log_path()?, limit)
}

pub fn read_log_lines_at(path: &PathBuf, limit: usize) -> Result<Vec<String>, String> {
    if limit == 0 || !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("Failed to read log: {e}"))?;
    let mut lines = text
        .lines()
        .rev()
        .take(limit)
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    lines.reverse();
    Ok(lines)
}

pub fn clear_log() -> Result<(), String> {
    clear_log_at(&log_path()?)
}

pub fn clear_log_at(path: &PathBuf) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Failed to clear log: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_configs_load_without_a_model_pool() {
        let config: AiConfig = serde_json::from_str(
            r#"{"provider":"openai","model":"gpt-4o","api_key":"key","base_url":""}"#,
        )
        .unwrap();
        let media_config: AiProviderConfig = serde_json::from_str(
            r#"{"provider":"elevenlabs","model":"eleven_multilingual_v2","api_key":"key","base_url":""}"#,
        )
        .unwrap();

        assert!(config.models.is_empty());
        assert_eq!(config.model, "gpt-4o");
        assert!(media_config.models.is_empty());
        assert_eq!(media_config.model, "eleven_multilingual_v2");
    }

    fn profile(key: &str) -> ProviderProfile {
        ProviderProfile {
            model: format!("{key}-model"),
            models: vec![format!("{key}-model")],
            api_key: key.to_string(),
            base_url: String::new(),
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ollaic-{tag}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn each_provider_keeps_its_own_profile_per_modality() {
        let dir = temp_dir("profiles");
        let path = dir.join(PROFILES_FILE);

        remember_profile_at(&path, ProfileKind::Chat, "openai", profile("openai-key")).unwrap();
        remember_profile_at(
            &path,
            ProfileKind::Chat,
            " DeepSeek ",
            profile("deepseek-key"),
        )
        .unwrap();
        remember_profile_at(&path, ProfileKind::Image, "openai", profile("image-key")).unwrap();
        // Saving the same provider again replaces only that provider's entry.
        remember_profile_at(
            &path,
            ProfileKind::Chat,
            "openai",
            profile("new-openai-key"),
        )
        .unwrap();

        let profiles = read_profiles_at(&path);
        assert_eq!(profiles.chat["openai"].api_key, "new-openai-key");
        assert_eq!(profiles.chat["deepseek"].api_key, "deepseek-key");
        assert_eq!(profiles.image["openai"].api_key, "image-key");
        assert!(profiles.tts.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_or_corrupt_profiles_file_reads_as_empty() {
        let dir = temp_dir("profiles-bad");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PROFILES_FILE);
        assert_eq!(read_profiles_at(&path), ProviderProfiles::default());
        fs::write(&path, "not json").unwrap();
        assert_eq!(read_profiles_at(&path), ProviderProfiles::default());
        let _ = fs::remove_dir_all(dir);
    }
}
