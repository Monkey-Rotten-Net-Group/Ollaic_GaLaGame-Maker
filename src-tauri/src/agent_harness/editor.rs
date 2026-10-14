//! Drives the production React editor agent through a JSON-line IPC bridge.
//! Model turns use Exchange; parsing and project reads use the real backend.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use super::cli::GlobalArgs;
use super::exchange::Exchange;
use crate::ai::chat_runs::ChatRunRegistry;
use crate::ai::commands::{self, AiMessageInput, AiTurnResult, ToolDef};
use crate::ai::config::{self, AiConfig, ProviderCapabilityDeclaration};
use crate::ai::provider_capability::capability_for_config;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorScenario {
    pub scene: String,
    pub script: String,
    pub prompt: String,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub stop_after_call: Option<usize>,
    #[serde(default)]
    pub next_prompt: Option<String>,
    #[serde(default)]
    pub delayed_turns: Vec<usize>,
    #[serde(default)]
    pub fail_commands: HashMap<String, String>,
    #[serde(default)]
    pub unmount_after_call: Option<usize>,
    #[serde(default)]
    pub return_before_response: bool,
    #[serde(default)]
    pub switch_project: bool,
    #[serde(default)]
    pub loading_on_return: bool,
    #[serde(default)]
    pub stale_path_on_return: bool,
}

impl EditorScenario {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
    }
}

struct Project(PathBuf);

impl Project {
    fn new(scenario: &EditorScenario) -> Result<Self, String> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        if Path::new(&scenario.scene)
            .file_name()
            .and_then(|s| s.to_str())
            != Some(&scenario.scene)
        {
            return Err("editor scene must be a filename".into());
        }
        let root = std::env::temp_dir().join(format!(
            "ollaic-editor-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            super::cassette::now_ms()
        ));
        std::fs::create_dir_all(root.join("game/scene")).map_err(|e| e.to_string())?;
        std::fs::write(
            root.join("game/scene").join(&scenario.scene),
            &scenario.script,
        )
        .map_err(|e| e.to_string())?;
        Ok(Self(root))
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Backend {
    project: String,
    scenario: EditorScenario,
    exchange: Mutex<Option<Exchange>>,
    responses: Option<Vec<Value>>,
    turns: AtomicUsize,
    runs: ChatRunRegistry,
    failure: Mutex<Option<String>>,
    live: bool,
}

impl Backend {
    async fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        if let Some(error) = self.scenario.fail_commands.get(command) {
            return Err(error.clone());
        }
        match command {
            "parse_scene" => serde_json::to_value(crate::webgal::commands::parse_scene(string(
                &args, "source",
            )?)?)
            .map_err(|e| e.to_string()),
            "serialize_scene" => {
                let nodes =
                    serde_json::from_value(args["nodes"].clone()).map_err(|e| e.to_string())?;
                Ok(json!(crate::webgal::commands::serialize_scene(nodes)?))
            }
            "get_scene_path" => Ok(json!(crate::webgal::project::get_scene_path(
                self.project.clone(),
                string(&args, "sceneName")?
            )?)),
            "list_scenes" => serde_json::to_value(crate::webgal::commands::list_scenes(format!(
                "{}/game/scene",
                self.project
            ))?)
            .map_err(|e| e.to_string()),
            "read_file_text" => {
                let path = PathBuf::from(string(&args, "path")?)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                let root = PathBuf::from(&self.project)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !path.starts_with(root) {
                    return Err("editor harness reads only its temporary project".into());
                }
                Ok(json!(crate::webgal::commands::read_file_text(
                    path.to_string_lossy().into_owned()
                )?))
            }
            "list_characters" => serde_json::to_value(
                crate::characters::commands::list_characters(self.project.clone())?,
            )
            .map_err(|e| e.to_string()),
            "list_character_names" => serde_json::to_value(
                crate::characters::commands::list_character_names(self.project.clone())?,
            )
            .map_err(|e| e.to_string()),
            "get_character" => serde_json::to_value(crate::characters::commands::get_character(
                self.project.clone(),
                string(&args, "id")?,
            )?)
            .map_err(|e| e.to_string()),
            "list_assets" => serde_json::to_value(crate::assets::commands::list_assets(
                self.project.clone(),
                string(&args, "category")?,
            )?)
            .map_err(|e| e.to_string()),
            "list_all_assets" => serde_json::to_value(crate::assets::commands::list_all_assets(
                self.project.clone(),
            )?)
            .map_err(|e| e.to_string()),
            "read_project_memory" => serde_json::to_value(
                crate::webgal::project::read_project_memory(self.project.clone())?,
            )
            .map_err(|e| e.to_string()),
            "list_ai_uploads" => {
                serde_json::to_value(crate::ai::uploads::list_ai_uploads(self.project.clone())?)
                    .map_err(|e| e.to_string())
            }
            "get_ai_provider_capability" => {
                let cfg = if self.live {
                    config::load_config()
                } else {
                    AiConfig {
                        provider: "custom".into(),
                        capabilities: Some(ProviderCapabilityDeclaration {
                            chat_tools: self.scenario.tools,
                            ..Default::default()
                        }),
                        ..Default::default()
                    }
                };
                serde_json::to_value(capability_for_config(&cfg)?).map_err(|e| e.to_string())
            }
            "ai_chat_cancel" => Ok(json!(self.runs.cancel(&string(&args, "runId")?).await)),
            "append_ai_agent_trace" => Ok(Value::Null),
            "ai_chat_turn_owned" => {
                let index = self.turns.fetch_add(1, Ordering::SeqCst);
                let run_id = string(&args, "runId")?;
                let messages: Vec<AiMessageInput> =
                    serde_json::from_value(args["messages"].clone()).map_err(|e| e.to_string())?;
                let tools: Vec<ToolDef> =
                    serde_json::from_value(args["tools"].clone()).map_err(|e| e.to_string())?;
                let request = json!({ "messages": &messages, "tools": &tools });
                let live = async {
                    if let Some(responses) = &self.responses {
                        let response = responses.get(index).ok_or_else(|| {
                            format!("no scripted response for turn {}", index + 1)
                        })?;
                        serde_json::from_value::<Result<AiTurnResult, String>>(response.clone())
                            .map_err(|e| e.to_string())?
                    } else {
                        commands::ai_chat_turn(messages, tools, None).await
                    }
                };
                let mut exchange = self.exchange.lock().await;
                if let Err(error) = exchange
                    .as_ref()
                    .unwrap()
                    .check_replay_request("harness:editor:turn:v1", &request)
                {
                    *self.failure.lock().await = Some(error.clone());
                    return Err(error);
                }
                let result = self
                    .runs
                    .run_cancellable(
                        &run_id,
                        exchange
                            .as_mut()
                            .unwrap()
                            .call("harness:editor:turn:v1", &request, live),
                    )
                    .await;
                drop(exchange);
                // Delay delivery after completion to reproduce transports that ignore Stop.
                if self.scenario.delayed_turns.contains(&(index + 1)) {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                serde_json::to_value(result?).map_err(|e| e.to_string())
            }
            _ => {
                let error = format!("editor harness does not handle IPC command {command}");
                *self.failure.lock().await = Some(error.clone());
                Err(error)
            }
        }
    }
}

fn string(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("missing string argument {key}"))
}

