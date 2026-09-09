use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CONFIG_DIR: &str = "ollaic";
const CONFIG_FILE: &str = "ai.json";
const IMAGE_CONFIG_FILE: &str = "ai-image.json";
const TTS_CONFIG_FILE: &str = "ai-tts.json";
const MUSIC_CONFIG_FILE: &str = "ai-music.json";
const LOG_FILE: &str = "ai-log.jsonl";
const AGENT_TRACE_FILE: &str = "ai-agent-trace.jsonl";
const MAX_AGENT_TRACE_RECORDS: usize = 200;
static AGENT_TRACE_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub capabilities: Option<ProviderCapabilityDeclaration>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
pub struct AiProviderConfig {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub capabilities: Option<ProviderCapabilityDeclaration>,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
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
            model: "dall-e-3".into(),
            api_key: String::new(),
            base_url: String::new(),
            capabilities: None,
        }
    }

    fn tts_default() -> Self {
        Self {
            provider: "openai".into(),
            model: "tts-1".into(),
            api_key: String::new(),
            base_url: String::new(),
            capabilities: None,
        }
    }

    fn music_default() -> Self {
        Self {
            provider: "custom".into(),
            model: "music-1".into(),
            api_key: String::new(),
            base_url: String::new(),
            capabilities: None,
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

pub fn load_config() -> Result<AiConfig, String> {
    let Some(path) = config_path(CONFIG_FILE) else {
        return Err("Unable to locate user config directory".to_string());
    };
    load_config_at(&path, AiConfig::default)
}

pub fn save_config(config: &AiConfig) -> Result<(), String> {
    let path = config_path(CONFIG_FILE)
        .ok_or_else(|| "Unable to locate user config directory".to_string())?;
    save_config_at(&path, config)
}

pub fn load_image_config() -> Result<AiProviderConfig, String> {
    load_provider_config(IMAGE_CONFIG_FILE, AiProviderConfig::image_default)
}

pub fn save_image_config(config: &AiProviderConfig) -> Result<(), String> {
    save_provider_config(IMAGE_CONFIG_FILE, config)
}

pub fn load_tts_config() -> Result<AiProviderConfig, String> {
    load_provider_config(TTS_CONFIG_FILE, AiProviderConfig::tts_default)
}

pub fn save_tts_config(config: &AiProviderConfig) -> Result<(), String> {
    save_provider_config(TTS_CONFIG_FILE, config)
}

pub fn load_music_config() -> Result<AiProviderConfig, String> {
    load_provider_config(MUSIC_CONFIG_FILE, AiProviderConfig::music_default)
}

pub fn save_music_config(config: &AiProviderConfig) -> Result<(), String> {
    save_provider_config(MUSIC_CONFIG_FILE, config)
}

fn load_provider_config(
    file_name: &str,
    default: impl FnOnce() -> AiProviderConfig,
) -> Result<AiProviderConfig, String> {
    let Some(path) = config_path(file_name) else {
        return Err("Unable to locate user config directory".to_string());
    };
    load_config_at(&path, default)
}

fn save_provider_config(file_name: &str, config: &AiProviderConfig) -> Result<(), String> {
    let path = config_path(file_name)
        .ok_or_else(|| "Unable to locate user config directory".to_string())?;
    save_config_at(&path, config)
}

fn load_config_at<T>(path: &Path, default: impl FnOnce() -> T) -> Result<T, String>
where
    T: DeserializeOwned,
{
    if let Some(parent) = path.parent() {
        if parent.exists() {
            restrict_directory(parent)?;
        }
    }
    let backup = crate::json_store::backup_path(path);
    if backup.exists() {
        restrict_file(&backup)?;
    }
    if !path.exists() {
        if !backup.exists() {
            return Ok(default());
        }
        let bytes = fs::read(&backup).map_err(|_| "无法读取 Provider 配置备份".to_string())?;
        let config = serde_json::from_slice(&bytes)
            .map_err(|_| "配置文件缺失且备份损坏，无法恢复".to_string())?;
        restore_primary_from_backup(path, &bytes)?;
        return Ok(config);
    }

    restrict_file(path)?;
    let current = fs::read(path).map_err(|_| "无法读取 Provider 配置文件".to_string())?;
    match serde_json::from_slice(&current) {
        Ok(config) => Ok(config),
        Err(_) => {
            let backup_bytes =
                fs::read(&backup).map_err(|_| "Provider 配置文件损坏且没有可用备份".to_string())?;
            serde_json::from_slice::<T>(&backup_bytes)
                .map_err(|_| "Provider 配置文件损坏，备份也无法解析".to_string())?;
            restore_primary_from_backup(path, &backup_bytes)?;
            Err("Provider 配置文件损坏，已从备份恢复；请重试".to_string())
        }
    }
}

fn save_config_at<T: Serialize>(path: &Path, config: &T) -> Result<(), String> {
    save_config_at_with_failure(path, config, false)
}

fn save_config_at_with_failure<T: Serialize>(
    path: &Path,
    config: &T,
    fail_before_replace: bool,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Unable to locate user config directory".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "无法创建 Provider 配置目录".to_string())?;
    restrict_directory(parent)?;
    let json =
        serde_json::to_vec_pretty(config).map_err(|_| "无法序列化 Provider 配置".to_string())?;
    let temporary = suffixed_path(path, ".tmp");
    write_owner_only(&temporary, &json)?;
    if fail_before_replace {
        let _ = fs::remove_file(&temporary);
        return Err("Provider 配置写入在替换前失败".to_string());
    }

    let backup = crate::json_store::backup_path(path);
    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| "无法更新 Provider 配置备份".to_string())?;
        }
        fs::rename(path, &backup).map_err(|_| "无法备份当前 Provider 配置".to_string())?;
        restrict_file(&backup)?;
    }
    if fs::rename(&temporary, path).is_err() {
        if backup.exists() && !path.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err("无法原子替换 Provider 配置".to_string());
    }
    restrict_file(path)
}

