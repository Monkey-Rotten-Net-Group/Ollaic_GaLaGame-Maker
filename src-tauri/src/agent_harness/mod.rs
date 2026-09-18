//! `agent-harness`: a headless driver for Ollaic's AI code paths.
//!
//! Everything here calls the same functions the Tauri commands call, so a green
//! `agent-harness` run says something about the app rather than about a parallel
//! implementation. The module lives inside the crate (rather than in its own)
//! so it can reach `pub(crate)` entry points such as
//! [`crate::ai::commands::ai_chat_turn`] without widening their visibility;
//! `src/bin/agent-harness.rs` is a one-line shell over [`main`].
//!
//! See `doc/ai/harness.md`.

pub mod cassette;
pub mod chain;
pub mod cli;
pub mod gateway;
pub mod render;
pub mod scenario;

use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine;
use clap::Parser;

use crate::agents::router::ConfiguredChatGateway;
use crate::agents::{AgentRegistry, AgentOutput};
use crate::ai::commands::{
    self, AiMessageInput, AiTurnResult, AiValidationResult, GeneratedMedia, ToolDef,
};
use crate::ai::config::{self, AiConfig};
use crate::ai::provider_capability::capability_for_config;

use cassette::Cassette;
use cli::{
    AgentArgs, CassetteAction, ChatArgs, Cli, Command, ConfigAction, GlobalArgs, LogArgs,
    MediaAction, ProbeArgs,
};
use gateway::{RecordingGateway, ReplayGateway};
use render::Renderer;
use scenario::Scenario;

/// Entry point for the `agent-harness` binary.
pub fn main() {
    let cli = Cli::parse();

    // Applies before any config read, so every later `config::load_*` sees the
    // requested profile rather than the desktop app's saved settings.
    if let Some(profile) = &cli.global.profile {
        std::env::set_var("OLLAIC_CONFIG_DIR", profile);
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("agent-harness: failed to start the async runtime: {error}");
            std::process::exit(2);
        }
    };

    if let Err(error) = runtime.block_on(dispatch(cli)) {
        eprintln!("agent-harness: {error}");
        std::process::exit(1);
    }
}

async fn dispatch(cli: Cli) -> Result<(), String> {
    let render = Renderer::new(cli.global.json);
    match cli.command {
        Command::Config { action } => match action {
            ConfigAction::Show => run_config_show(&render),
        },
        Command::Probe(args) => run_probe(&render, args).await,
        Command::Chat(args) => run_chat(&render, args).await,
        Command::Agent(args) => run_agent(&render, &cli.global, args).await,
        Command::Chain(args) => run_chain(&render, &cli.global, args).await,
        Command::Media { action } => run_media(&render, action).await,
        Command::Log(args) => run_log(&render, args),
        Command::Cassette { action } => run_cassette(&render, &cli.global, action),
    }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

fn run_config_show(render: &Renderer) -> Result<(), String> {
    let chat = config::load_config();
    let chat_endpoint = commands::effective_endpoint(&chat);
    let image = config::load_image_config();
    let tts = config::load_tts_config();
    let music = config::load_music_config();

    let image_endpoint = commands::media_endpoint(&image, "images/generations");
    let tts_endpoint = commands::media_endpoint(&tts, "audio/speech");
    let music_endpoint = commands::media_endpoint(&music, "audio/speech");

    let config_dir = config::config_root()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "(unavailable)".to_string());

    render.config(
        &chat,
        &chat_endpoint,
        (&image, image_endpoint),
        (&tts, tts_endpoint),
        (&music, music_endpoint),
        &config_dir,
        &config::log_path().map(|p| p.display().to_string())?,
        &config::agent_trace_path().map(|p| p.display().to_string())?,
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

/// Apply the per-invocation overrides without persisting them. A probe must
/// never write to the profile: you run it precisely when the saved config is
/// suspect. Returns whether anything was actually overridden, so a plain
/// `probe` reads the profile without writing to it at all — inspecting a config
/// must never rewrite the file you are inspecting.
fn overridden_config(args: &ProbeArgs) -> (AiConfig, bool) {
    let mut config = config::load_config();
    let mut overridden = false;
    if let Some(provider) = &args.provider {
        config.provider = provider.clone();
        overridden = true;
    }
    if let Some(model) = &args.model {
        config.model = model.clone();
        overridden = true;
    }
    if let Some(base_url) = &args.base_url {
        config.base_url = base_url.clone();
        overridden = true;
    }
    if let Some(api_key) = args
        .api_key
        .clone()
        .or_else(|| std::env::var("AI_LAB_API_KEY").ok())
    {
        config.api_key = api_key;
        overridden = true;
    }
    (config, overridden)
}

async fn run_probe(render: &Renderer, args: ProbeArgs) -> Result<(), String> {
    let (config, overridden) = overridden_config(&args);
    let capability = capability_for_config(&config)?;

    if args.offline {
        render.probe(None, &capability, None);
        return Ok(());
    }

    let validation: AiValidationResult = commands::validate_ai_config(config.clone()).await?;

    // The round-trip deliberately carries one tool definition when the provider
    // claims tool support: "connects" and "can actually do tool calling" fail
    // independently, and the second is what the agent loop needs.
    let round_trip = if validation.ok {
        let tools = if capability.chat_tools {
            vec![ToolDef {
                name: "ping".to_string(),
                description: "Reply that the harness reached the provider.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": { "ok": { "type": "boolean" } },
                    "required": ["ok"]
                }),
            }]
        } else {
            Vec::new()
        };
        let turn = || {
            commands::ai_chat_turn(
                vec![AiMessageInput {
                    role: "user".to_string(),
                    content: "Reply with the single word: pong".to_string(),
                    tool_calls: None,
                    tool_call_id: None,
                }],
                tools,
                None,
            )
        };
        Some(if overridden {
            with_config(&config, turn).await
        } else {
            turn().await
        })
    } else {
        None
    };

    let failed = !validation.ok
        || matches!(round_trip.as_ref(), Some(Err(_)));
    render.probe(Some(&validation), &capability, round_trip.as_ref());
    if failed {
        return Err("probe failed".to_string());
    }
    Ok(())
}

