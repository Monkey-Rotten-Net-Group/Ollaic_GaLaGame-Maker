use crate::webgal::parser as webgal_parser;
use crate::webgal::references;
use crate::webgal::types::CommandType;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetInfo {
    pub name: String,
    pub path: String,
    pub category: String,
    pub size: u64,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUsage {
    pub scene_file: String,
    pub line_number: usize,
    pub line_content: String,
    pub command: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMetadata {
    #[serde(default)]
    pub aliases: HashMap<String, String>,
    #[serde(default)]
    pub descriptions: HashMap<String, String>,
    #[serde(default)]
    pub tags: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub references: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub scene_cards: HashMap<String, SceneAssetCard>,
    #[serde(default)]
    pub cg_cards: HashMap<String, SceneAssetCard>,
    #[serde(default)]
    pub voice_cards: HashMap<String, VoiceAssetCard>,
    #[serde(default)]
    pub deleted_scene_cards: Vec<String>,
    #[serde(default)]
    pub deleted_cg_cards: Vec<String>,
    #[serde(default)]
    pub deleted_voice_cards: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAssetCard {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub scene_file: Option<String>,
    #[serde(default)]
    pub image_asset: Option<String>,
    #[serde(default)]
    pub target_stem: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub negative_prompt: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAssetCard {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub character: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub emotion: String,
    #[serde(default)]
    pub voice_asset: Option<String>,
    #[serde(default)]
    pub target_stem: String,
    #[serde(default)]
    pub prompt: String,
}

fn category_to_dir(category: &str) -> Option<String> {
    match category {
        "scene" | "background" => Some("background".to_string()),
        "character" | "figure" => Some("figure".to_string()),
        // Per-character figure subdirectory: figure/<characterId>. Validate each
        // path segment to reject traversal, mirroring the reference/ branch below.
        _ if category.starts_with("figure/") => {
            let tail = category.trim_start_matches("figure/");
            if tail
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
            {
                None
            } else {
                Some(format!("figure/{tail}"))
            }
        }
        "music" | "bgm" => Some("bgm".to_string()),
        "vocal" | "sfx" => Some("vocal".to_string()),
        "video" => Some("video".to_string()),
        "animation" => Some("animation".to_string()),
        "tex" => Some("tex".to_string()),
        "reference" => Some("reference".to_string()),
        _ if category.starts_with("reference/") => {
            let tail = category.trim_start_matches("reference/");
            if tail
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
            {
                None
            } else {
                Some(format!("reference/{tail}"))
            }
        }
        _ => None,
    }
}

fn is_media_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    let exts = [
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp3", ".ogg", ".wav", ".flac", ".aac",
        ".mp4", ".webm", ".avi",
    ];
    exts.iter().any(|e| lower.ends_with(e))
}

fn normalize_asset_filename(filename: &str) -> String {
    let path = PathBuf::from(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(filename);
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    let chars: Vec<char> = stem.chars().collect();
    let mut normalized = String::new();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if ch == '-' {
            while normalized.ends_with(char::is_whitespace) {
                normalized.pop();
            }
            normalized.push('-');
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            continue;
        }
        normalized.push(ch);
        i += 1;
    }

    let normalized = normalized.trim().to_string();
    if ext.is_empty() {
        normalized
    } else {
        format!("{normalized}.{ext}")
    }
}

fn validate_asset_filename(filename: &str) -> Result<(), String> {
    let path = Path::new(filename);
    if filename.is_empty()
        || path.components().count() != 1
        || path.file_name().and_then(|name| name.to_str()) != Some(filename)
        || filename == "."
        || filename == ".."
        || filename.contains('\\')
    {
        return Err(format!("无效的素材文件名: {filename}"));
    }
    Ok(())
}

fn list_dir_files(dir: &PathBuf) -> Result<Vec<AssetInfo>, String> {
    let mut result = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}: {e}", dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !is_media_file(&name) {
            continue;
        }
        let metadata = path.metadata().map_err(|e| e.to_string())?;
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        result.push(AssetInfo {
            name,
            path: path.to_string_lossy().to_string(),
            category: String::new(),
            size: metadata.len(),
            extension: ext,
        });
    }
    Ok(result)
}