pub async fn run(
    global: &GlobalArgs,
    scenario: EditorScenario,
    responses: Option<Vec<Value>>,
) -> Result<Value, String> {
    if responses.is_some() && global.replay.is_some() {
        return Err("scripted responses cannot be used during replay".into());
    }
    let live = responses.is_none() && global.replay.is_none();
    let timeout = if live {
        Duration::from_secs(20 * 60)
    } else {
        Duration::from_secs(30)
    };
    let project = Project::new(&scenario)?;
    let cfg = if responses.is_some() || global.replay.is_some() {
        AiConfig::default()
    } else {
        config::load_config()
    };
    let backend = Arc::new(Backend {
        project: project.0.to_string_lossy().into_owned(),
        scenario: scenario.clone(),
        exchange: Mutex::new(Some(Exchange::new(
            global,
            if responses.is_some() {
                "scripted-editor".into()
            } else {
                cfg.provider
            },
            if responses.is_some() {
                "scripted-editor".into()
            } else {
                cfg.model
            },
            cfg.api_key,
        )?)),
        responses,
        turns: AtomicUsize::new(0),
        runs: ChatRunRegistry::new(),
        failure: Mutex::new(None),
        live,
    });
    let design = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("design");
    let mut child = tokio::process::Command::new(
        std::env::var("OLLAIC_HARNESS_NODE").unwrap_or_else(|_| "node".into()),
    )
    .arg("--import")
    .arg(design.join("scripts/agent-harness-register.mjs"))
    .arg(design.join("scripts/agent-harness-editor.mjs"))
    .current_dir(&design)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .kill_on_drop(true)
    .spawn()
    .map_err(|e| format!("editor harness needs Node.js and pnpm install: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            format!(
                "{}\n",
                json!({ "kind": "scenario", "scenario": scenario, "projectPath": backend.project })
            )
            .as_bytes(),
        )
        .await
        .map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(stdin));
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut tasks = tokio::task::JoinSet::new();
    let outcome = tokio::time::timeout(timeout, async {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            let message: Value = serde_json::from_str(&line)
                .map_err(|e| format!("invalid editor RPC: {e}: {line}"))?;
            match message["kind"].as_str() {
                Some("report") => return Ok(message["report"].clone()),
                Some("error") => {
                    return Err(message["message"]
                        .as_str()
                        .unwrap_or("editor failed")
                        .to_string())
                }
                Some("invoke") => {
                    let backend = backend.clone();
                    let writer = writer.clone();
                    tasks.spawn(async move {
                        let result = backend
                            .invoke(
                                message["command"].as_str().unwrap_or(""),
                                message["args"].clone(),
                            )
                            .await;
                        let response = match result {
                            Ok(value) => json!({ "id": message["id"], "value": value }),
                            Err(error) => json!({ "id": message["id"], "error": error }),
                        };
                        writer
                            .lock()
                            .await
                            .write_all(format!("{response}\n").as_bytes())
                            .await
                    });
                }
                _ => return Err("unknown editor RPC message".into()),
            }
        }
        Err("editor driver exited without a report; run pnpm install first".into())
    })
    .await
    .map_err(|_| format!("editor driver exceeded {} seconds", timeout.as_secs()))?;
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    if outcome.is_err() {
        let _ = child.kill().await;
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    backend.exchange.lock().await.take().unwrap().finish()?;
    if let Some(error) = backend.failure.lock().await.take() {
        return Err(error);
    }
    if !status.success() {
        return Err(outcome
            .err()
            .unwrap_or_else(|| format!("editor driver exited with {status}")));
    }
    outcome
}

pub async fn from_files(
    global: &GlobalArgs,
    scenario: &Path,
    responses: Option<&Path>,
) -> Result<Value, String> {
    let scenario = EditorScenario::load(scenario)?;
    let responses = responses
        .map(|path| {
            let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        })
        .transpose()?;
    run(global, scenario, responses).await
}
