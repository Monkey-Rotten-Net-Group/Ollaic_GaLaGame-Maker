//! Integration tests for the Pipeline Orchestrator. These exercise the
//! scheduler through its public API (`Pipeline::create_run` / `execute` and
//! `RunHandle` controls) with injectable agents, a deterministic clock, and a
//! recording sink - no LLM, no browser, no real time.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex as AsyncMutex, Notify, Semaphore};
use tokio::time::{sleep, timeout, Duration};

use crate::agents::{
    Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload, AgentRegistry,
};
use crate::asset_queue::{AssetGenerator, AssetTask, GeneratedArtifact};
use crate::pipeline::asset_executor::AssetGeneratorFactory;
use crate::pipeline::dsl::{default_recipe, FlowRecipe, RecipeError, StepDef, StepKind};
use crate::pipeline::events::{EventSink, PipelineEvent, RecordingSink};
use crate::pipeline::project_state::project_has_story_content;
use crate::pipeline::recovery::cleanup_rollback_snapshots;
use crate::pipeline::scheduler::{Pipeline, RunCreation, DEFAULT_STEP_TIMEOUT};
use crate::pipeline::state::{Clock, RunStatus, StepRunHistory, StepStatus, SystemClock};
use crate::story_plan::types::ChapterPlan;

// ---------- test helpers ----------

/// A clock that returns an incrementing value on each call, for stable
/// timestamps in assertions.
struct StepClock {
    next: std::sync::Mutex<u64>,
}
impl StepClock {
    fn new() -> Self {
        StepClock {
            next: std::sync::Mutex::new(1_700_000_000_000),
        }
    }
}
impl Clock for StepClock {
    fn now_ms(&self) -> u64 {
        let mut n = self.next.lock().unwrap();
        let v = *n;
        *n += 1;
        v
    }
}

/// An agent that blocks on a `Notify` gate before returning a fixed output,
/// giving tests a deterministic window to pause/resume or simulate a crash.
struct ControllableAgent {
    gate: Arc<Notify>,
    output: AgentOutput,
}
impl Agent for ControllableAgent {
    fn run<'a>(
        &'a self,
        _ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        let gate = self.gate.clone();
        let output = self.output.clone();
        Box::pin(async move {
            gate.notified().await;
            Ok(output)
        })
    }
}

/// An agent that always fails.
struct FailingAgent {
    message: String,
}
impl Agent for FailingAgent {
    fn run<'a>(
        &'a self,
        _ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        let message = self.message.clone();
        Box::pin(async move { Err(AgentError(message)) })
    }
}

/// Makes the run-state directory unwritable immediately before failing, so
/// the scheduler's terminal transition is the first write that fails.
struct StoreSabotagingAgent {
    project: std::path::PathBuf,
}

struct StepSucceededStoreSabotagingSink {
    project: std::path::PathBuf,
    events: std::sync::Mutex<Vec<PipelineEvent>>,
    sabotaged: std::sync::atomic::AtomicBool,
}

impl StepSucceededStoreSabotagingSink {
    fn new(project: std::path::PathBuf) -> Self {
        Self {
            project,
            events: std::sync::Mutex::new(Vec::new()),
            sabotaged: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn events(&self) -> Vec<PipelineEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl EventSink for StepSucceededStoreSabotagingSink {
    fn emit(&self, event: PipelineEvent) {
        if matches!(event, PipelineEvent::StepSucceeded { .. })
            && !self.sabotaged.swap(true, Ordering::SeqCst)
        {
            let state_dir = crate::pipeline::store::run_state_dir(&self.project);
            std::fs::remove_dir_all(&state_dir).unwrap();
            std::fs::write(&state_dir, b"not a directory").unwrap();
        }
        self.events.lock().unwrap().push(event);
    }
}

struct MissingMediaCapabilityFactory;
struct UnusedAssetGenerator;

struct LockProbeAgent {
    entered: Arc<Semaphore>,
    release: Arc<Notify>,
}

impl Agent for LockProbeAgent {
    fn run<'a>(
        &'a self,
        _ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.add_permits(1);
            release.notified().await;
            Ok(synopsis_output("done"))
        })
    }
}

impl AssetGeneratorFactory for MissingMediaCapabilityFactory {
    fn preflight_run(&self, allow_local_fallback: bool) -> Result<(), String> {
        if allow_local_fallback {
            Ok(())
        } else {
            Err("未配置图片生成能力".to_string())
        }
    }

    fn create(
        &self,
        _allow_local_fallback: bool,
        _cancelled: Arc<std::sync::atomic::AtomicBool>,
    ) -> Arc<dyn AssetGenerator> {
        Arc::new(UnusedAssetGenerator)
    }
}

impl AssetGenerator for UnusedAssetGenerator {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async { panic!("preflight must reject before asset execution") })
    }
}
impl Agent for StoreSabotagingAgent {
    fn run<'a>(
        &'a self,
        _ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        let project = self.project.clone();
        Box::pin(async move {
            let state_dir = crate::pipeline::store::run_state_dir(&project);
            std::fs::remove_dir_all(&state_dir).unwrap();
            std::fs::write(&state_dir, b"not a directory").unwrap();
            Err(AgentError("provider failed".to_string()))
        })
    }
}

/// An agent that never resolves, to exercise the step timeout.
struct HangingAgent;
impl Agent for HangingAgent {
    fn run<'a>(
        &'a self,
        _ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(std::future::pending())
    }
}

/// An agent that fails the first N calls, then succeeds. For retry tests.
struct OnceFailingAgent {
    fails_left: Arc<AsyncMutex<u32>>,
    output: AgentOutput,
}
impl Agent for OnceFailingAgent {
    fn run<'a>(
        &'a self,
        _ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        let fails = self.fails_left.clone();
        let output = self.output.clone();
        Box::pin(async move {
            let mut n = fails.lock().await;
            if *n > 0 {
                *n -= 1;
                return Err(AgentError("flaky failure".to_string()));
            }
            drop(n);
            Ok(output)
        })
    }
}

/// An instant agent that counts how many times it ran.
struct CountingAgent {
    calls: Arc<AtomicU32>,
    output: AgentOutput,
}
impl Agent for CountingAgent {
    fn run<'a>(
        &'a self,
        _ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        let calls = self.calls.clone();
        let output = self.output.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(output)
        })
    }
}

fn synopsis_output(text: &str) -> AgentOutput {
    AgentOutput::new(AgentOutputPayload::Synopsis(text.to_string()))
}

fn pipeline_test_character(name: &str) -> crate::characters::types::Character {
    crate::characters::types::Character {
        id: "hero".to_string(),
        name: name.to_string(),
        aliases: Vec::new(),
        description: String::new(),
        personality: String::new(),
        reference_images: Vec::new(),
        stance: String::new(),
        keywords: Vec::new(),
        dialogue_style: String::new(),
        gender: String::new(),
        age: String::new(),
        sprites: Vec::new(),
        default_voice: None,
        voice_timbre: None,
        relations: Vec::new(),
        color_theme: None,
        notes: String::new(),
    }
}

fn chapters_output() -> AgentOutput {
    AgentOutput::new(AgentOutputPayload::Outline {
        chapters: vec![
            ChapterPlan {
                id: "ch1".to_string(),
                title: "序章".to_string(),
                summary: "s1".to_string(),
            },
            ChapterPlan {
                id: "ch2".to_string(),
                title: "第一章".to_string(),
                summary: "s2".to_string(),
            },
        ],
        scene_plans: Vec::new(),
        branches: Default::default(),
    })
}

fn fresh_project(name: &str) -> std::path::PathBuf {
    let tmp = std::env::temp_dir().join(format!("ollaic_pipeline_{}", name));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    tmp
}

/// Human-readable event sequence: run events by name, step events by
/// `{type}:{step_id}`.
fn labels(events: &[PipelineEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| match e {
            PipelineEvent::RunStarted { .. } => "run_started".to_string(),
            PipelineEvent::StepStarted { step_id, .. } => format!("step_started:{}", step_id),
            PipelineEvent::StepSucceeded { step_id, .. } => format!("step_succeeded:{}", step_id),
            PipelineEvent::StepFailed { step_id, .. } => format!("step_failed:{}", step_id),
            PipelineEvent::StepSkipped { step_id, .. } => format!("step_skipped:{}", step_id),
            PipelineEvent::RunPaused { .. } => "run_paused".to_string(),
            PipelineEvent::RunResumed { .. } => "run_resumed".to_string(),
            PipelineEvent::RunCompleted { .. } => "run_completed".to_string(),
            PipelineEvent::RunFailed { .. } => "run_failed".to_string(),
            PipelineEvent::RunTimedOut { .. } => "run_timed_out".to_string(),
            PipelineEvent::RunPersistenceFailed { .. } => "run_persistence_failed".to_string(),
            PipelineEvent::RunStopped { .. } => "run_stopped".to_string(),
        })
        .collect()
}