fn reference_dir_for_asset(project_path: &str, subdir: &str, filename: &str) -> Option<PathBuf> {
    let reference_kind = match subdir {
        "background" => "backgrounds",
        "bgm" | "vocal" => "audio",
        _ => return None,
    };
    Some(
        PathBuf::from(project_path)
            .join("game")
            .join("config")
            .join("references")
            .join(reference_kind)
            .join(filename),
    )
}

fn asset_metadata_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join("game")
        .join("config")
        .join("asset-metadata.json")
}

pub(crate) fn read_asset_metadata(project_path: &str) -> Result<AssetMetadata, String> {
    let path = asset_metadata_path(project_path);
    if !path.exists() {
        return Ok(AssetMetadata::default());
    }
    let source = fs::read_to_string(&path)
        .map_err(|e| format!("读取素材元数据失败 {}: {e}", path.display()))?;
    serde_json::from_str(&source).map_err(|e| format!("解析素材元数据失败 {}: {e}", path.display()))
}

pub(crate) fn write_asset_metadata(project_path: &str, metadata: &AssetMetadata) -> Result<(), String> {
    let path = asset_metadata_path(project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let source = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
    fs::write(&path, source).map_err(|e| format!("写入素材元数据失败 {}: {e}", path.display()))
}

fn asset_metadata_key(category: &str, filename: &str) -> String {
    format!("{category}/{filename}")
}

fn rename_metadata_entry<T>(
    entries: &mut HashMap<String, T>,
    old_key: &str,
    legacy_key: Option<&str>,
    new_key: String,
) {
    let value = entries
        .remove(old_key)
        .or_else(|| legacy_key.and_then(|key| entries.remove(key)));
    if let Some(value) = value {
        entries.insert(new_key, value);
    }
}

fn owns_asset_metadata(category: &str) -> bool {
    matches!(
        category,
        "background" | "figure" | "bgm" | "vocal" | "video" | "animation" | "tex"
    )
}

fn rename_asset_metadata(
    project_path: &str,
    category: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let mut metadata = read_asset_metadata(project_path)?;
    let old_key = asset_metadata_key(category, old_name);
    let new_key = asset_metadata_key(category, new_name);
    let legacy_key = owns_asset_metadata(category).then_some(old_name);
    rename_metadata_entry(&mut metadata.aliases, &old_key, legacy_key, new_key.clone());
    rename_metadata_entry(&mut metadata.descriptions, &old_key, legacy_key, new_key.clone());
    rename_metadata_entry(&mut metadata.tags, &old_key, legacy_key, new_key.clone());
    rename_metadata_entry(&mut metadata.references, &old_key, legacy_key, new_key);
    write_asset_metadata(project_path, &metadata)
}

fn delete_asset_metadata(project_path: &str, category: &str, filename: &str) -> Result<(), String> {
    let mut metadata = read_asset_metadata(project_path)?;
    let key = asset_metadata_key(category, filename);
    metadata.aliases.remove(&key);
    metadata.descriptions.remove(&key);
    metadata.tags.remove(&key);
    metadata.references.remove(&key);
    if owns_asset_metadata(category) {
        metadata.aliases.remove(filename);
        metadata.descriptions.remove(filename);
        metadata.tags.remove(filename);
        metadata.references.remove(filename);
    }
    write_asset_metadata(project_path, &metadata)
}

fn rename_scene_asset_references(
    project_path: &str,
    category: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let scene_dir = PathBuf::from(project_path).join("game").join("scene");
    if !scene_dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(&scene_dir)
        .map_err(|e| format!("无法读取场景目录 {}: {e}", scene_dir.display()))?;
    let mut updates = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("txt") {
            continue;
        }
        let source = fs::read_to_string(&path)
            .map_err(|e| format!("无法读取场景文件 {}: {e}", path.display()))?;
        let (rewritten, count) =
            references::rename_asset_references(&source, category, old_name, new_name);
        if count > 0 {
            updates.push((path, rewritten));
        }
    }
    for (path, source) in updates {
        fs::write(&path, source)
            .map_err(|e| format!("无法更新场景文件 {}: {e}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn load_asset_metadata(project_path: String) -> Result<AssetMetadata, String> {
    read_asset_metadata(&project_path)
}

#[tauri::command]
pub fn save_asset_metadata(project_path: String, metadata: AssetMetadata) -> Result<(), String> {
    write_asset_metadata(&project_path, &metadata)
}

/// List all media files in a project's asset subdirectory.
/// `category` maps to one of the `game/` subdirs: background, figure, bgm, vocal, video, animation, tex.
#[tauri::command]
pub fn list_assets(project_path: String, category: String) -> Result<Vec<AssetInfo>, String> {
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let dir = PathBuf::from(&project_path).join("game").join(&subdir);

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut assets = list_dir_files(&dir)?;
    for a in &mut assets {
        a.category = subdir.to_string();
    }

    // The bare "figure" category also surfaces per-character subdirectory sprites
    // (one level deep) with subdirectory-qualified names, so the global figure
    // picker can still browse/select any character's立绘. Per-character listing
    // (category "figure/<id>") returns only that subdir with flat names above.
    if subdir == "figure" {
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("无法读取目录 {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let sub_path = entry.path();
            if !sub_path.is_dir() {
                continue;
            }
            let sub_name = entry.file_name().to_string_lossy().to_string();
            for mut asset in list_dir_files(&sub_path)? {
                asset.name = format!("{sub_name}/{}", asset.name);
                asset.category = subdir.to_string();
                assets.push(asset);
            }
        }
    }

    Ok(assets)
}

/// List assets across all subdirectories (used for "all" view).
#[tauri::command]
pub fn list_all_assets(project_path: String) -> Result<Vec<AssetInfo>, String> {
    let dirs = [
        "background",
        "figure",
        "bgm",
        "vocal",
        "video",
        "animation",
        "tex",
    ];
    let mut all = Vec::new();
    for d in &dirs {
        let dir = PathBuf::from(&project_path).join("game").join(d);
        if !dir.exists() {
            continue;
        }
        let mut assets = list_dir_files(&dir)?;
        for a in &mut assets {
            a.category = d.to_string();
        }
        all.append(&mut assets);
    }
    Ok(all)
}

/// Copy an external file into the project's asset directory.
#[tauri::command]
pub fn import_asset(
    source_path: String,
    project_path: String,
    category: String,
) -> Result<AssetInfo, String> {
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let target_dir = PathBuf::from(&project_path).join("game").join(&subdir);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let source = PathBuf::from(&source_path);
    let filename = source
        .file_name()
        .ok_or_else(|| "无效的文件路径".to_string())?
        .to_string_lossy()
        .to_string();
    let normalized_filename = normalize_asset_filename(&filename);
    validate_asset_filename(&normalized_filename)?;
    let target = target_dir.join(&normalized_filename);

    // Avoid overwriting — append (1), (2), etc.
    let target = unique_path(target);

    fs::copy(&source, &target).map_err(|e| format!("复制文件失败: {e}"))?;

    let metadata = target.metadata().map_err(|e| e.to_string())?;
    let ext = target
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(AssetInfo {
        name: target
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        path: target.to_string_lossy().to_string(),
        category: subdir.to_string(),
        size: metadata.len(),
        extension: ext,
    })
}

#[tauri::command]
pub fn save_generated_asset(
    project_path: String,
    category: String,
    filename: String,
    base64_data: String,
) -> Result<AssetInfo, String> {
    validate_asset_filename(&filename)?;
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let target_dir = PathBuf::from(&project_path).join("game").join(&subdir);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let encoded = base64_data
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(base64_data.as_str());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("解析生成素材失败: {e}"))?;

    let target = target_dir.join(&filename);
    fs::write(&target, bytes).map_err(|e| format!("写入生成素材失败 {}: {e}", target.display()))?;

    let metadata = target.metadata().map_err(|e| e.to_string())?;
    let ext = target
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(AssetInfo {
        name: filename,
        path: target.to_string_lossy().to_string(),
        category: subdir,
        size: metadata.len(),
        extension: ext,
    })
}

/// Delete an asset file from the project.
#[tauri::command]
pub fn delete_asset(
    project_path: String,
    category: String,
    filename: String,
) -> Result<(), String> {
    validate_asset_filename(&filename)?;
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let path = PathBuf::from(&project_path)
        .join("game")
        .join(&subdir)
        .join(&filename);

    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }

    // Safety check: ensure path is still within the project
    let canonical_project = PathBuf::from(&project_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&project_path));
    let canonical_target = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_target.starts_with(&canonical_project) {
        return Err("不允许删除项目目录外的文件".to_string());
    }

    fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    if let Some(reference_dir) = reference_dir_for_asset(&project_path, &subdir, &filename) {
        if reference_dir.exists() {
            fs::remove_dir_all(&reference_dir)
                .map_err(|e| format!("删除素材参考目录失败 {}: {e}", reference_dir.display()))?;
        }
    }
    delete_asset_metadata(&project_path, &subdir, &filename)?;
    Ok(())
}

