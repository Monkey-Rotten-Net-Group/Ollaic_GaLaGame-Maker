use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::characters::types::Character;

/// Global visual style specification and negative constraints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VisualStyleSpec {
    #[serde(default)]
    pub style_prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    #[serde(default)]
    pub palette_and_lighting: String,
    #[serde(default)]
    pub style_reference_image: Option<String>,
}

/// Project-owned planning record for an Agent Flow. Explains and resumes
/// generation work; the playable story remains in the Project's WebGAL files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlan {
    /// StoryPlan IR schema version. Bump on breaking changes; see `validate`.
    #[serde(default = "current_plan_version")]
    pub version: u32,
    /// The user's original Production Brief / prompt that started this flow.
    pub prompt: String,
    /// One-paragraph synopsis produced by the Plan step.
    #[serde(default)]
    pub synopsis: String,
    /// Global visual style specification and negative constraints.
    #[serde(default)]
    pub visual_style: VisualStyleSpec,
    /// Long-form worldbook + glossary produced by the Memory (Worldbuilder) step.
    #[serde(default)]
    pub memory: StoryMemory,
    /// Chapter outline produced by the Outline step.
    #[serde(default)]
    pub chapters: Vec<ChapterPlan>,
    /// Global story variables for stateful branching and conditions.
    #[serde(default)]
    pub variables: Vec<VariableDef>,
    /// Editable characters shared with `game/config/characters.json`.
    #[serde(default)]
    pub characters: Vec<Character>,
    /// Planned scenes and their navigation before WebGAL compilation.
    #[serde(default)]
    pub scene_plans: Vec<ScenePlan>,
    /// Branch topology rooted at the playable entry scene.
    #[serde(default)]
    pub branches: BranchGraph,
    /// Structured dialogue produced by the Dialogist.
    #[serde(default)]
    pub scene_drafts: Vec<SceneDraft>,
    /// P1 asset requirements. Asset generation and binding begin in P2.
    #[serde(default)]
    pub asset_plan: Vec<AssetTaskPlan>,
    /// Scene files written to `game/scene/` by Scene steps (P1 content link).
    #[serde(default)]
    pub scenes: Vec<String>,
    /// History of pipeline runs against this plan (newest last).
    #[serde(default)]
    pub pipeline_runs: Vec<PipelineRunSummary>,
}

pub const STORY_PLAN_VERSION: u32 = 1;

fn current_plan_version() -> u32 {
    STORY_PLAN_VERSION
}

impl StoryPlan {
    /// Create a fresh plan from a Production Brief, before any step has run.
    pub fn new(prompt: impl Into<String>) -> Self {
        StoryPlan {
            version: STORY_PLAN_VERSION,
            prompt: prompt.into(),
            synopsis: String::new(),
            visual_style: VisualStyleSpec::default(),
            memory: StoryMemory::default(),
            chapters: Vec::new(),
            variables: Vec::new(),
            characters: Vec::new(),
            scene_plans: Vec::new(),
            branches: BranchGraph::default(),
            scene_drafts: Vec::new(),
            asset_plan: Vec::new(),
            scenes: Vec::new(),
            pipeline_runs: Vec::new(),
        }
    }
}

/// Long-form worldbuilding context produced by the Worldbuilder (Memory) step.
/// The Plotter (Outline) reads this when building the chapter outline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoryMemory {
    #[serde(default)]
    pub worldbook: String,
    #[serde(default)]
    pub glossary: BTreeMap<String, String>,
}

/// A single chapter in the story outline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPlan {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VariableKind {
    Integer,
    Boolean,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VariableDef {
    pub id: String,
    pub kind: VariableKind,
    pub initial_value: String,
    #[serde(default)]
    pub description: String,
}

pub fn default_min_beats() -> usize {
    24
}

pub fn fallback_min_beats() -> usize {
    8
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScenePlan {
    pub id: String,
    pub file: String,
    pub chapter_id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub character_ids: Vec<String>,
    #[serde(default)]
    pub location_id: Option<String>,
    #[serde(default)]
    pub time_of_day: Option<String>,
    #[serde(default)]
    pub approval_status: SceneApprovalStatus,
    #[serde(default)]
    pub rolling_summary: Option<String>,
    #[serde(default)]
    pub pov_character_id: Option<String>,
    #[serde(default)]
    pub emotional_arc: String,
    #[serde(default)]
    pub required_beats: Vec<String>,
    #[serde(default)]
    pub forbidden_reveals: Vec<String>,
    #[serde(default)]
    pub entry_state: Vec<String>,
    #[serde(default = "default_min_beats")]
    pub min_beats: usize,
}

impl Default for ScenePlan {
    fn default() -> Self {
        Self {
            id: String::new(),
            file: String::new(),
            chapter_id: String::new(),
            title: String::new(),
            summary: String::new(),
            character_ids: Vec::new(),
            location_id: None,
            time_of_day: None,
            approval_status: SceneApprovalStatus::default(),
            rolling_summary: None,
            pov_character_id: None,
            emotional_arc: String::new(),
            required_beats: Vec::new(),
            forbidden_reveals: Vec::new(),
            entry_state: Vec::new(),
            min_beats: default_min_beats(),
        }
    }
}

impl ScenePlan {
    pub fn is_ending(&self) -> bool {
        let id = self.id.to_lowercase();
        let file = self.file.to_lowercase();
        let title = self.title.to_lowercase();
        id.contains("end")
            || file.contains("end")
            || title.contains("end")
            || self.title.contains("结局")
            || self.title.contains("终章")
            || self.title.contains("终")
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SceneApprovalStatus {
    #[default]
    Pending,
    Drafted,
    Approved,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchGraph {
    #[serde(default)]
    pub entry_scene: String,
    #[serde(default)]
    pub edges: Vec<BranchEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchEdge {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub choice: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub effects: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BeatKind {
    #[default]
    Dialogue,
    Narration,
    Monologue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneDraft {
    pub scene_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub stage_managed: bool,
    #[serde(default)]
    pub beats: Vec<DialogueBeat>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DialogueBeat {
    #[serde(default)]
    pub kind: BeatKind,
    #[serde(default)]
    pub speaker: Option<String>,
    pub text: String,
    #[serde(default)]
    pub figure_cues: Vec<FigureCue>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FigureCueAction {
    Show,
    Hide,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FigureStagePosition {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FigureCue {
    pub action: FigureCueAction,
    pub character_id: String,
    #[serde(default)]
    pub position: Option<FigureStagePosition>,
    #[serde(default)]
    pub emotion: String,
}

pub(crate) fn is_webgal_flag_value(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetTaskPlan {
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub target_stem: String,
    pub prompt: String,
    #[serde(default)]
    pub scene_ref: Option<String>,
    #[serde(default)]
    pub character_ref: Option<String>,
    #[serde(default)]
    pub emotion: Option<String>,
    #[serde(default)]
    pub reference_image: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default = "pending_status")]
    pub status: String,
}

fn pending_status() -> String {
    "pending".to_string()
}

/// A retained summary of one pipeline run, kept inside the plan's history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunSummary {
    pub run_id: String,
    /// Mirror of `RunStatus` as a string, so the plan record is stable across
    /// backend enum refactors.
    pub status: String,
    pub started_at: u64,
    pub updated_at: u64,
}
