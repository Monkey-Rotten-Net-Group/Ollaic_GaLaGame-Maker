//! AI reference uploads.
//!
//! Local files the author attaches to the AI workflow as *reference material*.
//! They live in the project's editor state directory (`.webgal-editor/ai-uploads/`),
//! never inside `game/`, so they are not exported, not served by the runtime, and
//! never become playable project files. Agent tools may read their text content;
//! turning a reference into scene/asset changes still goes through the normal
//! staged change-set approval path.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Largest single reference file accepted, in bytes.
pub const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024;
/// Largest number of reference files kept per project.
pub const MAX_UPLOAD_COUNT: usize = 50;
/// Text extensions readable as reference material.
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "csv", "tsv", "yaml", "yml", "xml", "html", "htm", "log",
    "srt", "ini", "toml",
];

const SUMMARY_CHARS: usize = 200;
const DEFAULT_READ_LINES: usize = 200;
const MAX_READ_LINES: usize = 800;
const MAX_READ_CHARS: usize = 12_000;
const MAX_STORED_STEM_CHARS: usize = 60;

/// One stored reference file, as shown in the UI and to the agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUpload {
    pub id: String,
    /// Original file name chosen by the user.
    pub name: String,
    /// File name inside the store directory.
    pub stored_name: String,
    pub extension: String,
    pub size: u64,
    pub char_count: usize,
    pub line_count: usize,
    /// Short single-line preview used for listings and agent context.
    pub summary: String,
    /// Unix milliseconds, as a string (same convention as snapshots).
    pub imported_at: String,
}

/// A slice of one reference file's text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUploadContent {
    pub id: String,
    pub name: String,
    pub text: String,
    pub from_line: usize,
    pub to_line: usize,
    pub total_lines: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct UploadIndex {
    #[serde(default)]
    uploads: Vec<AiUpload>,
}

fn editor_dir(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".webgal-editor")
}

fn uploads_dir(project_path: &str) -> PathBuf {
    editor_dir(project_path).join("ai-uploads")
}

fn index_path(project_path: &str) -> PathBuf {
    uploads_dir(project_path).join("index.json")
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn read_index(project_path: &str) -> Result<UploadIndex, String> {
    let path = index_path(project_path);
    if !path.exists() {
        return Ok(UploadIndex::default());
    }
    let source = fs::read_to_string(&path)
        .map_err(|e| format!("读取参考文件索引失败 {}: {e}", path.display()))?;
    serde_json::from_str(&source)
        .map_err(|e| format!("解析参考文件索引失败 {}: {e}", path.display()))
}

fn write_index(project_path: &str, index: &UploadIndex) -> Result<(), String> {
    let dir = uploads_dir(project_path);
    fs::create_dir_all(&dir).map_err(|e| format!("创建参考文件目录失败 {}: {e}", dir.display()))?;
    let source = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(index_path(project_path), source)
        .map_err(|e| format!("写入参考文件索引失败: {e}"))
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// Reject anything we cannot read back as text, with a message that says what to do.
fn validate_extension(name: &str) -> Result<String, String> {
    let ext = extension_of(name);
    if ext.is_empty() {
        return Err(format!(
            "「{name}」没有扩展名，无法判断类型。支持的参考文件类型：{}。",
            SUPPORTED_EXTENSIONS.join(", ")
        ));
    }
    if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的参考文件类型 .{ext}。目前只支持文本类文件：{}。图片/音频请通过素材库导入。",
            SUPPORTED_EXTENSIONS.join(", ")
        ));
    }
    Ok(ext)
}

/// Keep letters, digits, CJK and a few separators; everything else becomes `_`.
/// The result is always a single path component.
fn sanitize_stored_name(id: &str, original: &str) -> String {
    let path = Path::new(original);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("reference");
    let ext = extension_of(original);
    let mut cleaned = String::new();
    for ch in stem.chars().take(MAX_STORED_STEM_CHARS) {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            cleaned.push(ch);
        } else {
            cleaned.push('_');
        }
    }
    let cleaned = cleaned.trim_matches('_').to_string();
    let stem = if cleaned.is_empty() {
        "reference".to_string()
    } else {
        cleaned
    };
    if ext.is_empty() {
        format!("{id}-{stem}")
    } else {
        format!("{id}-{stem}.{ext}")
    }
}

fn decode_text(bytes: &[u8], name: &str) -> Result<String, String> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        format!("「{name}」不是 UTF-8 文本（可能是二进制文件或其它编码）。请另存为 UTF-8 后重新上传。")
    })?;
    Ok(text.trim_start_matches('\u{feff}').replace("\r\n", "\n"))
}

fn summarize(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SUMMARY_CHARS {
        return collapsed;
    }
    let head: String = collapsed.chars().take(SUMMARY_CHARS).collect();
    format!("{head}…")
}