/// Rename an asset file.
#[tauri::command]
pub fn rename_asset(
    project_path: String,
    category: String,
    old_name: String,
    new_name: String,
) -> Result<AssetInfo, String> {
    validate_asset_filename(&old_name)?;
    validate_asset_filename(&new_name)?;
    let subdir = category_to_dir(&category).ok_or_else(|| format!("未知素材类型: {category}"))?;
    let old_path = PathBuf::from(&project_path)
        .join("game")
        .join(&subdir)
        .join(&old_name);
    let new_path = PathBuf::from(&project_path)
        .join("game")
        .join(&subdir)
        .join(&new_name);

    if !old_path.exists() {
        return Err(format!("文件不存在: {}", old_path.display()));
    }
    if new_path.exists() {
        return Err(format!("目标文件已存在: {}", new_path.display()));
    }
    let old_reference_dir = reference_dir_for_asset(&project_path, &subdir, &old_name);
    let new_reference_dir = reference_dir_for_asset(&project_path, &subdir, &new_name);
    if let Some(path) = &new_reference_dir {
        if path.exists() {
            return Err(format!("目标素材参考目录已存在: {}", path.display()));
        }
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("重命名失败: {e}"))?;
    if let (Some(old_reference_dir), Some(new_reference_dir)) =
        (old_reference_dir, new_reference_dir)
    {
        if old_reference_dir.exists() {
            fs::rename(&old_reference_dir, &new_reference_dir).map_err(|e| {
                format!(
                    "迁移素材参考目录失败 {} -> {}: {e}",
                    old_reference_dir.display(),
                    new_reference_dir.display()
                )
            })?;
        }
    }
    rename_scene_asset_references(&project_path, &subdir, &old_name, &new_name)?;
    rename_asset_metadata(&project_path, &subdir, &old_name, &new_name)?;

    let metadata = new_path.metadata().map_err(|e| e.to_string())?;
    let ext = new_path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(AssetInfo {
        name: new_name,
        path: new_path.to_string_lossy().to_string(),
        category: subdir.to_string(),
        size: metadata.len(),
        extension: ext,
    })
}

