use std::fs;
use std::path::{Path, PathBuf};

use crate::assets::commands::{SceneAssetCard, VoiceAssetCard};
use crate::characters::types::{CharacterSprite, CharactersDocument};
use crate::webgal::parser;
use crate::webgal::project_paths::ProjectPaths;
use crate::webgal::serializer;
use crate::webgal::types::{CommandType, WebGalNode};

use super::types::{AssetKind, AssetTask};

/// Promote the most recent generated artifact and bind it into playable project data.
/// Callers serialize calls to this function because it rewrites shared JSON and scenes.
pub fn bind_asset(project_path: &Path, task: &AssetTask) -> Result<String, String> {
    let project = ProjectPaths::open(project_path)?;
    let _project_guard = project.lock_for_write();
    let project_path = project.root();
    let artifact_path = task
        .attempts
        .iter()
        .rev()
        .find_map(|attempt| attempt.artifact.as_deref())
        .ok_or_else(|| format!("task {} has no generated artifact", task.id))?;
    validate_stem(&task.id)?;
    let artifact_root = project_path
        .join(".ollaic/artifacts/assets")
        .canonicalize()
        .map_err(|error| format!("failed to resolve artifact root: {error}"))?;
    let artifact = PathBuf::from(artifact_path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve artifact {artifact_path}: {error}"))?;
    if !artifact.starts_with(artifact_root.join(&task.id)) || !artifact.is_file() {
        return Err(format!(
            "artifact is outside task directory: {}",
            artifact.display()
        ));
    }
    let extension = artifact
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.chars().all(|ch| ch.is_ascii_alphanumeric()))
        .ok_or_else(|| format!("artifact has no safe extension: {}", artifact.display()))?;
    validate_stem(&task.target_stem)?;
    let (filename, target) = available_target(project_path, task, extension)?;
    let snapshots = snapshot_binding_files(project_path, &target)?;
    let bytes = fs::read(&artifact)
        .map_err(|error| format!("failed to read artifact {}: {error}", artifact.display()))?;
    if task.kind == AssetKind::Figure {
        validate_transparent_figure(extension, &bytes)?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create asset directory: {error}"))?;
    }
    crate::json_store::write_crash_safe(&target, &bytes)
        .map_err(|error| format!("failed to promote asset {}: {error}", target.display()))?;

    let binding = apply_binding(project_path, task, &filename);
    if let Err(error) = binding {
        return match restore_binding_files(snapshots) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!("{error}; rollback failed: {rollback}")),
        };
    }
    Ok(filename)
}

/// Restore scene/config references to an already-promoted successful asset.
pub fn rebind_asset(project_path: &Path, task: &AssetTask) -> Result<String, String> {
    let project = ProjectPaths::open(project_path)?;
    let _project_guard = project.lock_for_write();
    let project_path = project.root();
    let filename = task
        .asset_file
        .as_deref()
        .ok_or_else(|| format!("task {} has no promoted asset", task.id))?;
    if Path::new(filename).components().count() != 1 || filename.contains('\\') {
        return Err(format!("invalid promoted asset filename: {filename}"));
    }
    let target = project_path
        .join("game")
        .join(task.kind.game_dir())
        .join(filename);
    if !target.is_file() {
        return Err(format!("promoted asset is missing: {}", target.display()));
    }
    if task.kind == AssetKind::Figure {
        let bytes = fs::read(&target)
            .map_err(|error| format!("failed to read promoted figure: {error}"))?;
        validate_transparent_figure(
            target
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or(""),
            &bytes,
        )?;
    }
    let snapshots = snapshot_binding_files(project_path, &target)?;
    if let Err(error) = apply_binding(project_path, task, filename) {
        return match restore_binding_files(snapshots) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!("{error}; rollback failed: {rollback}")),
        };
    }
    Ok(filename.to_string())
}

fn apply_binding(project_path: &Path, task: &AssetTask, filename: &str) -> Result<(), String> {
    match task.kind {
        AssetKind::Background => {
            bind_scene_command(project_path, task, filename, CommandType::ChangeBg)?
        }
        AssetKind::Figure => bind_figure(project_path, task, filename)?,
        AssetKind::Bgm => bind_scene_command(project_path, task, filename, CommandType::Bgm)?,
        AssetKind::Sfx => {
            bind_scene_command(project_path, task, filename, CommandType::PlayEffect)?
        }
        AssetKind::Tts => bind_tts(project_path, task, filename)?,
    }
    update_asset_metadata(project_path, task, filename)
}