/// `ai_chat_turn` and friends read the saved config rather than taking one, so
/// an override has to be staged on disk for the duration of the call. Only
/// reached when the caller actually passed an override; the previous contents
/// are restored even when the call fails.
async fn with_config<F, Fut, T>(config: &AiConfig, call: F) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let previous = config::load_config();
    config::save_config(config)?;
    let result = call().await;
    // Restore before propagating, so a failed probe does not leave the
    // override behind in the profile.
    let restored = config::save_config(&previous);
    result.and_then(|value| restored.map(|()| value))
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

async fn run_chat(render: &Renderer, args: ChatArgs) -> Result<(), String> {
    let tools: Vec<ToolDef> = match &args.tools {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("failed to read tool definitions {path}: {e}"))?;
            serde_json::from_str(&text)
                .map_err(|e| format!("{path} is not a [{{name, description, parameters}}] array: {e}"))?
        }
        None => Vec::new(),
    };

    let system = args.system.unwrap_or_else(config::default_system_prompt);
    let messages = vec![
        AiMessageInput {
            role: "system".to_string(),
            content: system,
            tool_calls: None,
            tool_call_id: None,
        },
        AiMessageInput {
            role: "user".to_string(),
            content: args.prompt,
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let result: AiTurnResult = commands::ai_chat_turn(messages, tools, None).await?;
    render.turn(&result);
    Ok(())
}

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

async fn run_agent(
    render: &Renderer,
    global: &GlobalArgs,
    args: AgentArgs,
) -> Result<(), String> {
    let plan = match (&args.project, &args.scenario) {
        (Some(project), _) => Scenario::from_project(Path::new(project))?,
        (None, Some(file)) => Scenario::from_file(Path::new(file))?,
        (None, None) => {
            return Err("pass --project <dir> or --scenario <file> to supply a StoryPlan".into())
        }
    };

    let brief = args
        .brief
        .clone()
        .unwrap_or_else(|| non_empty(&plan.prompt).unwrap_or(&plan.synopsis).to_string());
    let scenario = Scenario {
        plan,
        brief,
        instruction: args.instruction.clone(),
        allow_local_fallback: args.allow_local_fallback,
    };

    let registry = AgentRegistry::with_defaults();
    let agent = scenario::resolve_agent(&registry, args.kind)?;
    let root = cassette_root(global);

    let started = Instant::now();
    let (output, recorded) = match (&global.record, &global.replay) {
        (Some(name), _) => {
            let config = config::load_config();
            let recorder = RecordingGateway::new(
                ConfiguredChatGateway,
                config.provider.clone(),
                config.model.clone(),
                config.api_key.clone(),
            );
            let result = agent.run(&scenario.context(&recorder)).await;
            // Persist whatever was captured even when the agent then failed
            // contract validation: that recording is the evidence you need.
            let cassette = recorder.into_cassette();
            cassette::verify(&cassette)?;
            let path = cassette::save(&root, name, &cassette)?;
            render.note(&format!(
                "recorded {} interaction(s) → {}",
                cassette.interactions.len(),
                path.display()
            ));
            (result, true)
        }
        (None, Some(name)) => {
            let replay = ReplayGateway::new(cassette::load(&root, name)?, name.clone());
            (agent.run(&scenario.context(&replay)).await, false)
        }
        (None, None) => (
            agent.run(&scenario.context(&ConfiguredChatGateway)).await,
            false,
        ),
    };
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let output: AgentOutput = output.map_err(|error| {
        if recorded {
            format!("{} (the cassette was still written)", error.0)
        } else {
            error.0
        }
    })?;
    let payload = serde_json::to_value(&output).map_err(|e| e.to_string())?;

    if let Some(out) = &args.out {
        let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
        std::fs::write(out, json).map_err(|e| format!("failed to write {out}: {e}"))?;
        render.note(&format!("wrote payload → {out}"));
        if !render.is_json() {
            return Ok(());
        }
    }
    render.agent(&format!("{:?}", args.kind), &payload, elapsed_ms);
    Ok(())
}

fn non_empty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

async fn run_chain(
    render: &Renderer,
    global: &GlobalArgs,
    args: cli::ChainArgs,
) -> Result<(), String> {
    if args.show_brief {
        println!("{}", chain::COVERAGE_BRIEF);
        return Ok(());
    }

    let brief = match (&args.brief, &args.brief_file) {
        (Some(brief), _) => brief.clone(),
        (None, Some(path)) => std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read brief {path}: {e}"))?,
        (None, None) => chain::COVERAGE_BRIEF.to_string(),
    };

    let report = chain::run(chain::ChainOptions {
        brief,
        allow_local_fallback: args.allow_local_fallback,
        record: global.record.clone(),
        replay: global.replay.clone(),
        cassette_root: cassette_root(global),
        stop_after: args.stop_after.clone(),
    })
    .await?;

    if let Some(out) = &args.out {
        let json = serde_json::to_string_pretty(&report.plan).map_err(|e| e.to_string())?;
        std::fs::write(out, json).map_err(|e| format!("failed to write {out}: {e}"))?;
        render.note(&format!("wrote StoryPlan → {out}"));
    }

    render.chain(&report);
    if report.failed() {
        return Err("chain failed".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

async fn run_media(render: &Renderer, action: MediaAction) -> Result<(), String> {
    let started = Instant::now();
    let (media, out) = match action {
        MediaAction::Image {
            prompt,
            model,
            reference,
            out,
        } => {
            let model = model.unwrap_or_else(|| config::load_image_config().model);
            (
                commands::generate_image_media(None, prompt, model, reference).await?,
                out,
            )
        }
        MediaAction::Tts {
            text,
            model,
            voice,
            format,
            out,
        } => {
            let model = model.unwrap_or_else(|| config::load_tts_config().model);
            (
                commands::generate_tts_media(text, voice, model, format).await?,
                out,
            )
        }
        MediaAction::Music {
            prompt,
            model,
            format,
            out,
        } => {
            let model = model.unwrap_or_else(|| config::load_music_config().model);
            (
                commands::generate_music_media(prompt, model, format).await?,
                out,
            )
        }
    };
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let bytes = decode_media(&media)?;
    std::fs::write(&out, &bytes).map_err(|e| format!("failed to write {out}: {e}"))?;
    render.media(&out, bytes.len(), elapsed_ms);
    Ok(())
}

fn decode_media(media: &GeneratedMedia) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(&media.base64_data)
        .map_err(|e| format!("provider returned media that is not valid base64: {e}"))
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

fn run_log(render: &Renderer, args: LogArgs) -> Result<(), String> {
    if args.trace {
        let path = config::agent_trace_path()?;
        let lines = config::read_log_lines_at(&path, args.lines)?;
        render.raw_lines(&lines);
        return Ok(());
    }
    let entries = commands::list_ai_logs(Some(args.lines))?;
    render.logs(&entries);
    Ok(())
}

// ---------------------------------------------------------------------------
// cassette
// ---------------------------------------------------------------------------

fn cassette_root(global: &GlobalArgs) -> PathBuf {
    global
        .cassette_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(cassette::default_root)
}

fn run_cassette(
    render: &Renderer,
    global: &GlobalArgs,
    action: CassetteAction,
) -> Result<(), String> {
    let root = cassette_root(global);
    match action {
        CassetteAction::Ls => {
            let names = cassette::list(&root)?;
            render.cassette_list(&names, &root.display().to_string());
        }
        CassetteAction::Show { name } => {
            let cassette: Cassette = cassette::load(&root, &name)?;
            let payload = serde_json::to_value(&cassette).map_err(|e| e.to_string())?;
            if render.is_json() {
                println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
            } else {
                render.note(&format!(
                    "{name}: {} interaction(s), {} @ {}",
                    cassette.interactions.len(),
                    cassette.model,
                    cassette.provider
                ));
                for interaction in &cassette.interactions {
                    render.note(&format!(
                        "#{} {:?} {}ms  {}",
                        interaction.seq,
                        interaction.kind,
                        interaction.elapsed_ms,
                        interaction.request_hash
                    ));
                }
            }
        }
        CassetteAction::Verify { name } => {
            let cassette = cassette::load(&root, &name)?;
            cassette::verify(&cassette)?;
            render.note(&format!(
                "✓ {name}: {} interaction(s), no duplicate or stale hashes",
                cassette.interactions.len()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