/// Wait until the sink's events satisfy `predicate`, or panic after a timeout.
async fn wait_until<F>(sink: &RecordingSink, predicate: F)
where
    F: Fn(&[PipelineEvent]) -> bool,
{
    timeout(Duration::from_secs(3), async {
        loop {
            if predicate(&sink.events()) {
                return;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("timed out waiting for pipeline events");
}

// ---------- DSL ----------

#[test]
fn default_recipe_is_valid() {
    assert!(default_recipe().validate().is_ok());
}

#[test]
fn media_capability_gap_rejects_asset_recipe_before_run_creation() {
    let project = fresh_project("media_capability_preflight");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents()
        .with_asset_generators_for_test(Arc::new(MissingMediaCapabilityFactory));
    let recipe = FlowRecipe::new().step(StepDef::new("assetQueue", StepKind::Asset).asset_queue());

    let result = pipeline.create_run_with_options(RunCreation {
        project_path: &project,
        run_id: "run_media_preflight",
        prompt: "brief",
        recipe: &recipe,
        allow_local_fallback: false,
        step_timeout: Some(DEFAULT_STEP_TIMEOUT),
        clock: &clock,
        sink: &sink,
    });
    let error = match result {
        Ok(_) => panic!("media capability gap must reject run creation"),
        Err(error) => error,
    };

    assert!(error.to_string().contains("未配置图片生成能力"));
    assert!(sink.events().is_empty());
    assert!(
        crate::pipeline::load_run_state(&project, "run_media_preflight")
            .unwrap()
            .is_none()
    );
    assert!(crate::story_plan::load_plan(&project).unwrap().is_none());
}

#[test]
fn explicit_local_fallback_accepts_asset_recipe_with_media_gap() {
    let project = fresh_project("media_capability_fallback");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents()
        .with_asset_generators_for_test(Arc::new(MissingMediaCapabilityFactory));
    let recipe = FlowRecipe::new().step(StepDef::new("assetQueue", StepKind::Asset).asset_queue());

    let handle = pipeline
        .create_run_with_options(RunCreation {
            project_path: &project,
            run_id: "run_media_fallback",
            prompt: "brief",
            recipe: &recipe,
            allow_local_fallback: true,
            step_timeout: Some(DEFAULT_STEP_TIMEOUT),
            clock: &clock,
            sink: &sink,
        })
        .expect("explicit fallback should satisfy media capability review");

    assert!(handle.state().try_lock().unwrap().allow_local_fallback);
    assert!(matches!(
        sink.events().as_slice(),
        [PipelineEvent::RunStarted { .. }]
    ));
}

#[test]
fn ipc_contract_serializes_to_camel_case() {
    // Pin the exact JSON shape the frontend (pipeline-ipc.ts) must match.
    use serde_json::json;

    let step_started = PipelineEvent::StepStarted {
        run_id: "run_1".to_string(),
        step_id: "plan".to_string(),
        kind: "plan".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&step_started).unwrap(),
        json!({
            "type": "stepStarted",
            "runId": "run_1",
            "stepId": "plan",
            "kind": "plan"
        })
    );

    let run_failed = PipelineEvent::RunFailed {
        run_id: "run_1".to_string(),
        error: "boom".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&run_failed).unwrap(),
        json!({ "type": "runFailed", "runId": "run_1", "error": "boom" })
    );

    let run_timed_out = PipelineEvent::RunTimedOut {
        run_id: "run_1".to_string(),
        error: "step timed out".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&run_timed_out).unwrap(),
        json!({ "type": "runTimedOut", "runId": "run_1", "error": "step timed out" })
    );

    let persistence_failed = PipelineEvent::RunPersistenceFailed {
        run_id: "run_1".to_string(),
        error: "disk full".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&persistence_failed).unwrap(),
        json!({ "type": "runPersistenceFailed", "runId": "run_1", "error": "disk full" })
    );

    assert_eq!(
        serde_json::to_value(PipelineEvent::RunStopped {
            run_id: "run_1".to_string(),
        })
        .unwrap(),
        json!({ "type": "runStopped", "runId": "run_1" })
    );

    // RunState / StepState / StepDef / enums also camelCase.
    let recipe = default_recipe();
    let state = crate::pipeline::state::RunState::new("run_1", ".", "brief", &recipe, 100);
    let v = serde_json::to_value(&state).unwrap();
    assert_eq!(v["runId"], "run_1");
    assert_eq!(v["projectPath"], ".");
    assert_eq!(v["status"], "idle");
    assert_eq!(v["steps"][0]["def"]["kind"], "plan");
    assert_eq!(v["steps"][0]["status"], "pending");
    assert_eq!(v["steps"][1]["def"]["dependsOn"][0], "plan");
}

#[test]
fn recipe_rejects_a_dependency_cycle() {
    let recipe = FlowRecipe::new()
        .step(StepDef::new("a", StepKind::Plan).depends_on("b"))
        .step(StepDef::new("b", StepKind::Outline).depends_on("a"));
    assert!(matches!(
        recipe.validate(),
        Err(RecipeError::CycleThrough(_))
    ));
}

#[test]
fn recipe_rejects_unknown_dependency() {
    let recipe = FlowRecipe::new().step(StepDef::new("a", StepKind::Plan).depends_on("ghost"));
    assert!(matches!(
        recipe.validate(),
        Err(RecipeError::UnknownDependency(_, _))
    ));
}

// ---------- scheduler: tracer bullet ----------

#[tokio::test]
async fn runs_full_p2_recipe_and_binds_generated_assets() {
    let project = fresh_project("happy");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();

    let handle = pipeline
        .create_run(
            &project,
            "run_1",
            "赛博朋克校园恋爱",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    // Drive the run to completion.
    timeout(
        Duration::from_secs(3),
        pipeline.execute(&project, handle.clone(), sink.as_ref(), &clock),
    )
    .await
    .expect("run did not complete in time");

    let seq = labels(&sink.events());
    assert_eq!(
        seq,
        vec![
            "run_started",
            "step_started:plan",
            "step_succeeded:plan",
            "step_started:memory",
            "step_succeeded:memory",
            "step_started:outline",
            "step_succeeded:outline",
            "step_started:character",
            "step_succeeded:character",
            "step_started:dialogist",
            "step_succeeded:dialogist",
            "step_started:assetPlan",
            "step_succeeded:assetPlan",
            "step_started:scene",
            "step_succeeded:scene",
            "step_started:assetQueue",
            "step_succeeded:assetQueue",
            "run_completed",
        ]
    );

    // The StoryPlan absorbed every step's output.
    let plan = crate::story_plan::load_plan(&project).unwrap().unwrap();
    assert!(plan.synopsis.contains("赛博朋克校园恋爱"));
    assert_eq!(plan.chapters.len(), 3);
    assert_eq!(plan.chapters[0].id, "ch1");
    assert!(plan.chapters[0].summary.contains("赛博朋克校园恋爱"));
    assert_eq!(plan.characters.len(), 3);
    assert_eq!(plan.scene_plans.len(), 6);
    assert_eq!(plan.scene_drafts.len(), 6);
    assert!(plan.asset_plan.len() >= 10);
    assert_eq!(plan.scenes.len(), 6);
    assert!(project.join("game/scene/start.txt").is_file());
    assert!(project.join("game/scene/ending_trust.txt").is_file());
    let opening = std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap();
    assert!(opening.contains("林夏:"));
    assert!(opening.contains("changeScene:chapter_01.txt;"));
    assert!(opening.contains("changeBg:"));
    assert!(opening.contains("bgm:"));
    assert!(opening.contains("changeFigure:"));
    let decision = std::fs::read_to_string(project.join("game/scene/decision.txt")).unwrap();
    assert!(decision.contains(
        "choose:握住她的手，一起承担:ending_trust.txt|遵守协议，回到日常:ending_depart.txt;"
    ));
    assert!(project.join("game/config/characters.json").is_file());
    assert!(project
        .join("game/background")
        .read_dir()
        .unwrap()
        .next()
        .is_some());
    assert!(project
        .join("game/figure")
        .read_dir()
        .unwrap()
        .next()
        .is_some());
    assert!(project
        .join("game/bgm")
        .read_dir()
        .unwrap()
        .next()
        .is_some());
    let asset_queue = crate::asset_queue::load_queue(&project).unwrap();
    assert!(!asset_queue.tasks.is_empty());
    assert!(asset_queue
        .tasks
        .iter()
        .all(|task| task.status == crate::asset_queue::AssetTaskStatus::Succeeded));
    assert!(asset_queue
        .tasks
        .iter()
        .all(|task| task.attempts.len() <= 4));
    let queue_json = serde_json::to_value(&asset_queue).unwrap();
    assert!(queue_json["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|task| task["usedLocalFallback"] == true));
    let asset_step = handle
        .state
        .lock()
        .await
        .find_step("assetQueue")
        .unwrap()
        .clone();
    assert_eq!(
        asset_step.history[0].downgrade.as_deref(),
        Some("local-placeholder-assets")
    );
    assert!(!asset_step.history[0].warnings.is_empty());

    // Run history was recorded.
    assert_eq!(plan.pipeline_runs.len(), 1);
    assert_eq!(plan.pipeline_runs[0].run_id, "run_1");
    assert_eq!(plan.pipeline_runs[0].status, "completed");

    // Run state persisted as completed.
    let run_state = crate::pipeline::load_run_state(&project, "run_1")
        .unwrap()
        .unwrap();
    assert_eq!(run_state.status, RunStatus::Completed);
    assert!(run_state.all_steps_succeeded());
    assert!(run_state.steps.iter().all(|step| step.history.len() == 1));
    let plan_input: serde_json::Value =
        serde_json::from_str(&run_state.find_step("plan").unwrap().history[0].input_snapshot)
            .unwrap();
    assert_eq!(plan_input["productionBrief"], "赛博朋克校园恋爱");
    let outline_input: serde_json::Value =
        serde_json::from_str(&run_state.find_step("outline").unwrap().history[0].input_snapshot)
            .unwrap();
    assert!(outline_input["synopsis"]
        .as_str()
        .unwrap()
        .contains("赛博朋克校园恋爱"));
    assert!(run_state.find_step("outline").unwrap().history[0]
        .duration_ms
        .is_some());
}

#[tokio::test]
async fn flow_resources_are_locked_while_a_step_uses_them() {
    let project = fresh_project("character_flow_scope");
    let project_string = project.to_string_lossy().to_string();
    crate::characters::commands::save_characters(
        project_string.clone(),
        vec![pipeline_test_character("Before")],
    )
    .unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Notify::new());
    let mut agents = AgentRegistry::new();
    agents.register(
        StepKind::Plan,
        Box::new(LockProbeAgent {
            entered: entered.clone(),
            release: release.clone(),
        }),
    );
    let pipeline = Arc::new(Pipeline::new(agents));
    let sink = Arc::new(RecordingSink::new());
    let clock = Arc::new(StepClock::new());
    let recipe = FlowRecipe::new().step(StepDef::new("plan", StepKind::Plan));
    let handle = pipeline
        .create_run(
            &project,
            "run_character_flow_scope",
            "brief",
            &recipe,
            clock.as_ref(),
            sink.as_ref(),
        )
        .unwrap();
    let snapshot = crate::webgal::project::create_project_snapshot(
        project_string.clone(),
        Some("before-running-step".to_string()),
        Some("manual".to_string()),
        None,
    )
    .unwrap();
    let execution = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let sink = sink.clone();
        let clock = clock.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), clock.as_ref())
                .await;
        })
    };

    entered.acquire().await.unwrap().forget();
    let edit_error = crate::characters::commands::update_character(
        project_string.clone(),
        pipeline_test_character("During"),
    )
    .unwrap_err();
    assert!(edit_error.contains("Agent Flow 正在使用角色资料"));
    let restore_error = crate::webgal::project::restore_project_snapshot(
        project_string.clone(),
        snapshot.id.clone(),
    )
    .unwrap_err();
    assert!(restore_error.contains("Agent Flow 正在使用故事计划"));

    release.notify_one();
    execution.await.unwrap();
    crate::webgal::project::restore_project_snapshot(project_string.clone(), snapshot.id).unwrap();
    crate::characters::commands::update_character(
        project_string.clone(),
        pipeline_test_character("After"),
    )
    .unwrap();
    assert_eq!(
        crate::characters::commands::list_characters(project_string).unwrap()[0].name,
        "After"
    );
}