fn validate_stem(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(format!("invalid asset target stem: {value}"));
    }
    Ok(())
}

fn validate_transparent_figure(extension: &str, bytes: &[u8]) -> Result<(), String> {
    if !extension.eq_ignore_ascii_case("png") {
        return Err("figure artifact must be a transparent PNG".to_string());
    }
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|error| format!("invalid figure PNG: {error}"))?
        .to_rgba8();
    if !image.pixels().any(|pixel| pixel[3] < u8::MAX) {
        return Err("figure artifact has no transparent pixels".to_string());
    }
    Ok(())
}

fn scene_path(project_path: &Path, scene_ref: Option<&str>) -> Result<PathBuf, String> {
    let scene_dir = project_path.join("game/scene");
    if let Some(scene_ref) = scene_ref {
        let filename = if scene_ref.ends_with(".txt") {
            scene_ref.to_string()
        } else {
            format!("{scene_ref}.txt")
        };
        if Path::new(&filename).components().count() != 1 || filename.contains('\\') {
            return Err(format!("invalid scene reference: {scene_ref}"));
        }
        let path = scene_dir.join(filename);
        if path.is_file() {
            return checked_scene_path(&scene_dir, path);
        }
    }
    all_scene_paths(project_path)?
        .into_iter()
        .next()
        .ok_or_else(|| "project has no compiled scene".to_string())
}

fn all_scene_paths(project_path: &Path) -> Result<Vec<PathBuf>, String> {
    let scene_dir = project_path.join("game/scene");
    let root = scene_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve scene directory: {error}"))?;
    let mut scenes: Vec<PathBuf> = fs::read_dir(&scene_dir)
        .map_err(|error| {
            format!(
                "failed to read scene directory {}: {error}",
                scene_dir.display()
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("txt"))
        .map(|path| checked_scene_path(&root, path))
        .collect::<Result<_, _>>()?;
    scenes.sort();
    Ok(scenes)
}

fn checked_scene_path(scene_dir: &Path, path: PathBuf) -> Result<PathBuf, String> {
    let root = scene_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve scene directory: {error}"))?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve scene path: {error}"))?;
    if !path.starts_with(&root) {
        return Err(format!("scene path is outside project: {}", path.display()));
    }
    Ok(path)
}

struct FileSnapshot {
    path: PathBuf,
    contents: Option<Vec<u8>>,
}

fn snapshot_binding_files(project_path: &Path, target: &Path) -> Result<Vec<FileSnapshot>, String> {
    let mut paths = all_scene_paths(project_path)?;
    paths.extend([
        target.to_path_buf(),
        project_path.join("game/config/characters.json"),
        project_path.join("game/config/asset-metadata.json"),
    ]);
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .map(|path| {
            let contents =
                if path.exists() {
                    Some(fs::read(&path).map_err(|error| {
                        format!("failed to snapshot {}: {error}", path.display())
                    })?)
                } else {
                    None
                };
            Ok(FileSnapshot { path, contents })
        })
        .collect()
}

