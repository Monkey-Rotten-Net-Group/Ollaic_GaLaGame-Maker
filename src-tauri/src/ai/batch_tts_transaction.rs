use crate::assets::commands::{read_asset_metadata, write_asset_metadata};
use crate::project_transaction::ProjectFileTransaction;
use crate::webgal::project_paths::ProjectPaths;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub struct PreparedVoiceAsset {
    pub voice_card_id: String,
    pub filename: String,
    pub bytes: Vec<u8>,
}

impl PreparedVoiceAsset {
    pub fn new(
        voice_card_id: impl Into<String>,
        filename: impl Into<String>,
        bytes: Vec<u8>,
    ) -> Self {
        Self {
            voice_card_id: voice_card_id.into(),
            filename: filename.into(),
            bytes,
        }
    }
}

struct StagingDirectory(PathBuf);

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub async fn publish_batch(
    project_root: &Path,
    assets: Vec<PreparedVoiceAsset>,
) -> Result<Vec<String>, String> {
    publish_batch_inner(project_root, assets, None).await
}

async fn publish_batch_inner(
    project_root: &Path,
    assets: Vec<PreparedVoiceAsset>,
    fail_after_publish: Option<usize>,
) -> Result<Vec<String>, String> {
    let paths = ProjectPaths::open(project_root)?;
    validate_batch(&assets)?;
    let staging = stage_batch(paths.root(), &assets)?;
    let target_paths = assets
        .iter()
        .map(|asset| PathBuf::from("game/vocal").join(&asset.filename))
        .chain([PathBuf::from("game/config/asset-metadata.json")])
        .collect::<Vec<_>>();
    let mut transaction =
        ProjectFileTransaction::begin(paths.root(), "batch-tts", target_paths).await?;

    let result = publish_locked(paths.root(), &staging.0, &assets, fail_after_publish);
    if let Err(error) = result {
        return Err(with_rollback(error, transaction.rollback()));
    }
    if let Err(error) = transaction.prepare_commit() {
        return Err(with_rollback(error, transaction.rollback()));
    }
    transaction.commit();
    Ok(assets.into_iter().map(|asset| asset.filename).collect())
}

fn validate_batch(assets: &[PreparedVoiceAsset]) -> Result<(), String> {
    let mut filenames = HashSet::new();
    for asset in assets {
        let path = Path::new(&asset.filename);
        if asset.filename.is_empty()
            || !matches!(
                path.components().collect::<Vec<_>>().as_slice(),
                [Component::Normal(_)]
            )
            || asset.filename.contains(['/', '\\'])
        {
            return Err(format!(
                "invalid generated asset filename: {}",
                asset.filename
            ));
        }
        if !filenames.insert(asset.filename.to_lowercase()) {
            return Err(format!("duplicate batch TTS target: {}", asset.filename));
        }
    }
    Ok(())
}

fn stage_batch(
    project_root: &Path,
    assets: &[PreparedVoiceAsset],
) -> Result<StagingDirectory, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let directory = project_root
        .join(".ollaic/tts-staging")
        .join(format!("{}-{nonce}", std::process::id()));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create batch TTS staging directory: {error}"))?;
    let staging = StagingDirectory(directory);
    for (index, asset) in assets.iter().enumerate() {
        let path = staging.0.join(index.to_string());
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("failed to stage batch TTS asset: {error}"))?;
        file.write_all(&asset.bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("failed to stage batch TTS asset: {error}"))?;
    }
    Ok(staging)
}

fn publish_locked(
    project_root: &Path,
    staging: &Path,
    assets: &[PreparedVoiceAsset],
    fail_after_publish: Option<usize>,
) -> Result<(), String> {
    let vocal_dir = project_root.join("game/vocal");
    fs::create_dir_all(&vocal_dir)
        .map_err(|error| format!("failed to create vocal asset directory: {error}"))?;
    let existing = fs::read_dir(&vocal_dir)
        .map_err(|error| format!("failed to inspect vocal assets: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .collect::<HashSet<_>>();
    for asset in assets {
        if existing.contains(&asset.filename.to_lowercase()) {
            return Err(format!(
                "batch TTS target already exists: {}",
                asset.filename
            ));
        }
    }

    let mut metadata =
        read_asset_metadata(project_root.to_str().ok_or("project path is not UTF-8")?)?;
    for asset in assets {
        if !metadata.voice_cards.contains_key(&asset.voice_card_id) {
            return Err(format!(
                "voice card does not exist: {}",
                asset.voice_card_id
            ));
        }
    }
    for (index, asset) in assets.iter().enumerate() {
        let target = vocal_dir.join(&asset.filename);
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("failed to publish {}: {error}", target.display()))?;
        let bytes = fs::read(staging.join(index.to_string()))
            .map_err(|error| format!("failed to read staged TTS asset: {error}"))?;
        output
            .write_all(&bytes)
            .and_then(|()| output.sync_all())
            .map_err(|error| format!("failed to publish {}: {error}", target.display()))?;
        if fail_after_publish == Some(index) {
            return Err("injected batch TTS publish failure".to_string());
        }

        let card = metadata.voice_cards.get_mut(&asset.voice_card_id).unwrap();
        card.voice_asset = Some(asset.filename.clone());
        let tag_key = format!("vocal/{}", card.target_stem);
        let tags = metadata.tags.entry(tag_key).or_default();
        tags.retain(|tag| !tag.starts_with("status:") && !tag.starts_with("source:"));
        tags.extend(["status:done".to_string(), "source:ai".to_string()]);
    }
    write_asset_metadata(
        project_root.to_str().ok_or("project path is not UTF-8")?,
        &metadata,
    )
}

fn with_rollback(error: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => error,
        Err(rollback) => format!("{error}; rollback failed: {rollback}"),
    }
}