#[test]
fn invalid_story_plan_is_rejected_before_run_state_is_created() {
    let project = fresh_project("invalid_plan_start");
    let plan_path = crate::story_plan::plan_path(&project);
    std::fs::create_dir_all(plan_path.parent().unwrap()).unwrap();
    std::fs::write(&plan_path, r#"{"version":99,"prompt":"x"}"#).unwrap();
    let pipeline = Pipeline::with_default_agents();
    let sink = RecordingSink::new();
    let clock = StepClock::new();

    assert!(pipeline
        .create_run(
            &project,
            "run_invalid_plan",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .is_err());
    assert!(
        !crate::pipeline::run_state_path(&project, "run_invalid_plan")
            .unwrap()
            .exists()
    );
}

#[test]
fn crash_resume_rejects_an_invalid_story_plan_without_mutating_the_run() {
    let project = fresh_project("invalid_plan_resume");
    let pipeline = Pipeline::with_default_agents();
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    pipeline
        .create_run(
            &project,
            "run_invalid_resume",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();
    let before = crate::pipeline::load_run_state(&project, "run_invalid_resume")
        .unwrap()
        .unwrap();
    std::fs::write(crate::story_plan::plan_path(&project), "{").unwrap();

    assert!(pipeline
        .resume_run(&project, "run_invalid_resume", &sink, &clock)
        .is_err());
    let after = crate::pipeline::load_run_state(&project, "run_invalid_resume")
        .unwrap()
        .unwrap();
    assert_eq!(after, before);
}

// ---------- scheduler: failure ----------

#[tokio::test]
async fn failed_step_fails_run_and_skips_downstream() {
    let project = fresh_project("fail");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();

    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(FailingAgent {
            message: "model overload".to_string(),
        }),
    );
    agents.register(StepKind::Memory, Box::new(crate::agents::MemoryAgent));
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    agents.register(StepKind::Scene, Box::new(crate::agents::SceneAgent));
    let pipeline = Pipeline::new(agents);

    let handle = pipeline
        .create_run(
            &project,
            "run_fail",
            "brief",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    timeout(
        Duration::from_secs(3),
        pipeline.execute(&project, handle.clone(), sink.as_ref(), &clock),
    )
    .await
    .expect("run did not finish");

    let seq = labels(&sink.events());
    assert_eq!(
        seq,
        vec![
            "run_started",
            "step_started:plan",
            "step_failed:plan",
            "run_failed",
        ]
    );

    // Downstream outline never ran.
    let run_state = crate::pipeline::load_run_state(&project, "run_fail")
        .unwrap()
        .unwrap();
    assert_eq!(run_state.status, RunStatus::Failed);
    assert_eq!(
        run_state.find_step("plan").unwrap().status,
        StepStatus::Failed
    );
    assert_eq!(
        run_state.find_step("outline").unwrap().status,
        StepStatus::Pending
    );
}

// ---------- scheduler: pause / resume ----------

#[tokio::test]
async fn pause_then_resume_completes_run() {
    let project = fresh_project("pause");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();

    let plan_gate = Arc::new(Notify::new());
    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(ControllableAgent {
            gate: plan_gate.clone(),
            output: synopsis_output("【梗概】暂停测试"),
        }),
    );
    agents.register(StepKind::Memory, Box::new(crate::agents::MemoryAgent));
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    agents.register(StepKind::Scene, Box::new(crate::agents::SceneAgent));
    let pipeline = Pipeline::new(agents);

    let handle = pipeline
        .create_run(
            &project,
            "run_pause",
            "brief",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    let project_cloned = project.clone();
    let handle_for_task = handle.clone();
    let sink_for_task = sink.clone();
    let task = tokio::spawn(async move {
        pipeline
            .execute(
                &project_cloned,
                handle_for_task,
                sink_for_task.as_ref(),
                &SystemClock,
            )
            .await;
    });
    // Pause/resume/retry/skip all live on RunHandle, so no Pipeline is needed
    // for control calls after the task is spawned.

    // Let the Plan step start (agent now awaiting its gate).
    wait_until(&sink, |e| {
        e.iter()
            .any(|ev| matches!(ev, PipelineEvent::StepStarted { step_id, .. } if step_id == "plan"))
    })
    .await;

    // Pause while Plan is running.
    handle
        .pause(&project, sink.as_ref(), &SystemClock)
        .await
        .unwrap();
    wait_until(&sink, |e| {
        e.iter()
            .any(|ev| matches!(ev, PipelineEvent::RunPaused { .. }))
    })
    .await;

    // Let Plan finish; the loop then sees Paused and waits for resume.
    plan_gate.notify_one();
    wait_until(&sink, |e| {
        e.iter().any(
            |ev| matches!(ev, PipelineEvent::StepSucceeded { step_id, .. } if step_id == "plan"),
        )
    })
    .await;

    // Resume: Outline should run and the run should complete.
    handle
        .resume(&project, sink.as_ref(), &SystemClock)
        .await
        .unwrap();

    let _ = timeout(Duration::from_secs(3), task)
        .await
        .expect("task timed out");

    let seq = labels(&sink.events());
    assert!(seq.contains(&"run_paused".to_string()));
    assert!(seq.contains(&"run_resumed".to_string()));
    // Order: plan succeeds, then paused, then resumed, then outline.
    let plan_succeeded_idx = seq.iter().position(|s| s == "step_succeeded:plan").unwrap();
    let paused_idx = seq.iter().position(|s| s == "run_paused").unwrap();
    let resumed_idx = seq.iter().position(|s| s == "run_resumed").unwrap();
    let outline_started_idx = seq
        .iter()
        .position(|s| s == "step_started:outline")
        .unwrap();
    assert!(plan_succeeded_idx < paused_idx || paused_idx < plan_succeeded_idx); // either order is fine
    assert!(
        resumed_idx < outline_started_idx,
        "outline must start after resume"
    );
    assert!(seq.contains(&"run_completed".to_string()));

    let run_state = crate::pipeline::load_run_state(&project, "run_pause")
        .unwrap()
        .unwrap();
    assert_eq!(run_state.status, RunStatus::Completed);
}

// ---------- scheduler: timeout ----------

#[tokio::test]
async fn step_timeout_terminates_run_as_timeout() {
    let project = fresh_project("timeout");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();

    let mut agents = AgentRegistry::with_defaults();
    agents.register(StepKind::Plan, Box::new(HangingAgent));
    agents.register(StepKind::Memory, Box::new(crate::agents::MemoryAgent));
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    agents.register(StepKind::Scene, Box::new(crate::agents::SceneAgent));
    let pipeline = Pipeline::new(agents).with_step_timeout(Duration::from_millis(50));

    let handle = pipeline
        .create_run(
            &project,
            "run_timeout",
            "brief",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    // The hanging Plan agent must be cut off by the step timeout, not hang the run.
    timeout(
        Duration::from_secs(3),
        pipeline.execute(&project, handle.clone(), sink.as_ref(), &clock),
    )
    .await
    .expect("run did not finish in time");

    let run_state = crate::pipeline::load_run_state(&project, "run_timeout")
        .unwrap()
        .unwrap();
    assert_eq!(run_state.status, RunStatus::Timeout);
    assert!(sink.events().iter().any(|event| matches!(
        event,
        PipelineEvent::RunTimedOut { run_id, .. } if run_id == "run_timeout"
    )));
    assert!(!sink.events().iter().any(|event| matches!(
        event,
        PipelineEvent::RunFailed { run_id, .. } if run_id == "run_timeout"
    )));
    let plan = run_state.find_step("plan").unwrap();
    assert_eq!(plan.status, StepStatus::Failed);
    assert!(plan.error.as_deref().unwrap().contains("timed out"));
}

#[tokio::test]
async fn terminal_save_failure_emits_only_persistence_failure() {
    let project = fresh_project("terminal_save_failure");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let mut agents = AgentRegistry::new();
    agents.register(
        StepKind::Plan,
        Box::new(StoreSabotagingAgent {
            project: project.clone(),
        }),
    );
    let pipeline = Pipeline::new(agents);
    let recipe = FlowRecipe::new().step(StepDef::new("plan", StepKind::Plan));
    let handle = pipeline
        .create_run(
            &project,
            "run_terminal_save_failure",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    pipeline
        .execute(&project, handle.clone(), sink.as_ref(), &clock)
        .await;

    let events = sink.events();
    assert!(events.iter().any(|event| matches!(
        event,
        PipelineEvent::RunPersistenceFailed { run_id, error }
            if run_id == "run_terminal_save_failure" && error.contains("无法保存运行 'run_terminal_save_failure' 的失败终态")
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        PipelineEvent::StepFailed { .. }
            | PipelineEvent::RunFailed { .. }
            | PipelineEvent::RunTimedOut { .. }
    )));
    assert_eq!(
        handle.state().lock().await.status,
        RunStatus::PersistenceFailed
    );
}

#[tokio::test]
async fn completion_save_failure_emits_only_persistence_failure() {
    let project = fresh_project("completion_save_failure");
    let sink = StepSucceededStoreSabotagingSink::new(project.clone());
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let recipe = FlowRecipe::new().step(StepDef::new("plan", StepKind::Plan));
    let handle = pipeline
        .create_run(
            &project,
            "run_completion_save_failure",
            "brief",
            &recipe,
            &clock,
            &sink,
        )
        .unwrap();

    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    let events = sink.events();
    assert!(events.iter().any(|event| matches!(
        event,
        PipelineEvent::RunPersistenceFailed { run_id, .. }
            if run_id == "run_completion_save_failure"
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        PipelineEvent::RunCompleted { .. } | PipelineEvent::RunFailed { .. }
    )));
    assert_eq!(
        handle.state().lock().await.status,
        RunStatus::PersistenceFailed
    );
}

#[tokio::test]
async fn blocked_run_save_failure_emits_only_persistence_failure() {
    let project = fresh_project("blocked_save_failure");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let recipe = FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("outline", StepKind::Outline).depends_on("plan"));
    let handle = pipeline
        .create_run(
            &project,
            "run_blocked_save_failure",
            "brief",
            &recipe,
            &clock,
            &sink,
        )
        .unwrap();
    {
        let mut state = handle.state().lock().await;
        let plan = state.find_step_mut("plan").unwrap();
        plan.status = StepStatus::Failed;
        plan.error = Some("upstream failed".to_string());
    }
    let state_dir = crate::pipeline::store::run_state_dir(&project);
    std::fs::remove_dir_all(&state_dir).unwrap();
    std::fs::write(&state_dir, b"not a directory").unwrap();

    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    let events = sink.events();
    assert!(events.iter().any(|event| matches!(
        event,
        PipelineEvent::RunPersistenceFailed { run_id, .. }
            if run_id == "run_blocked_save_failure"
    )));
    assert!(!events
        .iter()
        .any(|event| matches!(event, PipelineEvent::RunFailed { .. })));
    assert_eq!(
        handle.state().lock().await.status,
        RunStatus::PersistenceFailed
    );
}

#[tokio::test]
async fn pause_after_step_save_failure_emits_only_persistence_failure() {
    let project = fresh_project("pause_after_step_save_failure");
    let sink = StepSucceededStoreSabotagingSink::new(project.clone());
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let recipe = FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("outline", StepKind::Outline).depends_on("plan"));
    let handle = pipeline
        .create_run(
            &project,
            "run_pause_after_step_save_failure",
            "brief",
            &recipe,
            &clock,
            &sink,
        )
        .unwrap();
    handle.pause(&project, &sink, &clock).await.unwrap();
    handle.step_once(&project, &sink, &clock).await.unwrap();

    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    let events = sink.events();
    assert!(events.iter().any(|event| matches!(
        event,
        PipelineEvent::RunPersistenceFailed { run_id, .. }
            if run_id == "run_pause_after_step_save_failure"
    )));
    assert!(!events
        .iter()
        .any(|event| matches!(event, PipelineEvent::RunFailed { .. })));
    assert_eq!(
        handle.state().lock().await.status,
        RunStatus::PersistenceFailed
    );
}

#[tokio::test(start_paused = true)]
async fn asset_queue_timeout_is_persisted_as_timeout_not_cancellation() {
    let project = fresh_project("asset_queue_timeout");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let started = Arc::new(Semaphore::new(0));

    let pipeline = Arc::new(
        Pipeline::with_default_agents()
            .with_hanging_asset_queue_for_test(started.clone())
            .with_step_timeout(Duration::from_secs(30)),
    );
    let recipe =
        FlowRecipe::new().step(StepDef::new("assetQueue", StepKind::Asset).agent("assetQueue"));
    let handle = pipeline
        .create_run(
            &project,
            "run_asset_queue_timeout",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };

    started.acquire().await.unwrap().forget();
    tokio::time::advance(Duration::from_secs(30)).await;
    task.await.unwrap();

    let persisted = crate::pipeline::load_run_state(&project, "run_asset_queue_timeout")
        .unwrap()
        .unwrap();
    assert_eq!(persisted.status, RunStatus::Timeout);
    assert_ne!(persisted.status, RunStatus::Cancelled);
    assert!(persisted
        .find_step("assetQueue")
        .unwrap()
        .error
        .as_deref()
        .unwrap()
        .contains("timed out"));
}

#[tokio::test(start_paused = true)]
async fn asset_queue_user_stop_is_cancelled_not_timeout() {
    let project = fresh_project("asset_queue_cancelled");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let started = Arc::new(Semaphore::new(0));
    let pipeline = Arc::new(
        Pipeline::with_default_agents()
            .with_hanging_asset_queue_for_test(started.clone())
            .with_step_timeout(Duration::from_secs(30)),
    );
    let recipe =
        FlowRecipe::new().step(StepDef::new("assetQueue", StepKind::Asset).agent("assetQueue"));
    let handle = pipeline
        .create_run(
            &project,
            "run_asset_queue_cancelled",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };

    started.acquire().await.unwrap().forget();
    handle.stop(&project, sink.as_ref(), &clock).await.unwrap();
    task.await.unwrap();

    let persisted = crate::pipeline::load_run_state(&project, "run_asset_queue_cancelled")
        .unwrap()
        .unwrap();
    assert_eq!(persisted.status, RunStatus::Cancelled);
    assert_ne!(persisted.status, RunStatus::Timeout);
}

#[tokio::test(start_paused = true)]
async fn production_constructor_times_out_a_hanging_agent() {
    let project = fresh_project("production_timeout");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let mut agents = AgentRegistry::with_defaults();
    agents.register(StepKind::Plan, Box::new(HangingAgent));
    let pipeline = Arc::new(Pipeline::with_agents_and_matting(
        agents,
        Err("model unavailable in test".to_string()),
    ));
    let recipe = FlowRecipe::new().step(StepDef::new("plan", StepKind::Plan));
    let handle = pipeline
        .create_run(
            &project,
            "run_production_timeout",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };

    tokio::task::yield_now().await;
    tokio::time::advance(DEFAULT_STEP_TIMEOUT).await;
    task.await.unwrap();

    assert_eq!(handle.state().lock().await.status, RunStatus::Timeout);
}

/// A run created with `create_run_with_timeout` keeps its custom deadline
/// even when the underlying Pipeline was configured with a much longer
/// default. This is the regression for the requirement: a new Flow must
/// snapshot the Provider capability that was live at run-creation time and
/// not inherit whatever the singleton Pipeline happened to have.
#[tokio::test(start_paused = true)]
async fn create_run_with_timeout_overrides_pipeline_default() {
    let project = fresh_project("custom_deadline");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let mut agents = AgentRegistry::with_defaults();
    agents.register(StepKind::Plan, Box::new(HangingAgent));
    let pipeline = Pipeline::new(agents).with_step_timeout(Duration::from_secs(3600));

    let recipe = FlowRecipe::new().step(StepDef::new("plan", StepKind::Plan));
    let handle = pipeline
        .create_run_with_timeout(RunCreation {
            project_path: &project,
            run_id: "run_custom_deadline",
            prompt: "brief",
            recipe: &recipe,
            allow_local_fallback: false,
            step_timeout: Some(Duration::from_millis(50)),
            clock: &clock,
            sink: sink.as_ref(),
        })
        .unwrap();
    assert_eq!(handle.step_timeout, Some(Duration::from_millis(50)));

    let pipeline = Arc::new(pipeline);
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };

    tokio::time::advance(Duration::from_millis(50)).await;
    task.await.unwrap();
    assert_eq!(handle.state().lock().await.status, RunStatus::Timeout);
}

/// Regression for "asset timeout 后 retry": a prior `RunStatus::Timeout` on
/// the assetQueue step must allow a clean retry without deleting the run
/// state. The retry surfaces the same deterministic failure again, proving
/// the timeout recovery path runs rather than a cached skip.
#[tokio::test(start_paused = true)]
async fn asset_queue_retry_after_timeout_runs_again() {
    let project = fresh_project("asset_queue_retry");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let started = Arc::new(Semaphore::new(0));
    let pipeline = Arc::new(
        Pipeline::with_default_agents()
            .with_hanging_asset_queue_for_test(started.clone())
            .with_step_timeout(Duration::from_secs(30)),
    );
    let recipe =
        FlowRecipe::new().step(StepDef::new("assetQueue", StepKind::Asset).agent("assetQueue"));
    let handle = pipeline
        .create_run_with_timeout(RunCreation {
            project_path: &project,
            run_id: "run_retry",
            prompt: "brief",
            recipe: &recipe,
            allow_local_fallback: false,
            step_timeout: Some(Duration::from_secs(30)),
            clock: &clock,
            sink: sink.as_ref(),
        })
        .unwrap();
    let first = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };
    started.acquire().await.unwrap().forget();
    tokio::time::advance(Duration::from_secs(30)).await;
    first.await.unwrap();
    assert_eq!(handle.state().lock().await.status, RunStatus::Timeout);

    // Simulate a user retry: clear the assetQueue step and rerun. A clean
    // Timeout must not silently disable retry; the step has to enter the
    // select! again with a fresh hanging future.
    let mut state = crate::pipeline::load_run_state(&project, "run_retry")
        .unwrap()
        .unwrap();
    state.status = RunStatus::Running;
    if let Some(step) = state.find_step_mut("assetQueue") {
        step.status = StepStatus::Pending;
        step.error = None;
        step.started_at = None;
        step.finished_at = None;
    }
    crate::pipeline::store::save_run_state(&project, &state).unwrap();
    // The handle's in-memory state still records `Timeout` from the first
    // run; reload it from disk so the second `execute` enters the normal
    // loop instead of bailing out at the terminal-status guard.
    {
        let mut memory = handle.state.lock().await;
        *memory = state;
    }
    let second = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };
    started.acquire().await.unwrap().forget();
    tokio::time::advance(Duration::from_secs(31)).await;
    second.await.unwrap();
    assert_eq!(handle.state().lock().await.status, RunStatus::Timeout);
}

