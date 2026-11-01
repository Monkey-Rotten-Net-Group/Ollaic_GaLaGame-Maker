use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::Engine;

use crate::asset_queue::{AssetGenerator, AssetKind, AssetTask, GeneratedArtifact};

pub(crate) trait AssetGeneratorFactory: Send + Sync {
    fn preflight_run(&self, _allow_local_fallback: bool) -> Result<(), String> {
        Ok(())
    }

    fn create(
        &self,
        project_path: Option<&Path>,
        allow_local_fallback: bool,
        cancelled: Arc<AtomicBool>,
    ) -> Arc<dyn AssetGenerator>;
}

pub(crate) struct ConfiguredAssetGeneratorFactory {
    figure_matting_model: Result<PathBuf, String>,
}

impl ConfiguredAssetGeneratorFactory {
    pub(crate) fn new(figure_matting_model: Result<PathBuf, String>) -> Self {
        Self {
            figure_matting_model,
        }
    }
}

impl AssetGeneratorFactory for ConfiguredAssetGeneratorFactory {
    fn preflight_run(&self, allow_local_fallback: bool) -> Result<(), String> {
        if allow_local_fallback {
            return Ok(());
        }
        require_figure_matting_model(&self.figure_matting_model)?;
        preflight_media_config(
            &crate::ai::config::load_image_config(),
            "图片",
            crate::ai::provider_capability::MediaCapability::ImageGeneration,
        )?;
        preflight_media_config(
            &crate::ai::config::load_tts_config(),
            "音频",
            crate::ai::provider_capability::MediaCapability::TtsGeneration,
        )
    }

    fn create(
        &self,
        project_path: Option<&Path>,
        allow_local_fallback: bool,
        cancelled: Arc<AtomicBool>,
    ) -> Arc<dyn AssetGenerator> {
        Arc::new(ConfiguredAssetGenerator {
            local_fallback: allow_local_fallback,
            cancelled,
            figure_matting_model: self.figure_matting_model.clone(),
            project_path: project_path.map(Path::to_path_buf),
        })
    }
}

fn preflight_media_config(
    config: &crate::ai::config::AiProviderConfig,
    label: &str,
    required: crate::ai::provider_capability::MediaCapability,
) -> Result<(), String> {
    crate::ai::commands::validate_provider_config_basics(config, label)?;
    configured_model(&config.model)?;
    crate::ai::provider_capability::require_media_capability(config, required)
}

fn require_figure_matting_model(model: &Result<PathBuf, String>) -> Result<(), String> {
    model.as_ref().map(|_| ()).map_err(|error| {
        format!("立绘抠图能力不可用：{error}；请安装抠图模型、允许本地素材降级，或禁用素材步骤")
    })
}

struct ConfiguredAssetGenerator {
    local_fallback: bool,
    cancelled: Arc<AtomicBool>,
    figure_matting_model: Result<PathBuf, String>,
    project_path: Option<PathBuf>,
}

impl AssetGenerator for ConfiguredAssetGenerator {
    fn preflight(&self, task: &AssetTask) -> Result<(), String> {
        // BGM/SFX are manual-only unless local fallback is enabled to supply bundled mood audio.
        if task.kind == AssetKind::Bgm || task.kind == AssetKind::Sfx {
            if self.local_fallback {
                return Ok(());
            }
            return Err("BGM/SFX 不支持 AI 生成，请手动导入音频文件或允许本地降级".to_string());
        }
        if self.local_fallback {
            return Ok(());
        }
        if task.kind == AssetKind::Figure {
            require_figure_matting_model(&self.figure_matting_model)?;
        }
        let (config, label, required) = match task.kind {
            AssetKind::Background | AssetKind::Figure => (
                crate::ai::config::load_image_config(),
                "图片",
                crate::ai::provider_capability::MediaCapability::ImageGeneration,
            ),
            AssetKind::Tts => (
                crate::ai::config::load_tts_config(),
                "音频",
                crate::ai::provider_capability::MediaCapability::TtsGeneration,
            ),
            AssetKind::Bgm | AssetKind::Sfx => unreachable!(),
        };
        preflight_media_config(&config, label, required)
    }

    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(crate::asset_queue::scheduler::ASSET_QUEUE_CANCELLED.to_string());
            }
            let result = generate_configured_asset(
                task,
                &self.figure_matting_model,
                self.project_path.as_deref(),
            )
            .await;
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(crate::asset_queue::scheduler::ASSET_QUEUE_CANCELLED.to_string());
            }
            match result {
                Ok(artifact) => Ok(artifact),
                Err(_) if self.local_fallback => Ok(local_placeholder_for_task(task)),
                Err(error) => Err(error),
            }
        })
    }
}

