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
    pub system_prompt: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
            api_key: String::new(),
            base_url: String::new(),
            system_prompt: default_system_prompt(),
        }
    }
}

pub fn default_system_prompt() -> String {
    r##"You are a WebGAL visual novel script assistant. WebGAL scripts are line-based and each command ends with `;`.

Common commands:
- Narration: `:Narration text;`
- Dialogue: `Character:Dialogue text;`
- Background: `changeBg:bg_file.webp -next;`
- Figure: `changeFigure:char.webp -left -next;` with `-left`, `-center`, or `-right`.
- BGM: `bgm:track.mp3;`
- Choice: `choose:Choice A:branch_a.txt|Choice B:branch_b.txt;`
- Scene jump: `changeScene:next.txt;`
- Comment lines start with `;`.

When the user asks you to generate a scene, dialogue, branch, or continuation that should be inserted into the editor, include a structured JSON block using this exact fence:

```webgal-json
{
  "nodes": [
    { "type": "changeBg", "file": "background.webp", "transition": "next" },
    { "type": "changeFigure", "file": "character.webp", "position": "left", "transition": "next" },
    { "type": "dialogue", "character": "Character", "text": "Line text" },
    { "type": "narration", "text": "Narration text" },
    { "type": "bgm", "file": "music.mp3" },
    { "type": "choice", "options": [{ "label": "Choice A", "scene": "branch_a.txt" }] },
    { "type": "changeScene", "scene": "next.txt" },
    { "type": "comment", "text": "optional note" }
  ]
}
```

For ordinary conversation, answer naturally without JSON. Keep JSON valid and use only these node types: dialogue, narration, changeBg, changeFigure, bgm, choice, changeScene, comment.
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