#[tauri::command]
pub async fn find_asset_usages(
    project_path: String,
    filename: String,
    category: Option<String>,
) -> Result<Vec<AssetUsage>, String> {
    let scene_dir = PathBuf::from(&project_path).join("game").join("scene");
    if !scene_dir.exists() {
        return Ok(Vec::new());
    }

    let mut usages = Vec::new();
    let entries = fs::read_dir(&scene_dir)
        .map_err(|e| format!("无法读取场景目录 {}: {e}", scene_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }

        let scene_file = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("无法读取场景文件 {}: {e}", path.display()))?;

        for reference in references::find_asset_references(&content) {
            if reference.filename != filename
                || category
                    .as_deref()
                    .is_some_and(|category| category != reference.category)
            {
                continue;
            }
            usages.push(AssetUsage {
                scene_file: scene_file.clone(),
                line_number: reference.line_number,
                line_content: reference.line_content,
                command: reference.command.to_string(),
            });
        }
    }

    usages.sort_by(|a, b| {
        a.scene_file
            .cmp(&b.scene_file)
            .then(a.line_number.cmp(&b.line_number))
    });
    Ok(usages)
}

/// Common emotional keywords in Chinese dialogue.
fn detect_emotion(text: &str, flags: &[serde_json::Value]) -> String {
    // Check explicit emotion flag first
    for f in flags {
        if let Some(obj) = f.as_object() {
            if obj.get("key").and_then(|v| v.as_str()) == Some("emotion") {
                if let Some(val) = obj.get("value").and_then(|v| v.as_str()) {
                    return val.to_string();
                }
            }
        }
    }
    let lower = text.to_lowercase();
    let emotion_keywords: &[(&str, &[&str])] = &[
        ("happy", &["开心", "高兴", "太好", "哈哈", "喜欢", "微笑", "笑", "棒", "赞"]),
        ("sad", &["伤心", "难过", "哭", "痛", "悲伤", "遗憾", "对不起", "抱歉"]),
        ("angry", &["生气", "怒", "可恶", "过分", "混蛋", "滚", "闭嘴"]),
        ("surprised", &["惊讶", "什么", "不会吧", "竟然", "天啊", "不可能", "真的假的"]),
        ("fearful", &["害怕", "恐怖", "不要", "救命", "危险", "吓"]),
        ("gentle", &["温柔", "乖", "可爱", "安静", "轻声"]),
    ];
    for (emotion, keywords) in emotion_keywords {
        for kw in *keywords {
            if lower.contains(kw) {
                return emotion.to_string();
            }
        }
    }
    "neutral".to_string()
}

