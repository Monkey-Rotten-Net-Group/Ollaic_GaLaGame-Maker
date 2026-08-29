use std::path::PathBuf;
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
        )?;
        preflight_media_config(
            &crate::ai::config::load_music_config(),
            "音乐",
            crate::ai::provider_capability::MediaCapability::MusicGeneration,
        )
    }

    fn create(
        &self,
        allow_local_fallback: bool,
        cancelled: Arc<AtomicBool>,
    ) -> Arc<dyn AssetGenerator> {
        Arc::new(ConfiguredAssetGenerator {
            local_fallback: allow_local_fallback,
            cancelled,
            figure_matting_model: self.figure_matting_model.clone(),
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
}

impl AssetGenerator for ConfiguredAssetGenerator {
    fn preflight(&self, task: &AssetTask) -> Result<(), String> {
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
            AssetKind::Bgm | AssetKind::Sfx => (
                crate::ai::config::load_music_config(),
                "音乐",
                crate::ai::provider_capability::MediaCapability::MusicGeneration,
            ),
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
            let result = generate_configured_asset(task, &self.figure_matting_model).await;
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(crate::asset_queue::scheduler::ASSET_QUEUE_CANCELLED.to_string());
            }
            match result {
                Ok(artifact) => Ok(artifact),
                Err(_) if self.local_fallback => Ok(local_placeholder(task.kind)),
                Err(error) => Err(error),
            }
        })
    }
}

async fn generate_configured_asset(
    task: &AssetTask,
    figure_matting_model: &Result<PathBuf, String>,
) -> Result<GeneratedArtifact, String> {
    let media = match task.kind {
        AssetKind::Background | AssetKind::Figure => {
            let config = crate::ai::config::load_image_config();
            crate::ai::commands::generate_image_media(
                None,
                task.prompt.clone(),
                configured_model(&config.model)?,
                None,
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
            let config = crate::ai::config::load_music_config();
            crate::ai::commands::generate_music_media(
                task.prompt.clone(),
                configured_model(&config.model)?,
                "mp3".to_string(),
            )
            .await?
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
        let model_path = figure_matting_model.clone()?;
        bytes = tokio::task::spawn_blocking(move || {
            matte_figure_bytes(bytes, |source| {
                crate::matting::commands::matte_image(&model_path, source)
            })
        })
        .await
        .map_err(|error| format!("figure matting task failed: {error}"))??;
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

pub(crate) fn local_placeholder(kind: AssetKind) -> GeneratedArtifact {
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
    use super::{matte_figure_bytes, preflight_media_config, require_figure_matting_model};
    use crate::ai::config::AiProviderConfig;
    use crate::ai::provider_capability::MediaCapability;
    use std::path::PathBuf;

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
            ("音乐", MediaCapability::MusicGeneration),
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
}
