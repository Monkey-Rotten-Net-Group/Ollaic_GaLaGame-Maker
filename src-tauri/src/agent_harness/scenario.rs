//! Turn a StoryPlan into the inputs one Agent needs.
//!
//! The field mapping mirrors `pipeline::scheduler`'s context assembly (search
//! for `let ctx = AgentContext {`); if a new field is added there, add it here
//! too or `agent-harness agent` starts lying about what the Flow actually runs.

use std::path::Path;

use crate::agents::{AgentContext, AgentRegistry};
use crate::agents::router::ChatGateway;
use crate::pipeline::dsl::{StepExecutor, StepKind};
use crate::story_plan::{self, types::StoryPlan};

use super::cli::AgentKind;

/// Everything an agent run needs, owned so the borrowed `AgentContext` can be
/// built at the call site without fighting lifetimes.
pub struct Scenario {
    pub plan: StoryPlan,
    pub brief: String,
    pub instruction: String,
    pub allow_local_fallback: bool,
}

impl Scenario {
    /// Read the StoryPlan from a project's `.ollaic/plan.json`.
    pub fn from_project(project: &Path) -> Result<StoryPlan, String> {
        match story_plan::load_plan(project) {
            Ok(Some(plan)) => Ok(plan),
            Ok(None) => Err(format!(
                "no StoryPlan at {} — run a Flow in the app first, or pass --scenario",
                story_plan::plan_path(project).display()
            )),
            Err(error) => Err(format!("failed to load StoryPlan: {error}")),
        }
    }

    /// Read a StoryPlan from a standalone JSON file.
    pub fn from_file(path: &Path) -> Result<StoryPlan, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read scenario {}: {e}", path.display()))?;
        serde_json::from_str(&text)
            .map_err(|e| format!("scenario {} is not a valid StoryPlan: {e}", path.display()))
    }

    /// Borrow this scenario as the context the Flow would hand the agent.
    pub fn context<'a>(&'a self, chat: &'a dyn ChatGateway) -> AgentContext<'a> {
        AgentContext {
            chat,
            prompt: &self.brief,
            instruction: &self.instruction,
            synopsis: &self.plan.synopsis,
            chapters: &self.plan.chapters,
            worldbook: &self.plan.memory.worldbook,
            glossary: &self.plan.memory.glossary,
            characters: &self.plan.characters,
            scene_plans: &self.plan.scene_plans,
            branches: &self.plan.branches,
            scene_drafts: &self.plan.scene_drafts,
            asset_plan: &self.plan.asset_plan,
            allow_local_fallback: self.allow_local_fallback,
        }
    }
}

/// How the registry addresses each selectable agent. `Dialogist` is a named
/// role rather than a step kind, matching `AgentRegistry::with_defaults`.
pub fn registry_key(kind: AgentKind) -> (StepKind, StepExecutor) {
    match kind {
        AgentKind::Plan => (StepKind::Plan, StepExecutor::Agent),
        AgentKind::Memory => (StepKind::Memory, StepExecutor::Agent),
        AgentKind::Outline => (StepKind::Outline, StepExecutor::Agent),
        AgentKind::Character => (StepKind::Character, StepExecutor::Agent),
        AgentKind::Asset => (StepKind::Asset, StepExecutor::Agent),
        AgentKind::Scene => (StepKind::Scene, StepExecutor::Agent),
        AgentKind::Dialogist => (
            StepKind::Scene,
            StepExecutor::NamedAgent("dialogist".to_string()),
        ),
    }
}

pub fn resolve_agent(
    registry: &AgentRegistry,
    kind: AgentKind,
) -> Result<&dyn crate::agents::Agent, String> {
    let (step_kind, executor) = registry_key(kind);
    registry
        .get(step_kind, &executor)
        .ok_or_else(|| format!("no agent registered for {kind:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_selectable_agent_resolves_in_the_default_registry() {
        let registry = AgentRegistry::with_defaults();
        for kind in [
            AgentKind::Plan,
            AgentKind::Memory,
            AgentKind::Outline,
            AgentKind::Character,
            AgentKind::Asset,
            AgentKind::Scene,
            AgentKind::Dialogist,
        ] {
            assert!(
                resolve_agent(&registry, kind).is_ok(),
                "{kind:?} must be reachable, or `agent-harness agent {kind:?}` is dead"
            );
        }
    }

    #[test]
    fn context_carries_the_plan_through() {
        struct Unused;
        impl ChatGateway for Unused {
            fn complete<'a>(
                &'a self,
                _system: &'a str,
                _user: &'a str,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<
                                Option<(String, String, Option<u32>, Option<u32>)>,
                                String,
                            >,
                        > + Send
                        + 'a,
                >,
            > {
                Box::pin(async { Ok(None) })
            }
        }

        let mut plan = StoryPlan::new("原始 Brief");
        plan.synopsis = "一个夏天的故事".into();
        let scenario = Scenario {
            plan,
            brief: "原始 Brief".into(),
            instruction: "多写两章".into(),
            allow_local_fallback: true,
        };

        let gateway = Unused;
        let ctx = scenario.context(&gateway);
        assert_eq!(ctx.prompt, "原始 Brief");
        assert_eq!(ctx.instruction, "多写两章");
        assert_eq!(ctx.synopsis, "一个夏天的故事");
        assert!(ctx.allow_local_fallback);
    }
}