/// Resolve project-owned images, preferring user references over generated anchors.
pub(crate) fn resolve_character_reference_image(
    project_dir: &Path,
    character_id: &str,
    task_reference: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let root = project_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve project: {error}"))?;
    let scoped_image = |path: PathBuf| -> Result<Option<PathBuf>, String> {
        if !path.exists() {
            return Ok(None);
        }
        let resolved = path
            .canonicalize()
            .map_err(|error| format!("failed to resolve reference image: {error}"))?;
        if !resolved.starts_with(&root) {
            return Err("reference image must remain inside the project".into());
        }
        if !resolved.is_file() {
            return Ok(None);
        }
        let extension = resolved
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !crate::asset_queue::binder::is_image_extension(extension) {
            return Err("reference must be a supported image file".into());
        }
        Ok(Some(resolved))
    };
    if !character_id.is_empty() && !crate::story_plan::types::is_webgal_flag_value(character_id) {
        return Err("invalid reference character id".into());
    }
    let ref_dir = root.join("game/config/references").join(character_id);
    for directory in [
        ref_dir.clone(),
        root.join("game/reference").join(character_id),
    ] {
        if !character_id.is_empty() && directory.exists() {
            let resolved_dir = directory
                .canonicalize()
                .map_err(|error| format!("failed to resolve reference directory: {error}"))?;
            if !resolved_dir.starts_with(&root) {
                return Err("reference directory must remain inside the project".into());
            }
            let entries = std::fs::read_dir(&resolved_dir)
                .map_err(|error| format!("failed to read reference directory: {error}"))?;
            let mut candidates = Vec::new();
            for entry in entries {
                let path = entry
                    .map_err(|error| format!("failed to read reference entry: {error}"))?
                    .path();
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if path
                    .file_name()
                    .is_some_and(|name| name != "anchor_raw.png")
                    && crate::asset_queue::binder::is_image_extension(extension)
                {
                    if let Some(image) = scoped_image(path)? {
                        candidates.push(image);
                    }
                }
            }
            candidates.sort();
            if let Some(image) = candidates.into_iter().next() {
                return Ok(Some(image));
            }
        }
    }
    if let Some(reference) = task_reference {
        if let Some(image) = scoped_image(root.join(reference))? {
            return Ok(Some(image));
        }
    }
    if character_id.is_empty() {
        return Ok(None);
    }
    if let Some(anchor) = scoped_image(ref_dir.join("anchor_raw.png"))? {
        return Ok(Some(anchor));
    }
    let characters = root.join("game/config/characters.json");
    if characters.is_file() {
        let source = std::fs::read(&characters)
            .map_err(|error| format!("failed to read characters: {error}"))?;
        let document: crate::characters::types::CharactersDocument =
            serde_json::from_slice(&source)
                .map_err(|error| format!("invalid characters: {error}"))?;
        if let Some(sprite) = document
            .characters
            .iter()
            .find(|character| character.id == character_id)
            .and_then(|character| {
                character
                    .sprites
                    .iter()
                    .find(|sprite| sprite.emotion == "default" && !sprite.file.is_empty())
            })
        {
            if let Some(image) = scoped_image(root.join("game/figure").join(&sprite.file))? {
                return Ok(Some(image));
            }
        }
    }
    scoped_image(
        root.join("game/figure")
            .join(format!("{character_id}_default.png")),
    )
}

fn save_raw_anchor(project: &Path, character_id: &str, bytes: &[u8]) -> Result<(), String> {
    if !crate::story_plan::types::is_webgal_flag_value(character_id) {
        return Err("invalid anchor character id".into());
    }
    let root = project
        .canonicalize()
        .map_err(|error| format!("failed to resolve project: {error}"))?;
    let target = root
        .join("game/config/references")
        .join(character_id)
        .join("anchor_raw.png");
    let mut ancestor = target.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("anchor has no project parent")?;
    }
    if !ancestor
        .canonicalize()
        .map_err(|error| error.to_string())?
        .starts_with(&root)
    {
        return Err("anchor must remain inside the project".into());
    }
    let source = image::load_from_memory(bytes)
        .map_err(|error| format!("failed to decode raw anchor: {error}"))?;
    let mut png = std::io::Cursor::new(Vec::new());
    source
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| format!("failed to encode raw anchor: {error}"))?;
    std::fs::create_dir_all(target.parent().ok_or("anchor has no parent")?)
        .map_err(|error| format!("failed to create anchor directory: {error}"))?;
    crate::json_store::write_crash_safe(&target, &png.into_inner())
        .map_err(|error| format!("failed to save raw anchor: {error}"))
}