// ---------- scheduler: crash-resume ----------

#[tokio::test]
async fn crash_resume_does_not_redo_succeeded_steps() {
    let project = fresh_project("crash");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();

    let plan_calls = Arc::new(AtomicU32::new(0));
    let outline_gate = Arc::new(Notify::new());
    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(CountingAgent {
            calls: plan_calls.clone(),
            output: synopsis_output("【梗概】崩溃恢复"),
        }),
    );
    agents.register(StepKind::Memory, Box::new(crate::agents::MemoryAgent));
    agents.register(
        StepKind::Outline,
        Box::new(ControllableAgent {
            gate: outline_gate.clone(),
            output: chapters_output(),
        }),
    );
    agents.register(StepKind::Scene, Box::new(crate::agents::SceneAgent));
    let pipeline = Arc::new(Pipeline::new(agents));

    let recipe = FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("outline", StepKind::Outline).depends_on("plan"));
    let handle = pipeline
        .create_run(
            &project,
            "run_crash",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    // First lifecycle: Plan completes (instant), Outline starts and blocks.
    let pipeline1 = pipeline.clone();
    let project1 = project.clone();
    let handle1 = handle.clone();
    let sink1 = sink.clone();
    let task = tokio::spawn(async move {
        pipeline1
            .execute(&project1, handle1, sink1.as_ref(), &SystemClock)
            .await;
    });
    wait_until(&sink, |e| {
        e.iter().any(
            |ev| matches!(ev, PipelineEvent::StepStarted { step_id, .. } if step_id == "outline"),
        )
    })
    .await;

    // Simulate a crash: abort the task and drop the handle.
    task.abort();
    let _ = task.await;

    // Persisted state: Plan succeeded, Outline was left Running.
    let persisted = crate::pipeline::load_run_state(&project, "run_crash")
        .unwrap()
        .unwrap();
    assert_eq!(
        persisted.find_step("plan").unwrap().status,
        StepStatus::Succeeded
    );
    assert_eq!(
        persisted.find_step("outline").unwrap().status,
        StepStatus::Running
    );

    // Resume from disk with a fresh sink. Plan must NOT be re-run.
    let resumed_sink = Arc::new(RecordingSink::new());
    let resumed_handle = pipeline
        .resume_run(&project, "run_crash", resumed_sink.as_ref(), &SystemClock)
        .unwrap();
    let project2 = project.clone();
    let resumed_handle2 = resumed_handle.clone();
    let resumed_sink2 = resumed_sink.clone();
    let pipeline2 = pipeline.clone();
    let resume_task = tokio::spawn(async move {
        pipeline2
            .execute(
                &project2,
                resumed_handle2,
                resumed_sink2.as_ref(),
                &SystemClock,
            )
            .await;
    });
    // Outline is now Pending (reset by resume_run) and waiting on the gate.
    wait_until(&resumed_sink, |e| {
        e.iter().any(
            |ev| matches!(ev, PipelineEvent::StepStarted { step_id, .. } if step_id == "outline"),
        )
    })
    .await;
    outline_gate.notify_one();
    let _ = timeout(Duration::from_secs(3), resume_task)
        .await
        .expect("resume did not complete");

    // Plan was run exactly once (the first lifecycle), never re-run on resume.
    assert_eq!(plan_calls.load(Ordering::SeqCst), 1);

    let seq = labels(&resumed_sink.events());
    assert!(
        !seq.iter().any(|s| s.contains("plan")),
        "plan must not be re-run after resume: {:?}",
        seq
    );
    assert_eq!(
        seq.iter().filter(|s| s == &"run_resumed").count(),
        1,
        "resume should emit RunResumed once: {:?}",
        seq
    );
    assert!(seq.contains(&"step_started:outline".to_string()));
    assert!(seq.contains(&"step_succeeded:outline".to_string()));
    assert!(seq.contains(&"run_completed".to_string()));

    let run_state = crate::pipeline::load_run_state(&project, "run_crash")
        .unwrap()
        .unwrap();
    assert_eq!(run_state.status, RunStatus::Completed);
}

