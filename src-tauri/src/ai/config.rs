use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const CONFIG_DIR: &str = "ciallo";
const CONFIG_FILE: &str = "ai.json";
const IMAGE_CONFIG_FILE: &str = "ai-image.json";
const TTS_CONFIG_FILE: &str = "ai-tts.json";
const MUSIC_CONFIG_FILE: &str = "ai-music.json";
const LOG_FILE: &str = "ai-log.jsonl";
const AGENT_TRACE_FILE: &str = "ai-agent-trace.jsonl";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiProviderConfig {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
            api_key: String::new(),
            base_url: String::new(),
        }
    }
}

impl AiProviderConfig {
    fn image_default() -> Self {
        Self {
            provider: "openai".into(),
            model: "dall-e-3".into(),
            api_key: String::new(),
            base_url: String::new(),
        }
    }

    fn tts_default() -> Self {
        Self {
            provider: "openai".into(),
            model: "tts-1".into(),
            api_key: String::new(),
            base_url: String::new(),
        }
    }

    fn music_default() -> Self {
        Self {
            provider: "custom".into(),
            model: "music-1".into(),
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

fn config_path(file_name: &str) -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(CONFIG_DIR).join(file_name))
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
    save_provider_config(IMAGE_CONFIG_FILE, config)
}

pub fn load_tts_config() -> AiProviderConfig {
    load_provider_config(TTS_CONFIG_FILE, AiProviderConfig::tts_default)
}

pub fn save_tts_config(config: &AiProviderConfig) -> Result<(), String> {
    save_provider_config(TTS_CONFIG_FILE, config)
}

pub fn load_music_config() -> AiProviderConfig {
    load_provider_config(MUSIC_CONFIG_FILE, AiProviderConfig::music_default)
}

pub fn save_music_config(config: &AiProviderConfig) -> Result<(), String> {
    save_provider_config(MUSIC_CONFIG_FILE, config)
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
    Ok(dirs::config_dir()
        .ok_or_else(|| "Unable to locate user config directory".to_string())?
        .join(CONFIG_DIR)
        .join(LOG_FILE))
}

pub fn agent_trace_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or_else(|| "Unable to locate user config directory".to_string())?
        .join(CONFIG_DIR)
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
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log directory: {e}"))?;

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
