//! Run the whole agent chain from a single Production Brief.
//!
//! The step list is derived from [`pipeline::dsl::default_recipe`] rather than
//! written out here, so the chain cannot silently drift from the Flow the app
//! actually runs. Between steps we reuse the pipeline's own
//! [`validate_output_contract`] and [`apply_output`], which is the point: a
//! green chain means each agent produced something the real orchestrator would
//! have accepted and committed, not merely something that deserialized.
//!
//! Steps whose executor is not an Agent (the P2 `assetQueue`) are skipped —
//! they generate media rather than call a chat model.

use std::time::Instant;

use crate::agents::{AgentOutput, AgentRegistry};
use crate::agents::router::{ChatGateway, ConfiguredChatGateway};
use crate::pipeline::dsl::{default_recipe, StepDef, StepExecutor};
use crate::pipeline::output_commit::{apply_output, validate_output_contract};
use crate::story_plan::types::StoryPlan;

use super::cassette;
use super::gateway::{RecordingGateway, ReplayGateway};
use super::scenario::Scenario;

/// The Production Brief the chain runs by default, kept beside the cassettes it
/// produced so it can be read and edited as prose rather than as an escaped
/// string literal. Every clause is there because some validator downstream
/// needs it:
///
/// - 三章 / 至少六个场景 → Plotter 的 `chapters` 非空、`scenePlans.len() >= 2`
/// - 一次真正的分歧、两个结局 → `branches.edges` 里至少一条带 `choice`
/// - 三个具名角色 + 各自说话方式 → Character 的非空 id/name，Dialogist 的分角色对白
/// - 点名地点 / 情绪 / 表情 → AssetPlanner 能分出背景、BGM、立绘三类任务
/// - 明确的入口场景 → Plotter 的 entry scene 必须是 start.txt
///
/// Editing it invalidates every recorded cassette, since it is the root of
/// every prompt in the chain. Re-record after changing it.
pub const COVERAGE_BRIEF: &str = include_str!("../../fixtures/agent-harness/coverage-brief.md");

/// One completed (or failed) step.
pub struct StepReport {
    pub id: String,
    pub kind: &'static str,
    pub executor: String,
    pub elapsed_ms: u64,
    pub model: Option<String>,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub interactions: usize,
    pub warnings: Vec<String>,
    pub downgrade: Option<String>,
    /// `Err` holds the contract or provider error that stopped the chain.
    pub outcome: Result<String, String>,
}

pub struct ChainReport {
    pub steps: Vec<StepReport>,
    pub plan: StoryPlan,
}

impl ChainReport {
    pub fn failed(&self) -> bool {
        self.steps.iter().any(|step| step.outcome.is_err())
    }
}

/// The agent-driven steps of the default recipe, in dependency order.
pub fn chain_steps() -> Vec<StepDef> {
    default_recipe()
        .steps
        .into_iter()
        .filter(|step| !matches!(step.executor, StepExecutor::AssetQueue))
        .collect()
}

pub struct ChainOptions {
    pub brief: String,
    pub allow_local_fallback: bool,
    /// Cassette name prefix; each step records to `<prefix>-<stepId>`.
    pub record: Option<String>,
    pub replay: Option<String>,
    pub cassette_root: std::path::PathBuf,
    /// Stop after this step id, for narrowing a failure.
    pub stop_after: Option<String>,
}