fn restore_binding_files(snapshots: Vec<FileSnapshot>) -> Result<(), String> {
    let mut errors = Vec::new();
    for snapshot in snapshots {
        let result = if let Some(contents) = snapshot.contents {
            crate::json_store::write_crash_safe(&snapshot.path, &contents)
        } else if snapshot.path.exists() {
            fs::remove_file(&snapshot.path)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            errors.push(format!("{}: {error}", snapshot.path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn read_scene(path: &Path) -> Result<Vec<WebGalNode>, String> {
    let source = fs::read_to_string(path)
        .map_err(|error| format!("failed to read scene {}: {error}", path.display()))?;
    Ok(parser::parse_script(&source))
}

fn write_scene(path: &Path, nodes: &[WebGalNode]) -> Result<(), String> {
    crate::json_store::write_crash_safe(path, serializer::serialize_script(nodes).as_bytes())
        .map_err(|error| format!("failed to write scene {}: {error}", path.display()))
}

fn asset_node(task_id: &str, kind: CommandType, filename: &str) -> WebGalNode {
    let mut node = WebGalNode::new(format!("asset-{task_id}"), kind, filename.to_string());
    node.asset = Some(filename.to_string());
    node
}

pub(crate) fn task_marker(task_id: &str) -> String {
    format!("ollaic-asset-task:{task_id}")
}

const FIGURE_STAGING_PREFIX: &str = "ollaic-figure-staging:";

pub(crate) fn staged_figure_command(command: &str) -> String {
    format!("{FIGURE_STAGING_PREFIX}{command}")
}

fn parse_staged_figure(node: &WebGalNode) -> Option<WebGalNode> {
    let command = node.content.strip_prefix(FIGURE_STAGING_PREFIX)?;
    parser::parse_script(command)
        .into_iter()
        .next()
        .filter(|node| node.cmd_type == CommandType::ChangeFigure)
}

fn available_target(
    project_path: &Path,
    task: &AssetTask,
    extension: &str,
) -> Result<(String, PathBuf), String> {
    let candidates = std::iter::once(format!("{}.{}", task.target_stem, extension))
        .chain(std::iter::once(format!(
            "{}-{}.{}",
            task.target_stem, task.id, extension
        )))
        .chain(
            (2..=10_000)
                .map(|index| format!("{}-{}-{index}.{}", task.target_stem, task.id, extension)),
        );
    for filename in candidates {
        let target = project_path
            .join("game")
            .join(task.kind.game_dir())
            .join(&filename);
        if !target.exists()
            || task.asset_file.as_deref() == Some(filename.as_str())
            || scene_task_owns_filename(project_path, task, &filename)?
        {
            return Ok((filename, target));
        }
    }
    Err(format!("no available target filename for task {}", task.id))
}

fn marker_node(task_id: &str) -> WebGalNode {
    WebGalNode::new(
        format!("asset-marker-{task_id}"),
        CommandType::Comment,
        task_marker(task_id),
    )
}

fn scene_task_owns_filename(
    project_path: &Path,
    task: &AssetTask,
    filename: &str,
) -> Result<bool, String> {
    if !matches!(
        task.kind,
        AssetKind::Background | AssetKind::Bgm | AssetKind::Sfx
    ) {
        return Ok(false);
    }
    let marker = task_marker(&task.id);
    let path = scene_path(project_path, task.scene_ref.as_deref())?;
    let nodes = read_scene(&path)?;
    Ok(nodes.windows(2).any(|pair| {
        pair[0].cmd_type == CommandType::Comment
            && pair[0].content == marker
            && pair[1].asset.as_deref() == Some(filename)
    }))
}

fn bind_scene_command(
    project_path: &Path,
    task: &AssetTask,
    filename: &str,
    kind: CommandType,
) -> Result<(), String> {
    let path = scene_path(project_path, task.scene_ref.as_deref())?;
    let mut nodes = read_scene(&path)?;
    let marker = task_marker(&task.id);
    if let Some(marker_index) = nodes
        .iter()
        .position(|node| node.cmd_type == CommandType::Comment && node.content == marker)
    {
        if let Some(existing) = nodes
            .get_mut(marker_index + 1)
            .filter(|node| node.cmd_type == kind)
        {
            existing.content = filename.to_string();
            existing.asset = Some(filename.to_string());
            return write_scene(&path, &nodes);
        }
    }
    if let Some(existing_index) = task.asset_file.as_deref().and_then(|previous| {
        nodes
            .iter()
            .position(|node| node.cmd_type == kind && node.asset.as_deref() == Some(previous))
    }) {
        let existing = &mut nodes[existing_index];
        existing.content = filename.to_string();
        existing.asset = Some(filename.to_string());
        nodes.insert(existing_index, marker_node(&task.id));
    } else {
        let mut index = nodes
            .iter()
            .position(|node| !matches!(node.cmd_type, CommandType::Comment))
            .unwrap_or(nodes.len());
        while index > 0
            && nodes[index - 1].cmd_type == CommandType::Comment
            && nodes[index - 1].content.starts_with("ollaic-asset-task:")
        {
            index -= 1;
        }
        nodes.splice(
            index..index,
            [marker_node(&task.id), asset_node(&task.id, kind, filename)],
        );
    }
    write_scene(&path, &nodes)
}

fn bind_figure(project_path: &Path, task: &AssetTask, filename: &str) -> Result<(), String> {
    let character_ref = task
        .character_ref
        .as_deref()
        .ok_or_else(|| format!("figure task {} has no characterRef", task.id))?;
    let characters_path = project_path.join("game/config/characters.json");
    let source = fs::read_to_string(&characters_path)
        .map_err(|error| format!("failed to read {}: {error}", characters_path.display()))?;
    let mut document: CharactersDocument = serde_json::from_str(&source)
        .map_err(|error| format!("invalid characters.json: {error}"))?;
    let character = document
        .characters
        .iter_mut()
        .find(|character| character.id == character_ref || character.name == character_ref)
        .ok_or_else(|| format!("character not found: {character_ref}"))?;
    let character_name = character.name.clone();
    let emotion = task.emotion.as_deref().unwrap_or("default");
    if let Some(sprite) = character
        .sprites
        .iter_mut()
        .find(|sprite| sprite.emotion == emotion)
    {
        sprite.file = filename.to_string();
        sprite.prompt = Some(task.prompt.clone());
    } else {
        character.sprites.push(CharacterSprite {
            emotion: emotion.to_string(),
            file: filename.to_string(),
            prompt: Some(task.prompt.clone()),
        });
    }
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    crate::json_store::write_crash_safe(&characters_path, &bytes)
        .map_err(|error| format!("failed to write {}: {error}", characters_path.display()))?;

    let explicit_scene = task.scene_ref.is_some();
    let paths = if explicit_scene {
        vec![scene_path(project_path, task.scene_ref.as_deref())?]
    } else {
        all_scene_paths(project_path)?
    };
    for path in paths {
        let mut nodes = read_scene(&path)?;
        let stage_managed = nodes.iter().any(|node| {
            node.cmd_type == CommandType::Comment && node.content == "Ollaic Scene Staging"
        });
        if stage_managed {
            let mut changed = false;
            let marker = task_marker(&task.id);
            for index in 0..nodes.len().saturating_sub(1) {
                if nodes[index].cmd_type != CommandType::Comment || nodes[index].content != marker {
                    continue;
                }
                if let Some(staged) = parse_staged_figure(&nodes[index + 1]) {
                    nodes[index + 1] = staged;
                }
                if nodes[index + 1].cmd_type != CommandType::ChangeFigure {
                    continue;
                }
                let node = &mut nodes[index + 1];
                node.content = filename.to_string();
                node.asset = Some(filename.to_string());
                node.figure_character = Some(character_ref.to_string());
                node.figure_emotion = Some(emotion.to_string());
                changed = true;
            }
            if changed {
                write_scene(&path, &nodes)?;
            } else if explicit_scene {
                return Err(format!(
                    "staged figure marker not found for task {} in {}",
                    task.id,
                    path.display()
                ));
            }
            continue;
        }
        let dialogue = nodes.iter().position(|node| {
            node.cmd_type == CommandType::Dialogue
                && node.character.as_deref() == Some(character_name.as_str())
        });
        if dialogue.is_none() && !explicit_scene {
            continue;
        }
        let insert_at = dialogue.unwrap_or_else(|| {
            nodes
                .iter()
                .position(|node| {
                    !matches!(node.cmd_type, CommandType::Comment | CommandType::Intro)
                })
                .unwrap_or(nodes.len())
        });
        let already_bound = nodes.iter().any(|node| {
            node.cmd_type == CommandType::ChangeFigure && node.asset.as_deref() == Some(filename)
        });
        if !already_bound {
            nodes.insert(
                insert_at,
                asset_node(&task.id, CommandType::ChangeFigure, filename),
            );
            write_scene(&path, &nodes)?;
        }
    }
    Ok(())
}

fn bind_tts(project_path: &Path, task: &AssetTask, filename: &str) -> Result<(), String> {
    let path = scene_path(project_path, task.scene_ref.as_deref())?;
    let mut nodes = read_scene(&path)?;
    let wanted = task
        .dialogue_index
        .ok_or_else(|| format!("tts task {} has no dialogueIndex", task.id))?;
    let node = nodes
        .iter_mut()
        .filter(|node| matches!(node.cmd_type, CommandType::Dialogue | CommandType::Narrator))
        .nth(wanted)
        .ok_or_else(|| format!("dialogue {wanted} not found in {}", path.display()))?;
    if task.text.as_deref().map(str::trim) != Some(node.content.trim()) {
        return Err(format!("dialogue {wanted} changed in {}", path.display()));
    }
    node.voice = Some(filename.to_string());
    write_scene(&path, &nodes)
}

fn update_asset_metadata(
    project_path: &Path,
    task: &AssetTask,
    filename: &str,
) -> Result<(), String> {
    let project = project_path.to_string_lossy();
    let mut metadata = crate::assets::commands::read_asset_metadata(&project)?;
    let key = format!("{}/{}", task.kind.game_dir(), filename);
    metadata
        .descriptions
        .insert(key.clone(), task.prompt.clone());
    metadata.tags.insert(
        key,
        vec!["status:done".to_string(), "source:ai".to_string()],
    );
    match task.kind {
        AssetKind::Background => {
            metadata.scene_cards.insert(
                task.id.clone(),
                SceneAssetCard {
                    id: task.id.clone(),
                    title: task.target_stem.clone(),
                    scene_file: task.scene_ref.clone(),
                    image_asset: Some(filename.to_string()),
                    target_stem: task.target_stem.clone(),
                    prompt: task.prompt.clone(),
                    ..SceneAssetCard::default()
                },
            );
        }
        AssetKind::Tts => {
            let scene = task
                .scene_ref
                .as_deref()
                .unwrap_or("scene")
                .trim_end_matches(".txt");
            let index = task.dialogue_index.unwrap_or(0);
            metadata.voice_cards.insert(
                format!("voice_{scene}_{index}"),
                VoiceAssetCard {
                    id: format!("voice_{scene}_{index}"),
                    character: task
                        .character_ref
                        .clone()
                        .unwrap_or_else(|| "旁白".to_string()),
                    text: task.text.clone().unwrap_or_default(),
                    emotion: "neutral".to_string(),
                    voice_asset: Some(filename.to_string()),
                    target_stem: task.target_stem.clone(),
                    prompt: task.prompt.clone(),
                },
            );
        }
        _ => {}
    }
    crate::assets::commands::write_asset_metadata(&project, &metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_queue::types::{AssetAttempt, AssetTaskStatus};

    fn png(alpha: u8) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([255, 255, 255, alpha]),
        ))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn figure_promotion_requires_transparent_png_pixels() {
        assert!(validate_transparent_figure("png", &png(0)).is_ok());
        assert!(validate_transparent_figure("png", &png(255)).is_err());
        assert!(validate_transparent_figure("webp", &png(0)).is_err());
    }

    #[test]
    fn figure_without_scene_ref_binds_every_scene_containing_character() {
        let project = std::env::temp_dir().join("ollaic_figure_bind_all");
        let _ = fs::remove_dir_all(&project);
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::create_dir_all(project.join("game/config")).unwrap();
        fs::write(
            project.join("game/scene/start.txt"),
            "; Ollaic Scene Staging\n; ollaic-asset-task:figure_alice\n; ollaic-figure-staging:changeFigure:none -id=alice -figureCharacter=alice -figureEmotion=default -right;\nAlice:one;\nBob:reply;\n",
        )
        .unwrap();
        fs::write(project.join("game/scene/route.txt"), "Alice:two;\n").unwrap();
        fs::write(project.join("game/scene/other.txt"), "Bob:three;\n").unwrap();
        fs::write(
            project.join("game/config/characters.json"),
            r#"{"version":1,"characters":[{"id":"alice","name":"Alice"},{"id":"bob","name":"Bob"}]}"#,
        )
        .unwrap();
        let artifact = project.join(".ollaic/artifacts/assets/figure_alice/1.png");
        fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        fs::write(&artifact, png(0)).unwrap();
        let task = AssetTask {
            id: "figure_alice".into(),
            kind: AssetKind::Figure,
            target_stem: "alice_default".into(),
            prompt: "Alice".into(),
            scene_ref: None,
            character_ref: Some("alice".into()),
            emotion: Some("default".into()),
            dialogue_index: None,
            text: None,
            status: AssetTaskStatus::Running,
            attempts: vec![AssetAttempt {
                attempt: 1,
                started_at: 0,
                finished_at: 1,
                artifact: Some(artifact.to_string_lossy().into_owned()),
                error: None,
                used_local_fallback: false,
            }],
            asset_file: None,
            error: None,
            used_local_fallback: false,
        };
        bind_asset(&project, &task).unwrap();
        let bob_artifact = project.join(".ollaic/artifacts/assets/figure_bob/1.png");
        fs::create_dir_all(bob_artifact.parent().unwrap()).unwrap();
        fs::write(&bob_artifact, png(0)).unwrap();
        let mut bob = task.clone();
        bob.id = "figure_bob".into();
        bob.target_stem = "bob_default".into();
        bob.character_ref = Some("bob".into());
        bob.attempts[0].artifact = Some(bob_artifact.to_string_lossy().into_owned());
        bind_asset(&project, &bob).unwrap();

        let start = fs::read_to_string(project.join("game/scene/start.txt")).unwrap();
        assert!(start.contains("changeFigure:alice_default.png -right"));
        assert!(!start.contains("changeFigure:bob_default.png"));
        let route = fs::read_to_string(project.join("game/scene/route.txt")).unwrap();
        assert!(route.contains("changeFigure:alice_default.png;"));
        let other = fs::read_to_string(project.join("game/scene/other.txt")).unwrap();
        assert!(other.contains("changeFigure:bob_default.png;"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn rejects_queue_paths_outside_the_project() {
        let project = std::env::temp_dir().join("ollaic_asset_path_boundary");
        let _ = fs::remove_dir_all(&project);
        fs::create_dir_all(project.join("game/scene")).unwrap();
        let artifact_dir = project.join(".ollaic/artifacts/assets/bg");
        fs::create_dir_all(&artifact_dir).unwrap();
        fs::write(project.join("game/scene/start.txt"), ":safe;\n").unwrap();
        let outside = std::env::temp_dir().join("ollaic_outside_artifact.png");
        fs::write(&outside, b"outside").unwrap();
        let mut task = AssetTask {
            id: "bg".into(),
            kind: AssetKind::Background,
            target_stem: "bg".into(),
            prompt: "background".into(),
            scene_ref: Some("../../outside".into()),
            character_ref: None,
            emotion: None,
            dialogue_index: None,
            text: None,
            status: AssetTaskStatus::Running,
            attempts: vec![AssetAttempt {
                attempt: 1,
                started_at: 0,
                finished_at: 1,
                artifact: Some(outside.to_string_lossy().into_owned()),
                error: None,
                used_local_fallback: false,
            }],
            asset_file: None,
            error: None,
            used_local_fallback: false,
        };
        assert!(bind_asset(&project, &task).is_err());
        assert!(!project.join("game/background/bg.png").exists());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        let artifact = artifact_dir.join("1.png");
        fs::write(&artifact, b"inside").unwrap();
        task.attempts[0].artifact = Some(artifact.to_string_lossy().into_owned());
        assert!(bind_asset(&project, &task).is_err());
        assert!(!project.join("game/background/bg.png").exists());
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn same_kind_tasks_keep_distinct_scene_commands() {
        let project = std::env::temp_dir().join("ollaic_bind_same_kind");
        let _ = fs::remove_dir_all(&project);
        fs::create_dir_all(project.join("game/scene")).unwrap();
        fs::create_dir_all(project.join("game/vocal")).unwrap();
        fs::write(project.join("game/scene/start.txt"), ":safe;\n").unwrap();
        fs::write(project.join("game/vocal/impact-rain.wav"), b"user audio").unwrap();

        for name in ["door", "rain"] {
            let artifact = project
                .join(".ollaic/artifacts/assets")
                .join(name)
                .join("1.wav");
            fs::create_dir_all(artifact.parent().unwrap()).unwrap();
            fs::write(&artifact, b"audio").unwrap();
            bind_asset(
                &project,
                &AssetTask {
                    id: name.into(),
                    kind: AssetKind::Sfx,
                    target_stem: "impact".into(),
                    prompt: name.into(),
                    scene_ref: Some("start.txt".into()),
                    character_ref: None,
                    emotion: None,
                    dialogue_index: None,
                    text: None,
                    status: AssetTaskStatus::Running,
                    attempts: vec![AssetAttempt {
                        attempt: 1,
                        started_at: 0,
                        finished_at: 1,
                        artifact: Some(artifact.to_string_lossy().into_owned()),
                        error: None,
                        used_local_fallback: false,
                    }],
                    asset_file: None,
                    error: None,
                    used_local_fallback: false,
                },
            )
            .unwrap();
        }

        let scene = fs::read_to_string(project.join("game/scene/start.txt")).unwrap();
        assert!(scene.contains("; ollaic-asset-task:door"));
        assert!(scene.contains("playEffect:impact.wav;"));
        assert!(scene.contains("; ollaic-asset-task:rain"));
        assert!(scene.contains("playEffect:impact-rain-2.wav;"));
        assert_eq!(
            fs::read(project.join("game/vocal/impact-rain.wav")).unwrap(),
            b"user audio"
        );
        let _ = fs::remove_dir_all(project);
    }
}