#[cfg(test)]
async fn publish_batch_with_failure(
    project_root: &Path,
    assets: Vec<PreparedVoiceAsset>,
    fail_after_publish: Option<usize>,
) -> Result<Vec<String>, String> {
    publish_batch_inner(project_root, assets, fail_after_publish).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::commands::{
        read_asset_metadata, write_asset_metadata, AssetMetadata, VoiceAssetCard,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn project(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ollaic_batch_tts_{name}_{nonce}"));
        fs::create_dir_all(root.join("game/vocal")).unwrap();
        fs::create_dir_all(root.join("game/scene")).unwrap();
        let mut metadata = AssetMetadata::default();
        for (id, stem) in [("voice-1", "line_one"), ("voice-2", "line_two")] {
            metadata.voice_cards.insert(
                id.to_string(),
                VoiceAssetCard {
                    id: id.to_string(),
                    target_stem: stem.to_string(),
                    ..VoiceAssetCard::default()
                },
            );
        }
        write_asset_metadata(root.to_str().unwrap(), &metadata).unwrap();
        root
    }

    #[tokio::test]
    async fn batch_tts_transaction_publishes_every_file_and_metadata_together() {
        let root = project("success");

        let published = publish_batch(
            &root,
            vec![
                PreparedVoiceAsset::new("voice-1", "line_one.wav", b"one".to_vec()),
                PreparedVoiceAsset::new("voice-2", "line_two.mp3", b"two".to_vec()),
            ],
        )
        .await
        .unwrap();

        assert_eq!(published, vec!["line_one.wav", "line_two.mp3"]);
        assert_eq!(
            fs::read(root.join("game/vocal/line_one.wav")).unwrap(),
            b"one"
        );
        assert_eq!(
            fs::read(root.join("game/vocal/line_two.mp3")).unwrap(),
            b"two"
        );
        let metadata = read_asset_metadata(root.to_str().unwrap()).unwrap();
        assert_eq!(
            metadata.voice_cards["voice-1"].voice_asset.as_deref(),
            Some("line_one.wav")
        );
        assert_eq!(
            metadata.tags["vocal/line_one"],
            vec!["status:done", "source:ai"]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn batch_tts_transaction_never_overwrites_a_case_insensitive_collision() {
        let root = project("collision");
        fs::write(root.join("game/vocal/LINE_ONE.WAV"), b"original").unwrap();
        let before = fs::read(root.join("game/config/asset-metadata.json")).unwrap();

        let error = publish_batch(
            &root,
            vec![PreparedVoiceAsset::new(
                "voice-1",
                "line_one.wav",
                b"replacement".to_vec(),
            )],
        )
        .await
        .unwrap_err();

        assert!(error.contains("already exists"));
        assert_eq!(
            fs::read(root.join("game/vocal/LINE_ONE.WAV")).unwrap(),
            b"original"
        );
        assert_eq!(
            fs::read(root.join("game/config/asset-metadata.json")).unwrap(),
            before
        );
        assert!(!root.join("game/vocal/line_one.wav").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn concurrent_batch_tts_transactions_merge_metadata_updates() {
        let root = project("concurrent");

        let (first, second) = tokio::join!(
            publish_batch(
                &root,
                vec![PreparedVoiceAsset::new(
                    "voice-1",
                    "line_one.wav",
                    b"one".to_vec(),
                )],
            ),
            publish_batch(
                &root,
                vec![PreparedVoiceAsset::new(
                    "voice-2",
                    "line_two.wav",
                    b"two".to_vec(),
                )],
            ),
        );

        first.unwrap();
        second.unwrap();
        let metadata = read_asset_metadata(root.to_str().unwrap()).unwrap();
        assert_eq!(
            metadata.voice_cards["voice-1"].voice_asset.as_deref(),
            Some("line_one.wav")
        );
        assert_eq!(
            metadata.voice_cards["voice-2"].voice_asset.as_deref(),
            Some("line_two.wav")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn batch_tts_transaction_rolls_back_files_after_a_publish_failure() {
        let root = project("publish_failure");
        let before = fs::read(root.join("game/config/asset-metadata.json")).unwrap();

        let error = publish_batch_with_failure(
            &root,
            vec![
                PreparedVoiceAsset::new("voice-1", "line_one.wav", b"one".to_vec()),
                PreparedVoiceAsset::new("voice-2", "line_two.wav", b"two".to_vec()),
            ],
            Some(0),
        )
        .await
        .unwrap_err();

        assert!(error.contains("injected batch TTS publish failure"));
        assert!(!root.join("game/vocal/line_one.wav").exists());
        assert!(!root.join("game/vocal/line_two.wav").exists());
        assert_eq!(
            fs::read(root.join("game/config/asset-metadata.json")).unwrap(),
            before
        );
        let _ = fs::remove_dir_all(root);
    }
}