#[test]
fn crash_resume_restores_persistent_rollback_snapshot_before_retry() {
    let project = fresh_project("crash_file_rollback");
    let scene_dir = project.join("game/scene");
    std::fs::create_dir_all(&scene_dir).unwrap();
    std::fs::write(scene_dir.join("start.txt"), ":original;").unwrap();
    let pipeline = Pipeline::with_default_agents();
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    pipeline
        .create_run(
            &project,
            "run_crash_file_rollback",
            "brief",
            &FlowRecipe::new().step(StepDef::new("plan", StepKind::Plan)),
            &clock,
            &sink,
        )
        .unwrap();
    let snapshot = crate::webgal::project::create_project_snapshot(
        project.to_string_lossy().to_string(),
        Some("pipeline rollback test".to_string()),
        Some("auto".to_string()),
        None,
    )
    .unwrap();
    std::fs::write(scene_dir.join("start.txt"), ":partial new output;").unwrap();

    let mut state = crate::pipeline::load_run_state(&project, "run_crash_file_rollback")
        .unwrap()
        .unwrap();
    state.find_step_mut("plan").unwrap().status = StepStatus::Running;
    state
        .find_step_mut("plan")
        .unwrap()
        .history
        .push(StepRunHistory {
            attempt: 1,
            input_snapshot: "{}".to_string(),
            output: None,
            error: None,
            started_at: 1,
            finished_at: None,
            duration_ms: None,
            diff: None,
            cost: None,
            prompt_tokens: None,
            completion_tokens: None,
            warnings: Vec::new(),
            downgrade: None,
            rollback_snapshot: Some(snapshot.id),
        });
    crate::pipeline::store::save_run_state(&project, &state).unwrap();

    let resumed = pipeline
        .resume_run(&project, "run_crash_file_rollback", &sink, &clock)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scene_dir.join("start.txt")).unwrap(),
        ":original;"
    );
    assert_eq!(
        resumed
            .state()
            .blocking_lock()
            .find_step("plan")
            .unwrap()
            .status,
        StepStatus::Pending
    );
}

