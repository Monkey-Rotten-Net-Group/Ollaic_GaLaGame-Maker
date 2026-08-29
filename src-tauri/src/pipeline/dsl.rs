//! Flow recipe DSL - the declarative description of an Agent Flow's steps,
//! dependencies, and agents. See CONTEXT.md "Flow Template" / "Declarative
//! Recipe" and the V2 node types in `doc/v2-agent-pipeline.md` section 3.4.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{HashMap, HashSet};

/// The kind of work a Flow Step performs. Mirrors the V2 node-type table.
/// The kind set spans the current P1 content flow and later production gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Plan,
    Memory,
    Outline,
    Character,
    Scene,
    Asset,
    Lint,
    Review,
    Export,
    UserInput,
}

impl StepKind {
    /// Stable camelCase name, used in events and persisted state.
    pub fn as_str(&self) -> &'static str {
        match self {
            StepKind::Plan => "plan",
            StepKind::Memory => "memory",
            StepKind::Outline => "outline",
            StepKind::Character => "character",
            StepKind::Scene => "scene",
            StepKind::Asset => "asset",
            StepKind::Lint => "lint",
            StepKind::Review => "review",
            StepKind::Export => "export",
            StepKind::UserInput => "userInput",
        }
    }
}

/// The implementation that owns a Flow Step. The persisted `agent` field is
/// intentionally kept compatible with existing runs and the FlowBoard, while
/// the scheduler works with an explicit domain type instead of magic strings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum StepExecutor {
    #[default]
    Agent,
    NamedAgent(String),
    AssetQueue,
}

impl Serialize for StepExecutor {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Agent => serializer.serialize_none(),
            Self::NamedAgent(key) => serializer.serialize_str(key),
            Self::AssetQueue => serializer.serialize_str("assetQueue"),
        }
    }
}

impl<'de> Deserialize<'de> for StepExecutor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let key = Option::<String>::deserialize(deserializer)?;
        Ok(match key.as_deref() {
            None => Self::Agent,
            Some("assetQueue") => Self::AssetQueue,
            Some(_) => Self::NamedAgent(key.expect("matched Some")),
        })
    }
}

/// One step in a Flow Recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepDef {
    pub id: String,
    pub kind: StepKind,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Typed executor. Serialized as the legacy `agent` field for persisted
    /// run and frontend compatibility.
    #[serde(rename = "agent", default)]
    pub executor: StepExecutor,
    #[serde(default)]
    pub prompt: String,
}

impl StepDef {
    pub fn new(id: impl Into<String>, kind: StepKind) -> Self {
        StepDef {
            id: id.into(),
            kind,
            depends_on: Vec::new(),
            executor: StepExecutor::Agent,
            prompt: String::new(),
        }
    }

    pub fn agent(mut self, key: impl Into<String>) -> Self {
        let key = key.into();
        self.executor = if key == "assetQueue" {
            StepExecutor::AssetQueue
        } else {
            StepExecutor::NamedAgent(key)
        };
        self
    }

    pub fn asset_queue(mut self) -> Self {
        self.executor = StepExecutor::AssetQueue;
        self
    }
}

/// A declarative Flow Recipe: an ordered list of steps with dependencies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FlowRecipe {
    #[serde(default)]
    pub steps: Vec<StepDef>,
}

impl FlowRecipe {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn step(mut self, step: StepDef) -> Self {
        self.steps.push(step);
        self
    }

    /// Structural validation: unique ids, known dependencies, acyclic graph.
    pub fn validate(&self) -> Result<(), RecipeError> {
        let mut ids: HashSet<&str> = HashSet::new();
        for step in &self.steps {
            if !ids.insert(step.id.as_str()) {
                return Err(RecipeError::DuplicateStepId(step.id.clone()));
            }
        }
        for step in &self.steps {
            for dep in &step.depends_on {
                if !ids.contains(dep.as_str()) {
                    return Err(RecipeError::UnknownDependency(step.id.clone(), dep.clone()));
                }
            }
        }
        self.assert_acyclic()?;
        Ok(())
    }

