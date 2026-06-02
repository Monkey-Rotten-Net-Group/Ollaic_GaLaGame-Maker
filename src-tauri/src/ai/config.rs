use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const CONFIG_DIR: &str = "ciallo";
const CONFIG_FILE: &str = "ai.json";
const LOG_FILE: &str = "ai-log.jsonl";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
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

fn config_path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(CONFIG_DIR).join(CONFIG_FILE))
}

pub fn load_config() -> AiConfig {
    let Some(path) = config_path() else {
        return AiConfig::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return AiConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_config(config: &AiConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "Unable to locate user config directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {e}"))
}

pub fn append_log_line(line: &str) -> Result<(), String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "Unable to locate user config directory".to_string())?
        .join(CONFIG_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log directory: {e}"))?;
    let path = dir.join(LOG_FILE);

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("Failed to write log: {e}"))
}