fn unique_id(index: &UploadIndex) -> String {
    let base = now_millis();
    let mut suffix = 0u32;
    loop {
        let id = if suffix == 0 {
            format!("ref-{base}")
        } else {
            format!("ref-{base}-{suffix}")
        };
        if !index.uploads.iter().any(|upload| upload.id == id) {
            return id;
        }
        suffix += 1;
    }
}

fn stored_path(project_path: &str, upload: &AiUpload) -> Result<PathBuf, String> {
    let name = Path::new(&upload.stored_name);
    if upload.stored_name.is_empty()
        || name.components().count() != 1
        || upload.stored_name.contains('\\')
        || upload.stored_name.contains('/')
    {
        return Err(format!("无效的参考文件名: {}", upload.stored_name));
    }
    Ok(uploads_dir(project_path).join(&upload.stored_name))
}

/// Drop index entries whose file disappeared (manual deletion, restore, sync).
fn prune_missing(project_path: &str, index: &mut UploadIndex) -> bool {
    let before = index.uploads.len();
    index
        .uploads
        .retain(|upload| stored_path(project_path, upload).map(|p| p.is_file()) == Ok(true));
    index.uploads.len() != before
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// List the project's reference uploads, newest first.
#[tauri::command]
pub fn list_ai_uploads(project_path: String) -> Result<Vec<AiUpload>, String> {
    let mut index = read_index(&project_path)?;
    if prune_missing(&project_path, &mut index) {
        write_index(&project_path, &index)?;
    }
    let mut uploads = index.uploads;
    uploads.sort_by(|a, b| b.imported_at.cmp(&a.imported_at));
    Ok(uploads)
}

/// Copy one local text file into the project's reference store.
#[tauri::command]
pub fn import_ai_upload(project_path: String, source_path: String) -> Result<AiUpload, String> {
    if !PathBuf::from(&project_path).join("game").is_dir() {
        return Err(format!("无效的项目目录：{project_path}"));
    }
    let source = PathBuf::from(&source_path);
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("无法解析文件名：{source_path}"))?
        .to_string();
    if !source.is_file() {
        return Err(format!("找不到文件：{source_path}"));
    }

    let extension = validate_extension(&name)?;
    let metadata = source
        .metadata()
        .map_err(|e| format!("读取文件信息失败 {source_path}: {e}"))?;
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "「{name}」过大（{}），单个参考文件上限 {}。请裁剪内容或拆分为多个文件后再上传。",
            format_size(metadata.len()),
            format_size(MAX_UPLOAD_BYTES)
        ));
    }
    if metadata.len() == 0 {
        return Err(format!("「{name}」是空文件，没有可参考的内容。"));
    }

    let mut index = read_index(&project_path)?;
    prune_missing(&project_path, &mut index);
    if index.uploads.len() >= MAX_UPLOAD_COUNT {
        return Err(format!(
            "参考文件数量已达上限（{MAX_UPLOAD_COUNT} 个）。请先删除不再需要的参考文件。"
        ));
    }

    let bytes = fs::read(&source).map_err(|e| format!("读取文件失败 {source_path}: {e}"))?;
    let text = decode_text(&bytes, &name)?;

    let id = unique_id(&index);
    let upload = AiUpload {
        stored_name: sanitize_stored_name(&id, &name),
        id,
        name,
        extension,
        size: metadata.len(),
        char_count: text.chars().count(),
        line_count: text.lines().count().max(1),
        summary: summarize(&text),
        imported_at: now_millis().to_string(),
    };

    let dir = uploads_dir(&project_path);
    fs::create_dir_all(&dir).map_err(|e| format!("创建参考文件目录失败 {}: {e}", dir.display()))?;
    let target = stored_path(&project_path, &upload)?;
    fs::write(&target, text.as_bytes())
        .map_err(|e| format!("保存参考文件失败 {}: {e}", target.display()))?;

    index.uploads.push(upload.clone());
    if let Err(e) = write_index(&project_path, &index) {
        let _ = fs::remove_file(&target);
        return Err(e);
    }
    Ok(upload)
}

/// Read a page of one reference file's text. Self-truncates so an agent read
/// can never blow up the context window.
#[tauri::command]
pub fn read_ai_upload(
    project_path: String,
    id: String,
    from_line: Option<usize>,
    max_lines: Option<usize>,
) -> Result<AiUploadContent, String> {
    let index = read_index(&project_path)?;
    let upload = index
        .uploads
        .iter()
        .find(|upload| upload.id == id || upload.name == id)
        .ok_or_else(|| format!("找不到参考文件：{id}。请先在 AI 面板上传，或用列表中的 id。"))?;

    let path = stored_path(&project_path, upload)?;
    let bytes = fs::read(&path).map_err(|e| {
        format!(
            "读取参考文件失败 {}: {e}。文件可能已被移动或删除，请重新上传。",
            path.display()
        )
    })?;
    let text = decode_text(&bytes, &upload.name)?;
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();

    let start = from_line.unwrap_or(1).max(1);
    let limit = max_lines.unwrap_or(DEFAULT_READ_LINES).clamp(1, MAX_READ_LINES);
    if start > total_lines {
        return Ok(AiUploadContent {
            id: upload.id.clone(),
            name: upload.name.clone(),
            text: String::new(),
            from_line: start,
            to_line: total_lines,
            total_lines,
            truncated: false,
        });
    }
    let end = (start + limit - 1).min(total_lines);

    let mut body = String::new();
    let mut last_line = start;
    let mut char_truncated = false;
    for (offset, line) in lines[start - 1..end].iter().enumerate() {
        if body.chars().count() + line.chars().count() > MAX_READ_CHARS {
            char_truncated = true;
            break;
        }
        if offset > 0 {
            body.push('\n');
        }
        body.push_str(line);
        last_line = start + offset;
    }

    Ok(AiUploadContent {
        id: upload.id.clone(),
        name: upload.name.clone(),
        text: body,
        from_line: start,
        to_line: last_line,
        total_lines,
        truncated: char_truncated || end < total_lines || start > 1,
    })
}

