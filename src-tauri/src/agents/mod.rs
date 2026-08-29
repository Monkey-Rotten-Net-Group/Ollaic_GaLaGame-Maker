//! Multi-Agent definitions (V2 section 3.3). Agents are invoked by the
//! pipeline through the `Agent` trait, so the orchestrator is testable
//! without an LLM (ADR 0056). P1 agents use the configured `genai` provider
//! and expose an explicit local fallback when no chat model is configured.

pub mod asset_planner;
pub mod character;
pub mod dialogist;
pub mod memory;
pub mod outline;
pub mod plan;
pub mod router;
pub mod scene;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

use crate::asset_queue::AssetQueue;
use crate::characters::types::Character;
use crate::pipeline::dsl::{StepExecutor, StepKind};
use crate::story_plan::types::{AssetTaskPlan, BranchGraph, ChapterPlan, SceneDraft, ScenePlan};

pub use asset_planner::AssetPlannerAgent;
pub use character::CharacterAgent;
pub use dialogist::DialogistAgent;
pub use memory::MemoryAgent;
pub use outline::OutlineAgent;
pub use plan::PlanAgent;
pub use scene::SceneAgent;

/// The slice of StoryPlan context an Agent may read. Grows per slice as new
/// agents need more context (worldbook, characters, branches, ...).
pub struct AgentContext<'a> {
    pub chat: &'a dyn router::ChatGateway,
    /// The immutable Production Brief that owns the run.
    pub prompt: &'a str,
    /// Optional per-step instruction edited from the Flow inspector.
    pub instruction: &'a str,
    pub synopsis: &'a str,
    pub chapters: &'a [ChapterPlan],
    pub worldbook: &'a str,
    pub glossary: &'a std::collections::BTreeMap<String, String>,
    pub characters: &'a [Character],
    pub scene_plans: &'a [ScenePlan],
    pub branches: &'a BranchGraph,
    pub scene_drafts: &'a [SceneDraft],
    pub asset_plan: &'a [AssetTaskPlan],
    pub allow_local_fallback: bool,
}

/// The one valid domain payload produced by an Agent or Flow Step executor.
/// Each variant owns all fields that must change together, so impossible
/// cross-step combinations cannot be constructed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum AgentOutputPayload {
    Synopsis(String),
    Memory {
        worldbook: String,
        glossary: std::collections::BTreeMap<String, String>,
    },
    Outline {
        chapters: Vec<ChapterPlan>,
        scene_plans: Vec<ScenePlan>,
        branches: BranchGraph,
    },
    Characters(Vec<Character>),
    SceneDrafts(Vec<SceneDraft>),
    AssetPlan(Vec<AssetTaskPlan>),
    Scenes(Vec<SceneScript>),
    AssetQueue(AssetQueue),
}

/// A typed payload plus provider provenance for one completed step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutput {
    #[serde(flatten)]
    pub payload: AgentOutputPayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downgrade: Option<String>,
}

impl AgentOutput {
    pub fn new(payload: AgentOutputPayload) -> Self {
        Self {
            payload,
            model: None,
            prompt_tokens: None,
            completion_tokens: None,
            warnings: Vec::new(),
            downgrade: None,
        }
    }

    pub fn with_model(
        mut self,
        model: String,
        prompt_tokens: Option<u32>,
        completion_tokens: Option<u32>,
    ) -> Self {
        self.model = Some(model);
        self.prompt_tokens = prompt_tokens;
        self.completion_tokens = completion_tokens;
        self
    }

    pub fn local_fallback(mut self) -> Self {
        self.warnings
            .push("未配置可用的对话模型，已使用本地内容模板".to_string());
        self.downgrade = Some("local-template".to_string());
        self
    }
}

#[cfg(test)]
mod output_tests {
    use super::{AgentOutput, AgentOutputPayload, AgentRegistry};
    use crate::pipeline::dsl::{StepExecutor, StepKind};

    #[test]
    fn serialized_output_has_one_tagged_payload() {
        let output = AgentOutput::new(AgentOutputPayload::Synopsis("A story".into()));
        let value = serde_json::to_value(output).unwrap();

        assert_eq!(value["type"], "synopsis");
        assert_eq!(value["data"], "A story");
        assert!(value.get("characters").is_none());
    }

    #[test]
    fn registry_resolves_typed_step_executors() {
        let registry = AgentRegistry::with_defaults();

        assert!(registry.get(StepKind::Plan, &StepExecutor::Agent).is_some());
        assert!(registry
            .get(
                StepKind::Scene,
                &StepExecutor::NamedAgent("dialogist".to_string()),
            )
            .is_some());
        assert!(registry
            .get(StepKind::Asset, &StepExecutor::AssetQueue)
            .is_none());
    }
}

/// A generated WebGAL scene script. The scheduler writes `content` to
/// `<project>/game/scene/<name>` - this is the "readable script" output of
/// the P1 content link (V2 doc section 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneScript {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentError(pub String);

pub trait Agent: Send + Sync {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>>;
}

/// Maps a `StepKind` to the agent that runs it. Injectable so tests can swap
/// in deterministic or failing agents.
pub struct AgentRegistry {
    map: HashMap<String, Box<dyn Agent>>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        AgentRegistry {
            map: HashMap::new(),
        }
    }

    /// The P1 registry, including named Dialogist and SceneScript roles.
    pub fn with_defaults() -> Self {
        let mut registry = Self::new();
        registry.register(StepKind::Plan, Box::new(PlanAgent));
        registry.register(StepKind::Memory, Box::new(MemoryAgent));
        registry.register(StepKind::Outline, Box::new(OutlineAgent));
        registry.register(StepKind::Character, Box::new(CharacterAgent));
        registry.register(StepKind::Asset, Box::new(AssetPlannerAgent));
        registry.register(StepKind::Scene, Box::new(SceneAgent));
        registry.register_named("dialogist", Box::new(DialogistAgent));
        registry.register_named("assetPlanner", Box::new(AssetPlannerAgent));
        registry.register_named("sceneScript", Box::new(SceneAgent));
        registry
    }

    pub fn register(&mut self, kind: StepKind, agent: Box<dyn Agent>) {
        self.map.insert(kind.as_str().to_string(), agent);
    }

    pub fn register_named(&mut self, key: impl Into<String>, agent: Box<dyn Agent>) {
        self.map.insert(key.into(), agent);
    }

    pub fn get(&self, kind: StepKind, executor: &StepExecutor) -> Option<&dyn Agent> {
        let key = match executor {
            StepExecutor::Agent => kind.as_str(),
            StepExecutor::NamedAgent(key) => key,
            StepExecutor::AssetQueue => return None,
        };
        self.map.get(key).map(|boxed| boxed.as_ref())
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