fn restore_primary_from_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = suffixed_path(path, ".restore.tmp");
    let corrupt = suffixed_path(path, ".corrupt");
    write_owner_only(&temporary, bytes)?;
    if corrupt.exists() {
        fs::remove_file(&corrupt).map_err(|_| "无法清理损坏的 Provider 配置".to_string())?;
    }
    if path.exists() {
        fs::rename(path, &corrupt).map_err(|_| "无法隔离损坏的 Provider 配置".to_string())?;
    }
    if fs::rename(&temporary, path).is_err() {
        if corrupt.exists() && !path.exists() {
            let _ = fs::rename(&corrupt, path);
        }
        return Err("无法恢复 Provider 配置备份".to_string());
    }
    let _ = fs::remove_file(corrupt);
    restrict_file(path)
}

fn write_owner_only(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "无法创建 Provider 配置临时文件".to_string())?;
    file.write_all(contents)
        .map_err(|_| "无法写入 Provider 配置临时文件".to_string())?;
    file.sync_all()
        .map_err(|_| "无法同步 Provider 配置临时文件".to_string())?;
    restrict_file(path)
}

fn restrict_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法收紧 Provider 配置文件权限".to_string())?;
    }
    Ok(())
}

fn restrict_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法收紧 Provider 配置目录权限".to_string())?;
    }
    Ok(())
}

fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
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
    let _guard = AGENT_TRACE_WRITE_LOCK
        .lock()
        .map_err(|_| "Agent trace writer lock is poisoned".to_string())?;
    append_bounded_line_at(&agent_trace_path()?, line, MAX_AGENT_TRACE_RECORDS)
}

fn append_bounded_line_at(path: &PathBuf, line: &str, max_records: usize) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Unable to locate log directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create log directory: {e}"))?;
    restrict_log_directory(dir)?;
    let mut lines = if path.exists() {
        fs::read_to_string(path)
            .map_err(|e| format!("Failed to read trace file: {e}"))?
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    lines.push(line.to_string());
    if lines.len() > max_records {
        lines.drain(..lines.len() - max_records);
    }
    let mut contents = lines.join("\n");
    contents.push('\n');
    write_owner_only(path, contents.as_bytes())
        .map_err(|_| "Failed to write agent trace".to_string())
}

pub fn append_log_line_at(path: &PathBuf, line: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Unable to locate log directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log directory: {e}"))?;
    restrict_log_directory(dir)?;

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("Failed to write log: {e}"))?;
    restrict_file(path)
}

fn restrict_log_directory(path: &Path) -> Result<(), String> {
    if path.file_name().and_then(|name| name.to_str()) == Some(CONFIG_DIR) {
        restrict_directory(path)?;
    }
    Ok(())
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
mod recovery_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ollaic_provider_config_{label}_{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("ai.json")
    }

    fn configured(key: &str) -> AiConfig {
        AiConfig {
            provider: "openai".into(),
            model: "gpt-test".into(),
            api_key: key.into(),
            base_url: "https://example.test".into(),
            capabilities: None,
        }
    }

    #[test]
    fn truncated_primary_recovers_valid_backup_and_reports_it() {
        let path = temp_path("recover");
        let backup = crate::json_store::backup_path(&path);
        fs::write(&path, r#"{"provider":"openai""#).unwrap();
        fs::write(
            &backup,
            serde_json::to_vec_pretty(&configured("secret")).unwrap(),
        )
        .unwrap();

        let error = load_config_at(&path, AiConfig::default).unwrap_err();
        assert!(error.contains("已从备份恢复"));
        assert!(!error.contains("secret"));
        let loaded = load_config_at(&path, AiConfig::default).unwrap();
        assert_eq!(loaded.model, "gpt-test");
        assert!(backup.exists());
    }

    #[test]
    fn invalid_primary_and_backup_fail_without_exposing_contents() {
        let path = temp_path("invalid");
        fs::write(&path, r#"{"api_key":"primary-secret""#).unwrap();
        fs::write(crate::json_store::backup_path(&path), "backup-secret").unwrap();

        let error = load_config_at(&path, AiConfig::default).unwrap_err();
        assert!(error.contains("配置文件损坏"));
        assert!(!error.contains("primary-secret"));
        assert!(!error.contains("backup-secret"));
    }

    #[test]
    fn failed_replace_keeps_previous_valid_configuration() {
        let path = temp_path("interrupted");
        save_config_at(&path, &configured("old-key")).unwrap();

        let error = save_config_at_with_failure(&path, &configured("new-key"), true).unwrap_err();
        assert!(error.contains("替换前"));
        let loaded = load_config_at(&path, AiConfig::default).unwrap();
        assert_eq!(loaded.api_key, "old-key");
    }

    #[cfg(unix)]
    #[test]
    fn saved_and_migrated_config_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("permissions");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&configured("key")).unwrap(),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        let backup = crate::json_store::backup_path(&path);
        fs::write(
            &backup,
            serde_json::to_vec_pretty(&configured("backup-key")).unwrap(),
        )
        .unwrap();
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o644)).unwrap();
        load_config_at(&path, AiConfig::default).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn agent_trace_retention_keeps_only_the_newest_records() {
        let path = temp_path("trace_retention");
        for value in 0..5 {
            append_bounded_line_at(&path, &value.to_string(), 3).unwrap();
        }
        assert_eq!(fs::read_to_string(path).unwrap(), "2\n3\n4\n");
    }
}