// ---------- scheduler: skip ----------

#[tokio::test]
async fn skip_step_unblocks_downstream() {
    let project = fresh_project("skip");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();

    let plan_gate = Arc::new(Notify::new());
    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(ControllableAgent {
            gate: plan_gate.clone(),
            output: synopsis_output("skipped-plan"),
        }),
    );
    agents.register(StepKind::Memory, Box::new(crate::agents::MemoryAgent));
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    agents.register(StepKind::Scene, Box::new(crate::agents::SceneAgent));
    let pipeline = Pipeline::new(agents);

    let recipe = FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("outline", StepKind::Outline).depends_on("plan"))
        .step(StepDef::new("scene", StepKind::Scene).depends_on("outline"));
    let handle = pipeline
        .create_run(
            &project,
            "run_skip",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    let project_c = project.clone();
    let handle_c = handle.clone();
    let sink_c = sink.clone();
    let task = tokio::spawn(async move {
        pipeline
            .execute(&project_c, handle_c, sink_c.as_ref(), &SystemClock)
            .await;
    });

    // Wait for Plan to start (blocked on gate).
    wait_until(&sink, |e| {
        e.iter()
            .any(|ev| matches!(ev, PipelineEvent::StepStarted { step_id, .. } if step_id == "plan"))
    })
    .await;

    // While Plan is running, skip the still-pending Scene step (the user opts
    // out of scene generation). Plan then Outline run; Scene is never started.
    handle
        .skip_step(&project, "scene", sink.as_ref(), &SystemClock)
        .await
        .unwrap();

    // Let Plan finish; Outline runs, Scene is skipped, the run completes.
    plan_gate.notify_one();
    let _ = timeout(Duration::from_secs(3), task)
        .await
        .expect("run did not complete");

    let seq = labels(&sink.events());
    assert!(seq.contains(&"step_skipped:scene".to_string()));
    assert!(
        !seq.iter().any(|s| s == "step_started:scene"),
        "scene must not run: {:?}",
        seq
    );
    assert!(seq.contains(&"step_started:outline".to_string()));
    assert!(seq.contains(&"run_completed".to_string()));
    let run_state = crate::pipeline::load_run_state(&project, "run_skip")
        .unwrap()
        .unwrap();
    assert_eq!(run_state.status, RunStatus::Completed);
    assert_eq!(
        run_state.find_step("plan").unwrap().status,
        StepStatus::Succeeded
    );
    assert_eq!(
        run_state.find_step("outline").unwrap().status,
        StepStatus::Succeeded
    );
    assert_eq!(
        run_state.find_step("scene").unwrap().status,
        StepStatus::Skipped
    );
}

// ---------- scheduler: retry ----------

#[tokio::test]
async fn retry_step_reruns_and_completes() {
    let project = fresh_project("retry");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();

    let fails_left = Arc::new(AsyncMutex::new(1u32));
    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(OnceFailingAgent {
            fails_left: fails_left.clone(),
            output: synopsis_output("【梗概】重试成功"),
        }),
    );
    agents.register(StepKind::Memory, Box::new(crate::agents::MemoryAgent));
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    agents.register(StepKind::Scene, Box::new(crate::agents::SceneAgent));
    let pipeline = Pipeline::new(agents);

    let handle = pipeline
        .create_run(
            &project,
            "run_retry",
            "brief",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    let project_c = project.clone();
    let handle_c = handle.clone();
    let sink_c = sink.clone();
    let task = tokio::spawn(async move {
        pipeline
            .execute(&project_c, handle_c, sink_c.as_ref(), &SystemClock)
            .await;
    });

    // Plan fails on the first attempt -> run fails (execute returns).
    wait_until(&sink, |e| {
        e.iter()
            .any(|ev| matches!(ev, PipelineEvent::RunFailed { .. }))
    })
    .await;
    let _ = timeout(Duration::from_secs(1), task).await;

    // Retry Plan: it now succeeds (fails_left exhausted).
    handle
        .retry_step(&project, "plan", sink.as_ref(), &SystemClock)
        .await
        .unwrap();

    // Re-drive execution. The handle's state now has Plan=Pending and
    // status=Running; spawn a fresh execute task to continue the run.
    let handle2 = handle.clone();
    let project2 = project.clone();
    let sink2 = sink.clone();
    let pipeline_for_resume = Pipeline::new({
        let mut a = AgentRegistry::with_defaults();
        a.register(StepKind::Plan, Box::new(crate::agents::PlanAgent));
        a.register(StepKind::Memory, Box::new(crate::agents::MemoryAgent));
        a.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
        a.register(StepKind::Scene, Box::new(crate::agents::SceneAgent));
        a
    });
    let resume_task = tokio::spawn(async move {
        pipeline_for_resume
            .execute(&project2, handle2, sink2.as_ref(), &SystemClock)
            .await;
    });
    let _ = timeout(Duration::from_secs(3), resume_task)
        .await
        .expect("retry did not complete");

    let seq = labels(&sink.events());
    // Plan started twice (first attempt failed, second succeeded).
    assert_eq!(
        seq.iter().filter(|s| s == &"step_started:plan").count(),
        2,
        "plan should be started twice: {:?}",
        seq
    );
    assert_eq!(
        seq.iter().filter(|s| s == &"step_succeeded:plan").count(),
        1,
        "plan should succeed once: {:?}",
        seq
    );
    assert!(seq.contains(&"run_completed".to_string()));

    let run_state = crate::pipeline::load_run_state(&project, "run_retry")
        .unwrap()
        .unwrap();
    assert_eq!(run_state.status, RunStatus::Completed);
    let plan_step = run_state.find_step("plan").unwrap();
    assert_eq!(plan_step.history.len(), 2);
    assert!(plan_step.history[0].error.is_some());
    assert!(plan_step.history[1].output.is_some());
}

#[tokio::test]
async fn retrying_a_completed_step_resets_it_and_its_downstream() {
    let project = fresh_project("retry_completed");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let handle = pipeline
        .create_run(
            &project,
            "run_retry_completed",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();

    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    assert_eq!(handle.state().lock().await.status, RunStatus::Completed);

    handle
        .retry_step(&project, "plan", &sink, &clock)
        .await
        .unwrap();
    let state = handle.state().lock().await;
    assert_eq!(state.status, RunStatus::Running);
    assert_eq!(state.find_step("plan").unwrap().status, StepStatus::Pending);
    assert_eq!(
        state.find_step("outline").unwrap().status,
        StepStatus::Pending
    );
}

#[tokio::test]
async fn scene_write_failure_fails_the_step_instead_of_claiming_success() {
    let project = fresh_project("scene_write_failure");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let recipe = FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("outline", StepKind::Outline).depends_on("plan"))
        .step(StepDef::new("scene", StepKind::Scene).depends_on("outline"));
    let handle = pipeline
        .create_run(
            &project,
            "run_scene_write_failure",
            "brief",
            &recipe,
            &clock,
            &sink,
        )
        .unwrap();
    std::fs::create_dir_all(project.join("game")).unwrap();
    std::fs::write(project.join("game/scene"), "not a directory").unwrap();

    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    let state = handle.state().lock().await;
    assert_eq!(state.status, RunStatus::Failed);
    assert_eq!(state.find_step("scene").unwrap().status, StepStatus::Failed);
    assert!(state
        .find_step("scene")
        .unwrap()
        .error
        .as_deref()
        .unwrap()
        .contains("scene"));
    assert!(!labels(&sink.events()).contains(&"step_succeeded:scene".to_string()));
}