/// Generate stable ID for a voice card from scene and dialogue index.
fn voice_card_id(scene_stem: &str, dialogue_index: u32) -> String {
    format!("voice_{}_{}", scene_stem, dialogue_index)
}

/// Scan a scene file's dialogue lines and create VoiceAssetCard entries for any
/// that don't already have one. Called after scene save.
#[tauri::command]
pub fn sync_scene_voice_cards(
    project_path: String,
    scene_file: String,
) -> Result<Vec<VoiceAssetCard>, String> {
    let scene_path = PathBuf::from(&project_path)
        .join("game")
        .join("scene")
        .join(&scene_file);
    if !scene_path.exists() {
        return Err(format!("场景文件不存在: {}", scene_path.display()));
    }
    let source = fs::read_to_string(&scene_path)
        .map_err(|e| format!("读取场景文件失败 {}: {e}", scene_path.display()))?;
    let nodes = webgal_parser::parse_script(&source);
    let mut metadata = read_asset_metadata(&project_path)?;
    let scene_stem = scene_file.trim_end_matches(".txt");
    let mut dialogue_index: u32 = 0;
    let mut updated: Vec<VoiceAssetCard> = Vec::new();

    for node in &nodes {
        let is_dialogue = matches!(node.cmd_type, CommandType::Dialogue | CommandType::Narrator);
        if !is_dialogue || node.content.trim().is_empty() {
            continue;
        }
        let character = node.character.as_deref().unwrap_or("旁白");
        let this_index = dialogue_index;
        let id = voice_card_id(scene_stem, this_index);
        dialogue_index += 1;

        if metadata.voice_cards.contains_key(&id) {
            continue;
        }
        if metadata.deleted_voice_cards.contains(&id) {
            continue;
        }

        // Convert flags to serde_json::Value for emotion detection
        let flag_values: Vec<serde_json::Value> = node
            .flags
            .iter()
            .map(|f| {
                let val = match &f.value {
                    crate::webgal::types::FlagValue::Bool(b) => serde_json::Value::Bool(*b),
                    crate::webgal::types::FlagValue::Str(s) => serde_json::Value::String(s.clone()),
                };
                serde_json::json!({"key": f.key, "value": val})
            })
            .collect();
        let emotion = detect_emotion(&node.content, &flag_values);
        let target_stem = format!("vo_{}_{}_{}", character, scene_stem, this_index);

        let card = VoiceAssetCard {
            id: id.clone(),
            character: character.to_string(),
            text: node.content.clone(),
            emotion: emotion.clone(),
            voice_asset: node.voice.clone(),
            target_stem: target_stem.clone(),
            prompt: String::new(),
        };

        metadata.voice_cards.insert(id.clone(), card.clone());

        // Set tags on the target stem
        let tag_key = asset_metadata_key("vocal", &target_stem);
        let mut tags: Vec<String> = metadata.tags.get(&tag_key).cloned().unwrap_or_default();
        // scene tag
        tags.retain(|t| !t.starts_with("scene:"));
        tags.push(format!("scene:{}", scene_stem));
        // character tag
        tags.retain(|t| !t.starts_with("char:"));
        if character != "旁白" {
            tags.push(format!("char:{}", character));
        }
        // emotion tag
        tags.retain(|t| !t.starts_with("emotion:"));
        tags.push(format!("emotion:{}", emotion));
        // status tag
        tags.retain(|t| !t.starts_with("status:"));
        tags.push("status:pending".to_string());
        // source tag (only set if not already set)
        if node.voice.is_some() && !tags.iter().any(|t| t.starts_with("source:")) {
            tags.push("source:import".to_string());
        }
        metadata.tags.insert(tag_key, tags);

        updated.push(card);
    }

    if !updated.is_empty() {
        write_asset_metadata(&project_path, &metadata)?;
    }

    Ok(updated)
}