async fn generate_task_image<F, Fut>(
    task: &AssetTask,
    project: Option<&Path>,
    model: String,
    generate: F,
) -> Result<crate::ai::commands::GeneratedMedia, String>
where
    F: FnOnce(String, String, Option<String>, Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<crate::ai::commands::GeneratedMedia, String>>,
{
    let reference = project
        .map(|root| {
            resolve_character_reference_image(
                root,
                task.character_ref.as_deref().unwrap_or(""),
                task.reference_image.as_deref(),
            )
        })
        .transpose()?
        .flatten();
    let ratio = task.aspect_ratio.clone().or_else(|| match task.kind {
        AssetKind::Figure => Some("3:4".into()),
        AssetKind::Background => Some("16:9".into()),
        _ => None,
    });
    generate(
        task.prompt.clone(),
        model,
        reference.map(|path| path.to_string_lossy().into_owned()),
        ratio,
    )
    .await
}

async fn generate_configured_asset(
    task: &AssetTask,
    figure_matting_model: &Result<PathBuf, String>,
    project_path: Option<&Path>,
) -> Result<GeneratedArtifact, String> {
    let media = match task.kind {
        AssetKind::Background | AssetKind::Figure => {
            let config = crate::ai::config::load_image_config();
            generate_task_image(
                task,
                project_path,
                configured_model(&config.model)?,
                |prompt, model, reference, ratio| {
                    crate::ai::commands::generate_image_media_with_aspect_ratio(
                        None, prompt, model, reference, ratio,
                    )
                },
            )
            .await?
        }
        AssetKind::Tts => {
            let config = crate::ai::config::load_tts_config();
            crate::ai::commands::generate_tts_media(
                task.text.clone().unwrap_or_default(),
                task.prompt.clone(),
                configured_model(&config.model)?,
                "mp3".to_string(),
            )
            .await?
        }
        AssetKind::Bgm | AssetKind::Sfx => {
            return Err("BGM/SFX 不支持 AI 生成，请手动导入音频文件".to_string());
        }
    };
    let encoded = media
        .base64_data
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(media.base64_data.as_str());
    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("failed to decode generated media: {error}"))?;
    let mut extension = media.extension;
    if task.kind == AssetKind::Figure {
        let raw_bytes = bytes.clone();
        let model_path = figure_matting_model.clone()?;
        bytes = tokio::task::spawn_blocking(move || {
            matte_figure_bytes(bytes, |source| {
                crate::matting::commands::matte_image(&model_path, source)
            })
        })
        .await
        .map_err(|error| format!("figure matting task failed: {error}"))??;
        if task.emotion.as_deref().unwrap_or("default") == "default" {
            if let (Some(project), Some(character)) = (project_path, task.character_ref.as_deref())
            {
                save_raw_anchor(project, character, &raw_bytes)?;
            }
        }
        extension = "png".to_string();
    }
    Ok(GeneratedArtifact {
        extension,
        bytes,
        used_local_fallback: false,
    })
}

fn configured_model(value: &str) -> Result<String, String> {
    value
        .split(',')
        .map(str::trim)
        .find(|model| !model.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "asset provider has no configured model".to_string())
}

fn matte_figure_bytes(
    bytes: Vec<u8>,
    matte: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    matte(&bytes)
}

#[allow(dead_code)]
pub(crate) fn local_placeholder(kind: AssetKind) -> GeneratedArtifact {
    local_placeholder_with_context(kind, "", "")
}

pub(crate) fn local_placeholder_for_task(task: &AssetTask) -> GeneratedArtifact {
    local_placeholder_with_context(task.kind, &task.prompt, &task.target_stem)
}

fn local_placeholder_with_context(
    kind: AssetKind,
    prompt: &str,
    target_stem: &str,
) -> GeneratedArtifact {
    if kind == AssetKind::Figure {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([0, 0, 0, 0]),
        ))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("embedded transparent placeholder is encodable");
        return GeneratedArtifact {
            extension: "png".to_string(),
            bytes: bytes.into_inner(),
            used_local_fallback: true,
        };
    }
    if kind == AssetKind::Background {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XfP7WQAAAABJRU5ErkJggg==")
            .expect("embedded placeholder png is valid");
        return GeneratedArtifact {
            extension: "png".to_string(),
            bytes,
            used_local_fallback: true,
        };
    }
    if kind == AssetKind::Bgm || kind == AssetKind::Sfx {
        let query = format!("{prompt} {target_stem}");
        let mood = crate::asset_queue::detect_audio_mood(&query);
        return GeneratedArtifact {
            extension: "wav".to_string(),
            bytes: mood.audio_bytes().to_vec(),
            used_local_fallback: true,
        };
    }
    let mut bytes = b"RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\0\0\0\0".to_vec();
    bytes.truncate(44);
    GeneratedArtifact {
        extension: "wav".to_string(),
        bytes,
        used_local_fallback: true,
    }
}