#[tokio::test]
async fn multi_scene_write_failure_rolls_back_earlier_scene_files() {
    let project = fresh_project("scene_write_rollback");
    let scene_dir = project.join("game/scene");
    std::fs::create_dir_all(&scene_dir).unwrap();
    std::fs::write(scene_dir.join("start.txt"), ":original;").unwrap();
    std::fs::create_dir(scene_dir.join("chapter_01.txt")).unwrap();
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let handle = pipeline
        .create_run(
            &project,
            "run_scene_write_rollback",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();

    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    let state = handle.state().lock().await;
    assert_eq!(state.find_step("scene").unwrap().status, StepStatus::Failed);
    assert_eq!(
        std::fs::read_to_string(scene_dir.join("start.txt")).unwrap(),
        ":original;"
    );
    drop(state);
    let plan = crate::story_plan::load_plan(&project).unwrap().unwrap();
    assert!(plan.scenes.is_empty());
}

#[tokio::test]
async fn transition_persistence_failure_stops_before_running_the_agent() {
    let project = fresh_project("transition_write_failure");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let handle = pipeline
        .create_run(
            &project,
            "run_transition_write_failure",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();
    let run_dir = project.join(".ollaic").join("pipeline");
    std::fs::remove_dir_all(&run_dir).unwrap();
    std::fs::write(&run_dir, "not a directory").unwrap();

    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    assert_eq!(
        handle.state().lock().await.status,
        RunStatus::PersistenceFailed
    );
    let events = labels(&sink.events());
    assert!(events.contains(&"run_persistence_failed".to_string()));
    assert!(!events.contains(&"run_failed".to_string()));
    assert!(!events
        .iter()
        .any(|event| event.starts_with("step_started:")));
}

#[tokio::test]
async fn pending_dependencies_are_editable_but_cycles_are_rejected() {
    let project = fresh_project("dependency_edit");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let handle = pipeline
        .create_run(
            &project,
            "run_dependency_edit",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();

    assert!(handle
        .update_dependencies(&project, "plan", vec!["outline".to_string()], &clock)
        .await
        .is_err());
    handle
        .update_dependencies(&project, "outline", Vec::new(), &clock)
        .await
        .unwrap();

    let persisted = crate::pipeline::load_run_state(&project, "run_dependency_edit")
        .unwrap()
        .unwrap();
    assert!(persisted
        .find_step("outline")
        .unwrap()
        .def
        .depends_on
        .is_empty());
}

#[tokio::test]
async fn stop_discards_in_flight_output_and_persists_cancelled() {
    let project = fresh_project("stop");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let gate = Arc::new(Notify::new());
    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(ControllableAgent {
            gate: gate.clone(),
            output: synopsis_output("must not be applied"),
        }),
    );
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    let pipeline = Arc::new(Pipeline::new(agents));
    let handle = pipeline
        .create_run(
            &project,
            "run_stop",
            "brief",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };
    wait_until(&sink, |events| {
        events.iter().any(|event| matches!(event, PipelineEvent::StepStarted { step_id, .. } if step_id == "plan"))
    })
    .await;

    handle.stop(&project, sink.as_ref(), &clock).await.unwrap();
    gate.notify_one();
    timeout(Duration::from_secs(3), task)
        .await
        .expect("cancelled driver did not finish")
        .unwrap();

    let persisted = crate::pipeline::load_run_state(&project, "run_stop")
        .unwrap()
        .unwrap();
    assert_eq!(persisted.status, RunStatus::Cancelled);
    let plan_step = persisted.find_step("plan").unwrap();
    assert_eq!(plan_step.status, StepStatus::Pending);
    assert_eq!(
        plan_step.history.last().unwrap().error.as_deref(),
        Some("cancelled before completion")
    );
    assert!(labels(&sink.events()).contains(&"run_stopped".to_string()));
    assert!(crate::story_plan::load_plan(&project)
        .unwrap()
        .unwrap()
        .synopsis
        .is_empty());
}

#[tokio::test]
async fn retry_after_stop_ignores_the_cancelled_attempt_result() {
    let project = fresh_project("stop_retry");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let gate = Arc::new(Notify::new());
    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(ControllableAgent {
            gate: gate.clone(),
            output: synopsis_output("accepted only on retry"),
        }),
    );
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    let pipeline = Arc::new(Pipeline::new(agents));
    // A minimal recipe keeps this test focused on retry-after-stop semantics
    // and out of the flaky assetQueue generation path.
    let recipe = FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("outline", StepKind::Outline).depends_on("plan"));
    let handle = pipeline
        .create_run(
            &project,
            "run_stop_retry",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    // First drive: Plan blocks on the gate; stop() truly aborts it, so the
    // first driver returns without the gate being released.
    let first = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };
    wait_until(&sink, |events| {
        events.iter().filter(|event| matches!(event, PipelineEvent::StepStarted { step_id, .. } if step_id == "plan")).count() == 1
    })
    .await;

    handle.stop(&project, sink.as_ref(), &clock).await.unwrap();
    timeout(Duration::from_secs(3), first)
        .await
        .expect("cancelled driver did not finish")
        .unwrap();

    // Retry: reset and drive with a fresh task. The second attempt's output is accepted.
    handle
        .retry_step(&project, "plan", sink.as_ref(), &clock)
        .await
        .unwrap();
    let second = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };
    wait_until(&sink, |events| {
        events.iter().filter(|event| matches!(event, PipelineEvent::StepStarted { step_id, .. } if step_id == "plan")).count() == 2
    })
    .await;
    gate.notify_one();
    timeout(Duration::from_secs(3), second)
        .await
        .expect("retried driver did not finish")
        .unwrap();

    let state = handle.state().lock().await;
    assert_eq!(state.status, RunStatus::Completed);
    let history = &state.find_step("plan").unwrap().history;
    assert_eq!(history.len(), 2);
    assert_eq!(
        history[0].error.as_deref(),
        Some("cancelled before completion")
    );
    assert!(history[0].output.is_none());
    assert!(history[1].output.is_some());
}

#[tokio::test]
async fn stop_truly_aborts_the_in_flight_agent() {
    let project = fresh_project("stop_abort");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let gate = Arc::new(Notify::new());
    let mut agents = AgentRegistry::with_defaults();
    agents.register(
        StepKind::Plan,
        Box::new(ControllableAgent {
            gate: gate.clone(),
            output: synopsis_output("never applied"),
        }),
    );
    agents.register(StepKind::Outline, Box::new(crate::agents::OutlineAgent));
    let pipeline = Arc::new(Pipeline::new(agents));
    let handle = pipeline
        .create_run(
            &project,
            "run_stop_abort",
            "brief",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };
    wait_until(&sink, |events| {
        events.iter().any(|event| matches!(event, PipelineEvent::StepStarted { step_id, .. } if step_id == "plan"))
    })
    .await;

    handle.stop(&project, sink.as_ref(), &clock).await.unwrap();

    // The in-flight agent is still blocked on the gate; stop() must terminate
    // the run by dropping that future, NOT by waiting for the gate.
    timeout(Duration::from_secs(3), task)
        .await
        .expect("cancelled driver did not finish")
        .unwrap();

    let persisted = crate::pipeline::load_run_state(&project, "run_stop_abort")
        .unwrap()
        .unwrap();
    assert_eq!(persisted.status, RunStatus::Cancelled);
    assert!(crate::story_plan::load_plan(&project)
        .unwrap()
        .unwrap()
        .synopsis
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_between_step_started_and_cancel_wait_registration_is_not_lost() {
    let project = fresh_project("stop_registration_race");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let before_registration = Arc::new(Semaphore::new(0));
    let release_registration = Arc::new(Semaphore::new(0));
    let mut agents = AgentRegistry::with_defaults();
    agents.register(StepKind::Plan, Box::new(HangingAgent));
    let pipeline = Arc::new(
        Pipeline::new(agents).with_cancel_wait_registration_hook_for_test(
            before_registration.clone(),
            release_registration.clone(),
        ),
    );
    let recipe = FlowRecipe::new().step(StepDef::new("plan", StepKind::Plan));
    let handle = pipeline
        .create_run(
            &project,
            "run_stop_registration_race",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };

    before_registration.acquire().await.unwrap().forget();
    handle.stop(&project, sink.as_ref(), &clock).await.unwrap();
    release_registration.add_permits(1);

    timeout(Duration::from_secs(1), task)
        .await
        .expect("stop notification was lost before cancellation wait registration")
        .unwrap();
    assert_eq!(handle.state().lock().await.status, RunStatus::Cancelled);
}

#[tokio::test]
async fn step_once_runs_one_ready_step_then_pauses() {
    let project = fresh_project("step_once");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let pipeline = Arc::new(Pipeline::with_default_agents());
    let recipe = FlowRecipe::new()
        .step(StepDef::new("plan", StepKind::Plan))
        .step(StepDef::new("memory", StepKind::Memory).depends_on("plan"));
    let handle = pipeline
        .create_run(
            &project,
            "run_step_once",
            "brief",
            &recipe,
            &clock,
            sink.as_ref(),
        )
        .unwrap();
    handle.pause(&project, sink.as_ref(), &clock).await.unwrap();
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, handle, sink.as_ref(), &SystemClock)
                .await;
        })
    };

    handle
        .step_once(&project, sink.as_ref(), &clock)
        .await
        .unwrap();
    wait_until(&sink, |events| {
        events
            .iter()
            .filter(|event| matches!(event, PipelineEvent::RunPaused { .. }))
            .count()
            >= 2
    })
    .await;
    {
        let state = handle.state().lock().await;
        assert_eq!(state.status, RunStatus::Paused);
        assert_eq!(
            state.find_step("plan").unwrap().status,
            StepStatus::Succeeded
        );
        assert_eq!(
            state.find_step("memory").unwrap().status,
            StepStatus::Pending
        );
    }

    handle
        .step_once(&project, sink.as_ref(), &clock)
        .await
        .unwrap();
    timeout(Duration::from_secs(3), task)
        .await
        .expect("second single-step did not complete the run")
        .unwrap();
    assert_eq!(handle.state().lock().await.status, RunStatus::Completed);
}

