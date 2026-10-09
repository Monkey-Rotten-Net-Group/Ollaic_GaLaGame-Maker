use serde::{Deserialize, Serialize};

/// Task is blocked because the AI provider it needs is not configured yet.
pub const PENDING_CONFIGURATION_PREFIX: &str = "pending configuration:";
/// Task is blocked because BGM/SFX can only be satisfied by importing audio.
pub const PENDING_MANUAL_IMPORT_PREFIX: &str = "pending manual import:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Background,
    Figure,
    Bgm,
    Sfx,
    Tts,
}

impl AssetKind {
    pub fn from_plan(value: &str) -> Option<Self> {
        match value {
            "background" => Some(Self::Background),
            "figure" => Some(Self::Figure),
            "bgm" => Some(Self::Bgm),
            "sfx" => Some(Self::Sfx),
            _ => None,
        }
    }

    pub fn game_dir(self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::Figure => "figure",
            Self::Bgm => "bgm",
            Self::Sfx | Self::Tts => "vocal",
        }
    }

    /// BGM/SFX have no AI generation path. They stay pending until an imported
    /// audio file is bound to the task, so their pending reason must never be
    /// reported as a missing provider configuration.
    pub fn requires_manual_import(self) -> bool {
        matches!(self, Self::Bgm | Self::Sfx)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetTaskStatus {
    #[default]
    Pending,
    Running,
    Retrying,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAttempt {
    pub attempt: u32,
    pub started_at: u64,
    pub finished_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<String>,
    /// Set when the attempt was satisfied by binding an already-imported file
    /// instead of a generated artifact (BGM/SFX only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub used_local_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetTask {
    pub id: String,
    pub kind: AssetKind,
    pub target_stem: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emotion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialogue_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub status: AssetTaskStatus,
    #[serde(default)]
    pub attempts: Vec<AssetAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub used_local_fallback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueLimits {
    pub image: usize,
    pub tts: usize,
    /// Legacy JSON key retained for queue compatibility. It limits manual
    /// audio tasks (BGM/SFX) and is never an AI music generation limit.
    pub music: usize,
    pub max_retries: u32,
}

impl Default for QueueLimits {
    fn default() -> Self {
        Self {
            image: 2,
            tts: 4,
            music: 1,
            max_retries: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetQueue {
    pub version: u32,
    pub run_id: String,
    pub updated_at: u64,
    #[serde(default)]
    pub limits: QueueLimits,
    #[serde(default)]
    pub tasks: Vec<AssetTask>,
}

impl AssetQueue {
    pub fn new(run_id: impl Into<String>, tasks: Vec<AssetTask>, updated_at: u64) -> Self {
        Self {
            version: 1,
            run_id: run_id.into(),
            updated_at,
            limits: QueueLimits::default(),
            tasks,
        }
    }
}