/// Remove one reference file and its index entry.
#[tauri::command]
pub fn delete_ai_upload(project_path: String, id: String) -> Result<(), String> {
    let mut index = read_index(&project_path)?;
    let position = index
        .uploads
        .iter()
        .position(|upload| upload.id == id)
        .ok_or_else(|| format!("找不到参考文件：{id}"))?;
    let upload = index.uploads.remove(position);
    let path = stored_path(&project_path, &upload)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("删除参考文件失败 {}: {e}", path.display()))?;
    }
    write_index(&project_path, &index)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempProject(PathBuf);

    impl TempProject {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ollaic-uploads-{tag}-{}", now_millis()));
            fs::create_dir_all(dir.join("game")).unwrap();
            Self(dir)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }

        fn write_source(&self, name: &str, content: &[u8]) -> String {
            let path = self.0.join(name);
            fs::write(&path, content).unwrap();
            path.to_string_lossy().to_string()
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imports_lists_reads_and_deletes_a_reference_file() {
        let project = TempProject::new("roundtrip");
        let source = project.write_source("设定集.md", "# 世界观\n第二行\n第三行\n".as_bytes());

        let upload = import_ai_upload(project.path(), source).unwrap();
        assert_eq!(upload.name, "设定集.md");
        assert_eq!(upload.extension, "md");
        assert_eq!(upload.line_count, 3);
        assert!(upload.summary.contains("世界观"));
        // Stored outside game/, so exports and the runtime never see it.
        assert!(PathBuf::from(project.path())
            .join(".webgal-editor/ai-uploads")
            .join(&upload.stored_name)
            .is_file());
        assert!(!PathBuf::from(project.path()).join("game").join(&upload.stored_name).exists());

        let listed = list_ai_uploads(project.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, upload.id);

        let content = read_ai_upload(project.path(), upload.id.clone(), Some(2), Some(1)).unwrap();
        assert_eq!(content.text, "第二行");
        assert_eq!(content.total_lines, 3);
        assert!(content.truncated);

        delete_ai_upload(project.path(), upload.id).unwrap();
        assert!(list_ai_uploads(project.path()).unwrap().is_empty());
    }

    #[test]
    fn rejects_unsupported_oversized_and_binary_files() {
        let project = TempProject::new("reject");

        let image = project.write_source("bg.png", b"\x89PNG\r\n");
        let err = import_ai_upload(project.path(), image).unwrap_err();
        assert!(err.contains("不支持的参考文件类型 .png"), "{err}");

        let big = project.write_source("big.txt", &vec![b'a'; (MAX_UPLOAD_BYTES + 1) as usize]);
        let err = import_ai_upload(project.path(), big).unwrap_err();
        assert!(err.contains("过大"), "{err}");

        let binary = project.write_source("bad.txt", &[0xff, 0xfe, 0x00, 0x01]);
        let err = import_ai_upload(project.path(), binary).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");

        let missing = project.0.join("nope.txt").to_string_lossy().to_string();
        let err = import_ai_upload(project.path(), missing).unwrap_err();
        assert!(err.contains("找不到文件"), "{err}");
    }

    #[test]
    fn stored_names_stay_inside_the_upload_directory() {
        let name = sanitize_stored_name("ref-1", "../../etc/passwd.txt");
        assert_eq!(name, "ref-1-passwd.txt");
        assert_eq!(Path::new(&name).components().count(), 1);

        let name = sanitize_stored_name("ref-2", "a b/c:d*e.md");
        assert!(!name.contains('/') && !name.contains('\\'));
        assert!(name.ends_with(".md"));
    }

    #[test]
    fn missing_files_are_pruned_from_the_index() {
        let project = TempProject::new("prune");
        let source = project.write_source("notes.txt", b"hello");
        let upload = import_ai_upload(project.path(), source).unwrap();

        fs::remove_file(stored_path(&project.path(), &upload).unwrap()).unwrap();
        assert!(list_ai_uploads(project.path()).unwrap().is_empty());
    }
}
