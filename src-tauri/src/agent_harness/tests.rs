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
use std::sync::atomic::{AtomicUsize, Ordering};

use super::cassette::{self, Cassette};
use super::cli::AgentKind;
use super::gateway::RecordingGateway;
use super::gateway::ReplayGateway;
use super::scenario::{self, Scenario};
use crate::agents::router::ChatGateway;
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
        let kind = parse_kind(&manifest.agent).unwrap_or_else(|| {
            panic!(
                "{name}/fixture.json names unknown agent `{}`",
                manifest.agent
            )
        });
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
    assert!(
        root.join("full-plan").join("cassette.json").is_file(),
        "the committed full-chain recording is missing"
    );

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
            panic!(
                "chain step `{}` failed on recorded output: {error}",
                step.id
            );
        }
    }
    assert_eq!(
        report.steps.len(),
        chain::chain_steps().len(),
        "the chain stopped early: {:?}",
        report.steps.iter().map(|s| &s.id).collect::<Vec<_>>()
    );

    let expected_path = root.join("full-chain-expected.json");
    let text = std::fs::read_to_string(&expected_path)
        .expect("the committed full-chain-expected.json is missing");
    let expected: serde_json::Value =
        serde_json::from_str(&text).expect("full-chain-expected.json is malformed");
    let actual = serde_json::to_value(&report.plan).expect("plan is serializable");
    assert_eq!(
        actual, expected,
        "the replayed StoryPlan drifted from full-chain-expected.json"
    );
}

#[test]
fn every_cassette_is_structurally_sound() {
    let root = cassette::default_root();
    let names = cassette::list(&root).expect("cassette directory must be readable");
    assert!(
        !names.is_empty(),
        "the committed cassette fixtures are missing"
    );
    for name in names {
        let cassette =
            cassette::load(&root, &name).unwrap_or_else(|e| panic!("{name} failed to load: {e}"));
        cassette::verify(&cassette).unwrap_or_else(|e| panic!("{name} failed verification: {e}"));
    }
}

#[test]
fn real_repair_fixture_contains_a_failed_turn_and_a_repair_turn() {
    let root = cassette::default_root();
    let recorded = cassette::load(&root, "repair-outline-deepseek")
        .expect("the committed real repair cassette is missing");
    assert_eq!(recorded.provider, "deepseek");
    assert_eq!(recorded.interactions.len(), 2);
    assert!(recorded.interactions[1]
        .request
        .system
        .contains("JSON 修复器"));

    let first: serde_json::Value =
        serde_json::from_str(recorded.interactions[0].response.text.as_deref().unwrap())
            .expect("the first response must be valid JSON with an invalid scene filename");
    let files = first["scenePlans"].as_array().unwrap();
    assert!(files
        .iter()
        .any(|scene| { scene["file"].as_str().is_some_and(|file| !file.is_ascii()) }));
}

#[tokio::test]
async fn recorded_model_output_still_satisfies_the_agent_contract() {
    let fixtures = fixtures();
    for name in ["outline-deepseek", "repair-outline-deepseek"] {
        assert!(
            fixtures.iter().any(|fixture| fixture.name == name),
            "the committed {name} model fixture is missing or incomplete"
        );
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
            let expected: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{}/expected.json is malformed: {e}", fixture.name));
            assert_eq!(
                actual, expected,
                "{}: replayed payload drifted from expected.json",
                fixture.name
            );
        }
    }
}

#[derive(serde::Deserialize)]
struct RepairResponses {
    first: String,
    repaired: String,
}

struct ScriptedRepairGateway {
    responses: RepairResponses,
    calls: AtomicUsize,
}

impl ChatGateway for ScriptedRepairGateway {
    fn complete<'a>(
        &'a self,
        _system: &'a str,
        _user: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Option<(String, String, Option<u32>, Option<u32>)>, String>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let text = match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => &self.responses.first,
                1 => &self.responses.repaired,
                _ => return Err("unexpected third provider call".into()),
            };
            Ok(Some((text.clone(), "scripted".into(), Some(1), Some(1))))
        })
    }
}

#[tokio::test]
async fn bad_json_then_repair_records_and_replays_both_turns() {
    let responses: RepairResponses = serde_json::from_str(include_str!(
        "../../fixtures/agent-harness/repair-responses.json"
    ))
    .expect("repair response fixture must be valid");
    let gateway = ScriptedRepairGateway {
        responses,
        calls: AtomicUsize::new(0),
    };
    let recorder =
        RecordingGateway::new(gateway, "scripted".into(), "scripted".into(), String::new());
    let context = serde_json::json!({ "input": "test" });
    let validate = |value: &mut serde_json::Value| {
        if value["value"] == "repaired" {
            Ok(())
        } else {
            Err(crate::agents::AgentError("wrong value".into()))
        }
    };
    let recorded = crate::agents::router::generate_structured_validated::<serde_json::Value, _>(
        &recorder,
        "Test",
        "return value",
        &context,
        false,
        validate,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(recorded.value["value"], "repaired");
    let cassette = recorder.into_cassette();
    assert_eq!(
        cassette.interactions.len(),
        2,
        "JSON repair must make a second provider call"
    );
    cassette::verify(&cassette).unwrap();
    let replay = ReplayGateway::new(cassette, "scripted-repair");
    let replayed = crate::agents::router::generate_structured_validated::<serde_json::Value, _>(
        &replay,
        "Test",
        "return value",
        &context,
        false,
        validate,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(replayed.value, recorded.value);
}

#[tokio::test]
async fn replay_flag_reaches_probe_chat_and_media_before_any_provider_call() {
    use super::cli::{ChatArgs, GlobalArgs, MediaAction, ProbeArgs};
    use super::render::Renderer;

    let global = GlobalArgs {
        profile: None,
        record: None,
        replay: Some("missing".into()),
        cassette_dir: Some(
            std::env::temp_dir()
                .join(format!(
                    "ollaic-missing-cassette-{}-{}",
                    std::process::id(),
                    cassette::now_ms()
                ))
                .display()
                .to_string(),
        ),
        json: true,
    };
    let render = Renderer::new(true);
    let probe_error = super::run_probe(
        &render,
        &global,
        ProbeArgs {
            provider: Some("openai".into()),
            model: Some("gpt-4o-mini".into()),
            base_url: None,
            api_key: None,
            offline: false,
        },
    )
    .await
    .unwrap_err();
    assert!(
        probe_error.contains("failed to read cassette"),
        "{probe_error}"
    );

    let chat_error = super::run_chat(
        &render,
        &global,
        ChatArgs {
            prompt: "hello".into(),
            system: Some("system".into()),
            tools: None,
        },
    )
    .await
    .unwrap_err();
    assert!(
        chat_error.contains("failed to read cassette"),
        "{chat_error}"
    );

    let media_error = super::run_media(
        &render,
        &global,
        MediaAction::Tts {
            text: "hello".into(),
            model: Some("tts-1".into()),
            voice: String::new(),
            format: "mp3".into(),
            out: "unused.mp3".into(),
        },
    )
    .await
    .unwrap_err();
    assert!(
        media_error.contains("failed to read cassette"),
        "{media_error}"
    );
}
