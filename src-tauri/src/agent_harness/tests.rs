//! Offline regression: replay recorded provider output through the real
//! agents and assert their contract validators accept it.
//!
//! This is the point of the whole cassette mechanism. `agents/outline.rs` and
//! friends validate hard (unique scene ids, safe filenames, non-empty chapters)
//! but every other test in the repo feeds them hand-written perfect JSON. Here
//! the input is what a model actually returned.
//!
//! Each fixture directory under `fixtures/agent-harness/` may carry an `expected.json`
//! holding the serialized `AgentOutput` payload; when present the replayed run
//! must reproduce it exactly.

use std::path::PathBuf;

use super::cassette::{self, Cassette};
use super::cli::AgentKind;
use super::gateway::ReplayGateway;
use super::scenario::{self, Scenario};
use crate::agents::AgentRegistry;
use crate::story_plan::types::StoryPlan;

/// A fixture pairs a cassette with the StoryPlan that produced it.
struct Fixture {
    name: String,
    dir: PathBuf,
    cassette: Cassette,
    scenario: Scenario,
    kind: AgentKind,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    /// Which agent to replay: plan | memory | outline | character | asset |
    /// scene | dialogist.
    agent: String,
    #[serde(default)]
    brief: String,
    #[serde(default)]
    instruction: String,
    #[serde(default)]
    allow_local_fallback: bool,
}

fn parse_kind(value: &str) -> Option<AgentKind> {
    match value {
        "plan" => Some(AgentKind::Plan),
        "memory" => Some(AgentKind::Memory),
        "outline" => Some(AgentKind::Outline),
        "character" => Some(AgentKind::Character),
        "asset" => Some(AgentKind::Asset),
        "scene" => Some(AgentKind::Scene),
        "dialogist" => Some(AgentKind::Dialogist),
        _ => None,
    }
}

/// Collect every fixture that is complete enough to replay. A cassette without
/// `fixture.json` + `plan.json` is a raw recording kept for reading, not a
/// regression case, so it is skipped rather than failed.
fn fixtures() -> Vec<Fixture> {
    let root = cassette::default_root();
    let mut out = Vec::new();
    for name in cassette::list(&root).unwrap_or_default() {
        let dir = cassette::cassette_dir(&root, &name);
        let (Ok(manifest_text), Ok(plan_text)) = (
            std::fs::read_to_string(dir.join("fixture.json")),
            std::fs::read_to_string(dir.join("plan.json")),
        ) else {
            continue;
        };

        let manifest: FixtureManifest = serde_json::from_str(&manifest_text)
            .unwrap_or_else(|e| panic!("{name}/fixture.json is malformed: {e}"));
        let plan: StoryPlan = serde_json::from_str(&plan_text)
            .unwrap_or_else(|e| panic!("{name}/plan.json is not a StoryPlan: {e}"));
        let kind = parse_kind(&manifest.agent)
            .unwrap_or_else(|| panic!("{name}/fixture.json names unknown agent `{}`", manifest.agent));
        let cassette = cassette::load(&root, &name)
            .unwrap_or_else(|e| panic!("{name} cassette failed to load: {e}"));

        let brief = if manifest.brief.trim().is_empty() {
            plan.prompt.clone()
        } else {
            manifest.brief.clone()
        };
        out.push(Fixture {
            name,
            dir,
            cassette,
            scenario: Scenario {
                plan,
                brief,
                instruction: manifest.instruction,
                allow_local_fallback: manifest.allow_local_fallback,
            },
            kind,
        });
    }
    out
}

/// The whole chain, replayed. This is the broadest regression the repo has:
/// one Production Brief driving all seven agents, each output passing the same
/// contract gate the orchestrator applies before committing it — against
/// output a real model actually produced.
#[tokio::test]
async fn the_full_chain_replays_and_every_step_passes_its_commit_contract() {
    use super::chain;

    let root = cassette::default_root();
    if !root.join("full-plan").join("cassette.json").is_file() {
        // No chain recording in this checkout; the per-agent fixtures below
        // still run. Record one with `agent-harness --record full chain`.
        return;
    }

    let report = chain::run(chain::ChainOptions {
        brief: chain::COVERAGE_BRIEF.to_string(),
        allow_local_fallback: false,
        record: None,
        replay: Some("full".to_string()),
        cassette_root: root.clone(),
        stop_after: None,
    })
    .await
    .expect("replaying the chain must not fail at the harness level");

    for step in &report.steps {
        if let Err(error) = &step.outcome {
            panic!("chain step `{}` failed on recorded output: {error}", step.id);
        }
    }
    assert_eq!(
        report.steps.len(),
        chain::chain_steps().len(),
        "the chain stopped early: {:?}",
        report.steps.iter().map(|s| &s.id).collect::<Vec<_>>()
    );

    let expected_path = root.join("full-chain-expected.json");
    if let Ok(text) = std::fs::read_to_string(&expected_path) {
        let expected: serde_json::Value =
            serde_json::from_str(&text).expect("full-chain-expected.json is malformed");
        let actual = serde_json::to_value(&report.plan).expect("plan is serializable");
        assert_eq!(
            actual, expected,
            "the replayed StoryPlan drifted from full-chain-expected.json"
        );
    }
}

#[test]
fn every_cassette_is_structurally_sound() {
    let root = cassette::default_root();
    for name in cassette::list(&root).unwrap_or_default() {
        let cassette = cassette::load(&root, &name)
            .unwrap_or_else(|e| panic!("{name} failed to load: {e}"));
        cassette::verify(&cassette)
            .unwrap_or_else(|e| panic!("{name} failed verification: {e}"));
    }
}

#[tokio::test]
async fn recorded_model_output_still_satisfies_the_agent_contract() {
    let fixtures = fixtures();
    if fixtures.is_empty() {
        // Nothing recorded yet. The harness's own unit tests still cover the
        // record/replay machinery; this test starts biting once a real
        // cassette lands under fixtures/agent-harness/.
        return;
    }

    let registry = AgentRegistry::with_defaults();
    for fixture in fixtures {
        let agent = scenario::resolve_agent(&registry, fixture.kind)
            .unwrap_or_else(|e| panic!("{}: {e}", fixture.name));
        let replay = ReplayGateway::new(fixture.cassette, fixture.name.clone());

        let output = agent
            .run(&fixture.scenario.context(&replay))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "{}: replaying recorded output failed the agent contract: {}",
                    fixture.name, e.0
                )
            });

        let actual = serde_json::to_value(&output)
            .unwrap_or_else(|e| panic!("{}: output is not serializable: {e}", fixture.name));

        let expected_path = fixture.dir.join("expected.json");
        if let Ok(text) = std::fs::read_to_string(&expected_path) {
            let expected: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| {
                panic!("{}/expected.json is malformed: {e}", fixture.name)
            });
            assert_eq!(
                actual, expected,
                "{}: replayed payload drifted from expected.json",
                fixture.name
            );
        }
    }
}