/// Fill a voice card slot with an imported audio file.
#[tauri::command]
pub fn fill_voice_card(
    project_path: String,
    voice_card_id: String,
    asset_filename: String,
) -> Result<VoiceAssetCard, String> {
    let mut metadata = read_asset_metadata(&project_path)?;
    // Snapshot the fields we need before taking a mutable reference.
    let card = metadata
        .voice_cards
        .get(&voice_card_id)
        .cloned()
        .ok_or_else(|| format!("配音卡片不存在: {voice_card_id}"))?;
    let stem = card.target_stem.clone();

    // Update the card in-place
    if let Some(c) = metadata.voice_cards.get_mut(&voice_card_id) {
        c.voice_asset = Some(asset_filename.clone());
    }

    // Update status tag
    let tag_key = asset_metadata_key("vocal", &stem);
    let mut tags: Vec<String> = metadata.tags.get(&tag_key).cloned().unwrap_or_default();
    tags.retain(|t| !t.starts_with("status:"));
    tags.push("status:done".to_string());
    tags.retain(|t| !t.starts_with("source:"));
    tags.push("source:import".to_string());
    metadata.tags.insert(tag_key, tags);

    write_asset_metadata(&project_path, &metadata)?;
    // Return updated card
    let updated = metadata
        .voice_cards
        .get(&voice_card_id)
        .cloned()
        .unwrap_or(card);
    Ok(updated)
}