    fn assert_acyclic(&self) -> Result<(), RecipeError> {
        let by_id: HashMap<&str, &StepDef> =
            self.steps.iter().map(|s| (s.id.as_str(), s)).collect();
        // Owned keys avoid the invariant-lifetime friction of HashMap<&str, _>.
        let mut color: HashMap<String, u8> = HashMap::new();
        for step in &self.steps {
            if color.get(step.id.as_str()).copied().unwrap_or(0) == 0 {
                self.visit(step.id.as_str(), &by_id, &mut color)?;
            }
        }
        Ok(())
    }

    fn visit(
        &self,
        id: &str,
        by_id: &HashMap<&str, &StepDef>,
        color: &mut HashMap<String, u8>,
    ) -> Result<(), RecipeError> {
        match color.get(id).copied().unwrap_or(0) {
            2 => return Ok(()),
            1 => return Err(RecipeError::CycleThrough(id.to_string())),
            _ => {}
        }
        color.insert(id.to_string(), 1);
        if let Some(step) = by_id.get(id) {
            for dep in &step.depends_on {
                self.visit(dep, by_id, color)?;
            }
        }
        color.insert(id.to_string(), 2);
        Ok(())
    }
}

/// The P2 prompt-to-playable-assets production recipe.
pub fn default_recipe() -> FlowRecipe {
    FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("memory", StepKind::Memory).depends_on("plan"))
        .step(StepDef::new("outline", StepKind::Outline).depends_on("memory"))
        .step(StepDef::new("character", StepKind::Character).depends_on("outline"))
        .step(
            StepDef::new("dialogist", StepKind::Scene)
                .agent("dialogist")
                .depends_on("character"),
        )
        .step(
            StepDef::new("assetPlan", StepKind::Asset)
                .agent("assetPlanner")
                .depends_on("dialogist"),
        )
        .step(
            StepDef::new("scene", StepKind::Scene)
                .agent("sceneScript")
                .depends_on("assetPlan"),
        )
        .step(
            StepDef::new("assetQueue", StepKind::Asset)
                .asset_queue()
                .depends_on("scene"),
        )
}

impl StepDef {
    pub fn depends_on(mut self, id: impl Into<String>) -> Self {
        self.depends_on.push(id.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum RecipeError {
    DuplicateStepId(String),
    UnknownDependency(String, String),
    CycleThrough(String),
}

impl std::fmt::Display for RecipeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecipeError::DuplicateStepId(id) => write!(f, "duplicate step id: {}", id),
            RecipeError::UnknownDependency(step, dep) => {
                write!(f, "step '{}' depends on unknown step '{}'", step, dep)
            }
            RecipeError::CycleThrough(id) => {
                write!(f, "dependency cycle detected through step '{}'", id)
            }
        }
    }
}

impl std::error::Error for RecipeError {}

#[cfg(test)]
mod tests {
    use super::{StepDef, StepExecutor};

    #[test]
    fn step_executor_round_trips_the_existing_agent_json_contract() {
        let default: StepDef = serde_json::from_str(
            r#"{"id":"plan","kind":"plan","dependsOn":[],"agent":null,"prompt":""}"#,
        )
        .unwrap();
        let named: StepDef = serde_json::from_str(
            r#"{"id":"dialogist","kind":"scene","dependsOn":[],"agent":"dialogist","prompt":""}"#,
        )
        .unwrap();
        let queue: StepDef = serde_json::from_str(
            r#"{"id":"media","kind":"asset","dependsOn":[],"agent":"assetQueue","prompt":""}"#,
        )
        .unwrap();

        assert_eq!(default.executor, StepExecutor::Agent);
        assert_eq!(named.executor, StepExecutor::NamedAgent("dialogist".into()));
        assert_eq!(queue.executor, StepExecutor::AssetQueue);
        assert_eq!(
            serde_json::to_value(default).unwrap()["agent"],
            serde_json::Value::Null
        );
        assert_eq!(serde_json::to_value(named).unwrap()["agent"], "dialogist");
        assert_eq!(serde_json::to_value(queue).unwrap()["agent"], "assetQueue");
    }
}