/// Drive every agent step, threading each output into the plan for the next.
/// Stops at the first failure — a later step fed a missing prerequisite would
/// only produce a confusing second error.
pub async fn run(options: ChainOptions) -> Result<ChainReport, String> {
    let registry = AgentRegistry::with_defaults();
    let mut plan = StoryPlan::new(options.brief.clone());
    let mut steps = Vec::new();

    for def in chain_steps() {
        let agent = match registry.get(def.kind, &def.executor) {
            Some(agent) => agent,
            None => continue,
        };

        let scenario = Scenario {
            plan: plan.clone(),
            brief: options.brief.clone(),
            instruction: def.prompt.clone(),
            allow_local_fallback: options.allow_local_fallback,
        };

        let cassette_name = |prefix: &str| format!("{prefix}-{}", def.id);
        let started = Instant::now();

        let (result, interactions) = match (&options.record, &options.replay) {
            (Some(prefix), _) => {
                let config = crate::ai::config::load_config();
                let recorder = RecordingGateway::new(
                    ConfiguredChatGateway,
                    config.provider.clone(),
                    config.model.clone(),
                    config.api_key.clone(),
                );
                let result = agent.run(&scenario.context(&recorder)).await;
                let cassette = recorder.into_cassette();
                let count = cassette.interactions.len();
                // Persist before propagating a failure: the recording is the
                // evidence for why the step failed.
                if count > 0 {
                    cassette::verify(&cassette)?;
                    cassette::save(&options.cassette_root, &cassette_name(prefix), &cassette)?;
                }
                (result, count)
            }
            (None, Some(prefix)) => {
                let name = cassette_name(prefix);
                // Cassette names here are derived, not user-supplied, and some
                // steps legitimately have none: `sceneScript` compiles drafts
                // to WebGAL text locally and never calls a model, so recording
                // produced no file. Treat a missing cassette as "made no
                // calls" — if the agent does call, the replay miss still fails
                // loudly and names this cassette.
                let cassette = match cassette::load(&options.cassette_root, &name) {
                    Ok(cassette) => cassette,
                    Err(_) if !cassette_exists(&options.cassette_root, &name) => {
                        cassette::Cassette::new(String::new(), String::new())
                    }
                    Err(error) => return Err(error),
                };
                let count = cassette.interactions.len();
                let replay = ReplayGateway::new(cassette, name);
                (agent.run(&scenario.context(&replay)).await, count)
            }
            (None, None) => {
                let gateway: &dyn ChatGateway = &ConfiguredChatGateway;
                (agent.run(&scenario.context(gateway)).await, 0)
            }
        };

        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let mut report = StepReport {
            id: def.id.clone(),
            kind: def.kind.as_str(),
            executor: describe_executor(&def.executor),
            elapsed_ms,
            model: None,
            prompt_tokens: None,
            completion_tokens: None,
            interactions,
            warnings: Vec::new(),
            downgrade: None,
            outcome: Ok(String::new()),
        };

        match result {
            Ok(output) => {
                report.model = output.model.clone();
                report.prompt_tokens = output.prompt_tokens;
                report.completion_tokens = output.completion_tokens;
                report.warnings = output.warnings.clone();
                report.downgrade = output.downgrade.clone();

                // The same gate the orchestrator applies before committing.
                match validate_output_contract(def.kind, &def.executor, &output) {
                    Ok(()) => {
                        report.outcome = Ok(summarize(&output));
                        apply_output(&mut plan, &output);
                        steps.push(report);
                    }
                    Err(error) => {
                        report.outcome = Err(error.0);
                        steps.push(report);
                        break;
                    }
                }
            }
            Err(error) => {
                report.outcome = Err(error.0);
                steps.push(report);
                break;
            }
        }

        if options.stop_after.as_deref() == Some(def.id.as_str()) {
            break;
        }
    }

    Ok(ChainReport { steps, plan })
}

/// Distinguishes "no cassette for this step" from "cassette exists but is
/// broken" — only the first is a normal condition worth tolerating.
fn cassette_exists(root: &std::path::Path, name: &str) -> bool {
    cassette::cassette_dir(root, name).join("cassette.json").is_file()
}

fn describe_executor(executor: &StepExecutor) -> String {
    match executor {
        StepExecutor::Agent => "agent".to_string(),
        StepExecutor::NamedAgent(name) => name.clone(),
        StepExecutor::AssetQueue => "assetQueue".to_string(),
    }
}

/// A one-line shape summary — what the step actually produced, in the units
/// that matter for that payload.
fn summarize(output: &AgentOutput) -> String {
    use crate::agents::AgentOutputPayload as P;
    match &output.payload {
        P::Synopsis(text) => format!("synopsis {} 字", text.chars().count()),
        P::Memory {
            worldbook,
            glossary,
        } => format!(
            "worldbook {} 字, glossary {} 条",
            worldbook.chars().count(),
            glossary.len()
        ),
        P::Outline {
            chapters,
            scene_plans,
            branches,
        } => format!(
            "{} 章, {} 场景, {} 条边, {} 个选择",
            chapters.len(),
            scene_plans.len(),
            branches.edges.len(),
            branches
                .edges
                .iter()
                .filter(|edge| edge.choice.is_some())
                .count()
        ),
        P::Characters(characters) => format!("{} 个角色", characters.len()),
        P::SceneDrafts(drafts) => format!(
            "{} 份草稿, {} 条对白",
            drafts.len(),
            drafts.iter().map(|d| d.beats.len()).sum::<usize>()
        ),
        P::AssetPlan(tasks) => format!("{} 个素材任务", tasks.len()),
        P::Scenes(scenes) => format!(
            "{} 个场景脚本, {} 行",
            scenes.len(),
            scenes
                .iter()
                .map(|s| s.content.lines().count())
                .sum::<usize>()
        ),
        P::AssetQueue(_) => "asset queue".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_follows_the_default_recipe_and_drops_non_agent_steps() {
        let ids: Vec<String> = chain_steps().into_iter().map(|step| step.id).collect();
        assert_eq!(
            ids,
            vec![
                "plan",
                "memory",
                "outline",
                "character",
                "dialogist",
                "assetPlan",
                "scene"
            ],
            "the chain must mirror default_recipe() order, minus assetQueue"
        );
    }

    #[test]
    fn every_chain_step_resolves_to_a_registered_agent() {
        let registry = AgentRegistry::with_defaults();
        for step in chain_steps() {
            assert!(
                registry.get(step.kind, &step.executor).is_some(),
                "step `{}` has no agent; `agent-harness chain` would silently skip it",
                step.id
            );
        }
    }
}