#[tokio::test]
async fn recovered_running_snapshot_can_execute_one_step() {
    let project = fresh_project("recovered_step_once");
    let sink = Arc::new(RecordingSink::new());
    let clock = StepClock::new();
    let pipeline = Arc::new(Pipeline::with_default_agents());
    pipeline
        .create_run(
            &project,
            "run_recovered_step_once",
            "brief",
            &default_recipe(),
            &clock,
            sink.as_ref(),
        )
        .unwrap();

    let recovered = pipeline
        .attach_run(&project, "run_recovered_step_once", &clock)
        .unwrap();
    assert_eq!(recovered.state().lock().await.status, RunStatus::Paused);
    let task = {
        let pipeline = pipeline.clone();
        let project = project.clone();
        let recovered = recovered.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            pipeline
                .execute(&project, recovered, sink.as_ref(), &SystemClock)
                .await;
        })
    };
    recovered
        .step_once(&project, sink.as_ref(), &clock)
        .await
        .unwrap();
    wait_until(&sink, |events| {
        events.iter().any(|event| matches!(event, PipelineEvent::StepSucceeded { step_id, .. } if step_id == "plan"))
    })
    .await;
    assert_eq!(recovered.state().lock().await.status, RunStatus::Paused);
    task.abort();
}

#[test]
fn a_new_run_updates_the_brief_without_discarding_the_story_plan() {
    let project = fresh_project("new_brief");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    pipeline
        .create_run(
            &project,
            "run_old",
            "old brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();
    let mut previous = crate::story_plan::load_plan(&project).unwrap().unwrap();
    previous.synopsis = "keep me".to_string();
    crate::story_plan::save_plan(&project, &previous).unwrap();
    pipeline
        .create_run(
            &project,
            "run_new",
            "new brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();

    let plan = crate::story_plan::load_plan(&project).unwrap().unwrap();
    assert_eq!(plan.prompt, "new brief");
    assert_eq!(plan.synopsis, "keep me");
}

#[test]
fn existing_story_content_is_routed_away_from_destructive_flows() {
    let project = fresh_project("existing_story_guard");
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; placeholder\n").unwrap();
    assert!(!project_has_story_content(&project).unwrap());

    std::fs::write(project.join("game/scene/start.txt"), "Alice:Keep this;\n").unwrap();
    assert!(project_has_story_content(&project).unwrap());
}

#[test]
fn failed_run_creation_restores_the_previous_production_brief() {
    let project = fresh_project("brief_rollback");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    pipeline
        .create_run(
            &project,
            "run_old",
            "old brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();
    let pipeline_dir = project.join(".ollaic").join("pipeline");
    std::fs::remove_dir_all(&pipeline_dir).unwrap();
    std::fs::write(&pipeline_dir, "blocks run persistence").unwrap();

    assert!(pipeline
        .create_run(
            &project,
            "run_new",
            "new brief",
            &default_recipe(),
            &clock,
            &sink
        )
        .is_err());
    assert_eq!(
        crate::story_plan::load_plan(&project)
            .unwrap()
            .unwrap()
            .prompt,
        "old brief"
    );

    let first_project = fresh_project("first_brief_rollback");
    let first_pipeline_dir = first_project.join(".ollaic").join("pipeline");
    std::fs::create_dir_all(first_pipeline_dir.parent().unwrap()).unwrap();
    std::fs::write(&first_pipeline_dir, "blocks run persistence").unwrap();
    assert!(pipeline
        .create_run(
            &first_project,
            "run_first",
            "first brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .is_err());
    assert!(crate::story_plan::load_plan(&first_project)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn run_history_can_be_pinned_and_cleared_when_not_running() {
    let project = fresh_project("history_controls");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let handle = pipeline
        .create_run(
            &project,
            "run_history_controls",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();
    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    assert!(
        !crate::webgal::project::list_project_snapshots(project.to_string_lossy().to_string())
            .unwrap()
            .is_empty()
    );

    handle.set_pinned(&project, true, &clock).await.unwrap();
    assert!(handle.state().lock().await.pinned);
    assert!(handle
        .state()
        .lock()
        .await
        .steps
        .iter()
        .any(|step| !step.history.is_empty()));
    handle.clear_history(&project, &clock).await.unwrap();
    assert!(handle
        .state()
        .lock()
        .await
        .steps
        .iter()
        .all(|step| step.history.is_empty()));
    assert!(
        crate::webgal::project::list_project_snapshots(project.to_string_lossy().to_string())
            .unwrap()
            .is_empty()
    );
    assert!(handle
        .state()
        .lock()
        .await
        .pending_snapshot_cleanup
        .is_empty());
    {
        let mut state = handle.state().lock().await;
        state.status = RunStatus::Paused;
        state.find_step_mut("plan").unwrap().status = StepStatus::Running;
    }
    assert!(handle.clear_history(&project, &clock).await.is_err());
}

#[test]
fn run_creation_persists_local_fallback_authorization_atomically() {
    let project = fresh_project("fallback_authorization");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    Pipeline::with_default_agents()
        .create_run_with_options(RunCreation {
            project_path: &project,
            run_id: "run_fallback_authorization",
            prompt: "brief",
            recipe: &default_recipe(),
            allow_local_fallback: true,
            step_timeout: Some(DEFAULT_STEP_TIMEOUT),
            clock: &clock,
            sink: &sink,
        })
        .unwrap();

    assert!(
        crate::pipeline::store::load_run_state(&project, "run_fallback_authorization")
            .unwrap()
            .unwrap()
            .allow_local_fallback
    );
}

#[test]
fn new_story_run_rejects_an_unfinished_run_loaded_from_disk() {
    let project = fresh_project("persisted_active_claim");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    pipeline
        .create_run(
            &project,
            "run_existing",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();

    let error = pipeline
        .create_new_story_run_with_timeout(RunCreation {
            project_path: &project,
            run_id: "run_new",
            prompt: "other brief",
            recipe: &default_recipe(),
            allow_local_fallback: false,
            step_timeout: Some(DEFAULT_STEP_TIMEOUT),
            clock: &clock,
            sink: &sink,
        })
        .err()
        .expect("an unfinished persisted run must keep the project claim");

    assert!(error.to_string().contains("unfinished run run_existing"));
    assert!(crate::pipeline::load_run_state(&project, "run_new")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn failed_snapshot_cleanup_remains_persisted_for_retry() {
    let project = fresh_project("snapshot_cleanup_retry");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let handle = Pipeline::with_default_agents()
        .create_run(
            &project,
            "run_snapshot_cleanup_retry",
            "brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();

    let mut state = handle.state().lock().await;
    state.pending_snapshot_cleanup = vec!["../invalid".to_string()];
    crate::pipeline::store::save_run_state(&project, &state).unwrap();
    assert!(cleanup_rollback_snapshots(&project, &mut state).is_err());
    drop(state);

    assert_eq!(
        crate::pipeline::store::load_run_state(&project, "run_snapshot_cleanup_retry")
            .unwrap()
            .unwrap()
            .pending_snapshot_cleanup,
        vec!["../invalid"]
    );
}

#[tokio::test]
async fn edited_step_prompt_is_used_by_retry() {
    let project = fresh_project("prompt_retry");
    let sink = RecordingSink::new();
    let clock = StepClock::new();
    let pipeline = Pipeline::with_default_agents();
    let handle = pipeline
        .create_run(
            &project,
            "run_prompt_retry",
            "original brief",
            &default_recipe(),
            &clock,
            &sink,
        )
        .unwrap();
    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    handle
        .update_step_prompt(&project, "plan", "revised direction".to_string(), &clock)
        .await
        .unwrap();
    handle
        .retry_step(&project, "plan", &sink, &clock)
        .await
        .unwrap();
    pipeline
        .execute(&project, handle.clone(), &sink, &clock)
        .await;

    let state = handle.state().lock().await;
    let history = &state.find_step("plan").unwrap().history;
    assert_eq!(history.len(), 2);
    let input: serde_json::Value = serde_json::from_str(&history[1].input_snapshot).unwrap();
    assert_eq!(input["stepInstruction"], "revised direction");
}