/// Delete a voice card (mark as deleted so it won't be re-created on sync).
#[tauri::command]
pub fn delete_voice_card(
    project_path: String,
    voice_card_id: String,
) -> Result<(), String> {
    let mut metadata = read_asset_metadata(&project_path)?;
    let already_deleted = metadata.deleted_voice_cards.contains(&voice_card_id);
    metadata.voice_cards.remove(&voice_card_id);
    if !already_deleted {
        metadata.deleted_voice_cards.push(voice_card_id);
    }
    write_asset_metadata(&project_path, &metadata)
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path.extension().unwrap_or_default().to_string_lossy();
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new(""));

    for i in 1..100u32 {
        let new_name = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let candidate = parent.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    path // fallback — should never reach here
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;

    #[test]
    fn figure_assets_are_isolated_per_character_subdirectory() {
        let tmp = std::env::temp_dir().join("webgal_test_figure_subdirs");
        let _ = fs::remove_dir_all(&tmp);
        let project = tmp.to_string_lossy().to_string();
        let figure_dir = tmp.join("game").join("figure");
        fs::create_dir_all(figure_dir.join("char_a")).unwrap();
        fs::create_dir_all(figure_dir.join("char_b")).unwrap();
        fs::write(figure_dir.join("legacy.webp"), "x").unwrap();
        fs::write(figure_dir.join("char_a").join("stand.webp"), "x").unwrap();
        fs::write(figure_dir.join("char_b").join("smile.webp"), "x").unwrap();

        // Per-character listing only returns that character's sprites (flat names).
        let a = list_assets(project.clone(), "figure/char_a".to_string()).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "stand.webp");

        // Bare "figure" surfaces top-level files plus subdir-qualified sprites.
        let all = list_assets(project.clone(), "figure".to_string()).unwrap();
        let names: std::collections::HashSet<String> =
            all.into_iter().map(|asset| asset.name).collect();
        assert!(names.contains("legacy.webp"));
        assert!(names.contains("char_a/stand.webp"));
        assert!(names.contains("char_b/smile.webp"));

        // Path traversal in the subdirectory segment is rejected.
        assert!(list_assets(project, "figure/../scene".to_string()).is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn asset_usage_requires_an_exact_semantic_reference() {
        let tmp = std::env::temp_dir().join("webgal_test_asset_usage_exact");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            concat!(
                "changeBg:hero.webp;\n",
                ":hero.webp is mentioned in dialogue;\n",
                "changeBg:hero.webp.backup;\n",
            ),
        )
        .unwrap();

        let usages = block_on(find_asset_usages(
            tmp.to_string_lossy().to_string(),
            "hero.webp".to_string(),
            None,
        ))
        .unwrap();

        assert_eq!(usages.len(), 1);
        assert_eq!(usages[0].command, "changeBg");
        assert_eq!(usages[0].line_number, 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn asset_usage_can_be_scoped_to_the_asset_category() {
        let tmp = std::env::temp_dir().join("webgal_test_asset_usage_category");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            "changeBg:shared.webp;\nchangeFigure:shared.webp;\n",
        )
        .unwrap();

        let usages = block_on(find_asset_usages(
            tmp.to_string_lossy().to_string(),
            "shared.webp".to_string(),
            Some("background".to_string()),
        ))
        .unwrap();

        assert_eq!(usages.len(), 1);
        assert_eq!(usages[0].command, "changeBg");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn renaming_and_deleting_an_asset_keeps_reference_directories_consistent() {
        let tmp = std::env::temp_dir().join("webgal_test_asset_reference_lifecycle");
        let _ = fs::remove_dir_all(&tmp);
        let asset_dir = tmp.join("game").join("background");
        let reference_dir = tmp
            .join("game")
            .join("config")
            .join("references")
            .join("backgrounds")
            .join("park.webp");
        let scene_dir = tmp.join("game").join("scene");
        fs::create_dir_all(&asset_dir).unwrap();
        fs::create_dir_all(&reference_dir).unwrap();
        fs::create_dir_all(&scene_dir).unwrap();
        fs::write(asset_dir.join("park.webp"), "asset").unwrap();
        fs::write(reference_dir.join("sketch.webp"), "reference").unwrap();
        fs::write(
            scene_dir.join("start.txt"),
            "changeBg:park.webp -next;\n:park.webp is dialogue text;\n",
        )
        .unwrap();
        let mut metadata = AssetMetadata::default();
        metadata.aliases.insert(
            "background/park.webp".to_string(),
            "Park daytime".to_string(),
        );
        save_asset_metadata(tmp.to_string_lossy().to_string(), metadata).unwrap();

        rename_asset(
            tmp.to_string_lossy().to_string(),
            "background".to_string(),
            "park.webp".to_string(),
            "garden.webp".to_string(),
        )
        .unwrap();

        let renamed_reference_dir = tmp
            .join("game")
            .join("config")
            .join("references")
            .join("backgrounds")
            .join("garden.webp");
        assert!(!reference_dir.exists());
        assert!(renamed_reference_dir.join("sketch.webp").exists());
        let scene = fs::read_to_string(scene_dir.join("start.txt")).unwrap();
        assert!(scene.contains("changeBg:garden.webp -next;"));
        assert!(scene.contains(":park.webp is dialogue text;"));
        let metadata = load_asset_metadata(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(
            metadata.aliases.get("background/garden.webp"),
            Some(&"Park daytime".to_string())
        );

        delete_asset(
            tmp.to_string_lossy().to_string(),
            "background".to_string(),
            "garden.webp".to_string(),
        )
        .unwrap();
        assert!(!renamed_reference_dir.exists());
        let metadata = load_asset_metadata(tmp.to_string_lossy().to_string()).unwrap();
        assert!(!metadata.aliases.contains_key("background/garden.webp"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn deleting_or_renaming_rejects_path_traversal_filenames() {
        let tmp = std::env::temp_dir().join("webgal_test_asset_filename_validation");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::write(tmp.join("game").join("config.txt"), "keep").unwrap();
        fs::write(
            tmp.join("game").join("background").join("park.webp"),
            "asset",
        )
        .unwrap();

        assert!(delete_asset(
            tmp.to_string_lossy().to_string(),
            "background".to_string(),
            "../config.txt".to_string(),
        )
        .is_err());
        assert!(rename_asset(
            tmp.to_string_lossy().to_string(),
            "background".to_string(),
            "park.webp".to_string(),
            "../config.txt".to_string(),
        )
        .is_err());
        assert!(validate_asset_filename("nested\\park.webp").is_err());
        assert_eq!(
            fs::read_to_string(tmp.join("game").join("config.txt")).unwrap(),
            "keep"
        );
        assert!(tmp
            .join("game")
            .join("background")
            .join("park.webp")
            .exists());
        let _ = fs::remove_dir_all(&tmp);
    }
}