#[cfg(test)]
pub(crate) struct PlaceholderAssetGeneratorFactory;

#[cfg(test)]
impl AssetGeneratorFactory for PlaceholderAssetGeneratorFactory {
    fn create(
        &self,
        _project_path: Option<&Path>,
        _allow_local_fallback: bool,
        cancelled: Arc<AtomicBool>,
    ) -> Arc<dyn AssetGenerator> {
        Arc::new(PlaceholderAssetGenerator { cancelled })
    }
}

#[cfg(test)]
struct PlaceholderAssetGenerator {
    cancelled: Arc<AtomicBool>,
}

#[cfg(test)]
impl AssetGenerator for PlaceholderAssetGenerator {
    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            if self.cancelled.load(Ordering::SeqCst) {
                Err(crate::asset_queue::scheduler::ASSET_QUEUE_CANCELLED.to_string())
            } else {
                Ok(local_placeholder(task.kind))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::config::AiProviderConfig;
    use crate::ai::provider_capability::MediaCapability;
    use crate::asset_queue::{AssetKind, AssetTask};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    #[test]
    fn generated_figure_uses_matting_output() {
        let output = matte_figure_bytes(b"opaque source".to_vec(), |source| {
            assert_eq!(source, b"opaque source");
            Ok(b"transparent png".to_vec())
        })
        .unwrap();
        assert_eq!(output, b"transparent png");
        assert_eq!(
            matte_figure_bytes(b"opaque source".to_vec(), |_| Err("matting failed".into()))
                .unwrap_err(),
            "matting failed"
        );
    }

    #[test]
    fn media_preflight_rejects_custom_configs_without_a_base_url() {
        let config = AiProviderConfig {
            provider: "custom".to_string(),
            model: "media-model".to_string(),
            api_key: "key".to_string(),
            base_url: String::new(),
        };

        for (label, required) in [
            ("图片", MediaCapability::ImageGeneration),
            ("音频", MediaCapability::TtsGeneration),
        ] {
            let error = preflight_media_config(&config, label, required).unwrap_err();
            assert!(error.contains("Base URL"), "{required:?}: {error}");
        }
    }

    #[test]
    fn media_preflight_rejects_a_missing_figure_matting_model() {
        let error =
            require_figure_matting_model(&Err("model file not found".to_string())).unwrap_err();
        assert!(error.contains("立绘抠图能力不可用"));
        assert!(error.contains("model file not found"));
        assert!(require_figure_matting_model(&Ok(PathBuf::from("model.onnx"))).is_ok());
    }

    #[tokio::test]
    async fn manual_audio_preflight_and_fallback_behavior() {
        let factory = ConfiguredAssetGeneratorFactory::new(Ok(PathBuf::from("model.onnx")));
        let strict_generator = factory.create(None, false, Arc::new(AtomicBool::new(false)));
        let task = AssetTask {
            id: "bgm_theme".into(),
            kind: AssetKind::Bgm,
            target_stem: "theme".into(),
            prompt: "悬疑旧校舍的探案氛围".into(),
            scene_ref: None,
            character_ref: None,
            emotion: None,
            dialogue_index: None,
            text: None,
            status: Default::default(),
            attempts: Vec::new(),
            asset_file: None,
            error: None,
            used_local_fallback: false,
            reference_image: None,
            aspect_ratio: None,
        };
        // Strict mode without import requires manual file or fallback authorization
        assert!(strict_generator
            .preflight(&task)
            .unwrap_err()
            .contains("手动导入"));

        // Fallback mode allows preflight and generates bundled mood audio
        let fallback_generator = factory.create(None, true, Arc::new(AtomicBool::new(false)));
        assert!(fallback_generator.preflight(&task).is_ok());

        let artifact = fallback_generator.generate(&task).await.unwrap();
        assert_eq!(artifact.extension, "wav");
        assert!(artifact.used_local_fallback);
        assert!(!artifact.bytes.is_empty());
        assert_eq!(&artifact.bytes[0..4], b"RIFF");
    }

    #[test]
    fn resolve_character_reference_image_prioritizes_user_reference_over_anchor_raw() {
        let temp = std::env::temp_dir().join(format!("ollaic_ref_test_{}", std::process::id()));
        let ref_dir = temp.join("game/config/references/alice");
        let _ = fs::create_dir_all(&ref_dir);
        let user_ref = ref_dir.join("reference.png");
        let anchor_raw = ref_dir.join("anchor_raw.png");
        fs::write(&user_ref, b"user").unwrap();
        fs::write(&anchor_raw, b"anchor").unwrap();

        let resolved = resolve_character_reference_image(&temp, "alice", None).unwrap();
        assert_eq!(resolved, Some(user_ref.canonicalize().unwrap()));

        // When user reference is absent, falls back to anchor_raw
        fs::remove_file(ref_dir.join("reference.png")).unwrap();
        let fallback = resolve_character_reference_image(&temp, "alice", None).unwrap();
        assert_eq!(fallback, Some(anchor_raw.canonicalize().unwrap()));

        let _ = fs::remove_dir_all(&temp);
    }
    #[test]
    fn raw_anchor_is_png_and_is_saved_durably() {
        let project =
            std::env::temp_dir().join(format!("ollaic_raw_anchor_{}", std::process::id()));
        fs::create_dir_all(&project).unwrap();
        let mut source = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8, 12)
            .write_to(&mut source, image::ImageFormat::Jpeg)
            .unwrap();
        save_raw_anchor(&project, "alice", &source.into_inner()).unwrap();
        let raw = fs::read(project.join("game/config/references/alice/anchor_raw.png")).unwrap();
        assert_eq!(image::guess_format(&raw).unwrap(), image::ImageFormat::Png);
        assert_eq!(image::load_from_memory(&raw).unwrap().height(), 12);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn variant_uses_legacy_user_reference_before_explicit_generated_anchor() {
        let project =
            std::env::temp_dir().join(format!("ollaic_legacy_ref_{}", std::process::id()));
        fs::create_dir_all(project.join("game/reference/alice")).unwrap();
        fs::create_dir_all(project.join("game/config/references/alice")).unwrap();
        fs::write(project.join("game/reference/alice/user.png"), b"user").unwrap();
        fs::write(
            project.join("game/config/references/alice/anchor_raw.png"),
            b"anchor",
        )
        .unwrap();
        let actual = resolve_character_reference_image(
            &project,
            "alice",
            Some("game/config/references/alice/anchor_raw.png"),
        )
        .unwrap();
        assert_eq!(
            actual,
            Some(
                project
                    .canonicalize()
                    .unwrap()
                    .join("game/reference/alice/user.png")
            )
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn reference_paths_cannot_escape_the_project() {
        let root =
            std::env::temp_dir().join(format!("ollaic_reference_scope_{}", std::process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(root.join("secret.png"), b"private").unwrap();
        assert!(
            resolve_character_reference_image(&project, "alice", Some("../secret.png"))
                .unwrap_err()
                .contains("inside the project")
        );
        assert!(resolve_character_reference_image(&project, "../alice", None).is_err());
        #[cfg(unix)]
        {
            fs::create_dir_all(project.join("game/config/references/alice")).unwrap();
            std::os::unix::fs::symlink(
                root.join("secret.png"),
                project.join("game/config/references/alice/user.png"),
            )
            .unwrap();
            assert!(resolve_character_reference_image(&project, "alice", None).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn variant_forwards_reference_and_portrait_ratio_to_generator() {
        let project =
            std::env::temp_dir().join(format!("ollaic_variant_forward_{}", std::process::id()));
        let directory = project.join("game/config/references/alice");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("anchor_raw.png"), b"anchor").unwrap();
        let task: AssetTask = serde_json::from_value(serde_json::json!({
            "id":"figure_alice_smile", "kind":"figure", "targetStem":"alice_smile",
            "prompt":"only smile", "characterRef":"alice", "emotion":"smile"
        }))
        .unwrap();
        let expected = directory
            .canonicalize()
            .unwrap()
            .join("anchor_raw.png")
            .to_string_lossy()
            .into_owned();
        generate_task_image(
            &task,
            Some(&project),
            "test-model".into(),
            |prompt, model, reference, ratio| async move {
                assert_eq!(reference.as_deref(), Some(expected.as_str()));
                assert_eq!(ratio.as_deref(), Some("3:4"));
                assert_eq!(prompt, "only smile");
                assert_eq!(model, "test-model");
                Ok(crate::ai::commands::GeneratedMedia {
                    base64_data: String::new(),
                    extension: "png".into(),
                })
            },
        )
        .await
        .unwrap();
        fs::remove_dir_all(project).unwrap();
    }
}
