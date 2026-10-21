//! Deterministic model responses for scheduler and agent tests. This module
//! is compiled only for tests; production content always comes from a model.

use std::future::Future;
use std::pin::Pin;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use super::router::ChatGateway;
use super::{AgentContext, AgentOutputPayload};

pub(crate) struct FixtureChatGateway;

impl ChatGateway for FixtureChatGateway {
    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Option<(String, String, Option<u32>, Option<u32>)>, String>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let input: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
            let chapters = field::<Vec<_>>(&input, "chapters");
            let glossary = field(&input, "glossary");
            let characters = field::<Vec<_>>(&input, "characters");
            let scene_plans = field::<Vec<_>>(&input, "scenePlans");
            let branches = field(&input, "branches");
            let scene_drafts = field::<Vec<_>>(&input, "sceneDrafts");
            let asset_plan = field::<Vec<_>>(&input, "assetPlan");
            let ctx = AgentContext {
                chat: self,
                prompt: input["productionBrief"].as_str().unwrap_or_default(),
                instruction: input["stepInstruction"].as_str().unwrap_or_default(),
                synopsis: input["synopsis"].as_str().unwrap_or_default(),
                worldbook: input["worldbook"].as_str().unwrap_or_default(),
                chapters: &chapters,
                glossary: &glossary,
                characters: &characters,
                scene_plans: &scene_plans,
                branches: &branches,
                scene_drafts: &scene_drafts,
                asset_plan: &asset_plan,
            };
            let output = if system.contains("Plan / 制片策划") {
                super::plan::fixture_output(&ctx)
            } else if system.contains("Worldbuilder / 世界观设计") {
                super::memory::fixture_output(&ctx)
            } else if system.contains("Plotter / 剧情结构") {
                super::outline::fixture_output(&ctx)
            } else if system.contains("Character / 角色设计") {
                super::character::fixture_output(&ctx)
            } else if system.contains("Dialogist / 场景对白") {
                super::dialogist::fixture_output(&ctx)
            } else if system.contains("AssetPlanner / 资产规划") {
                super::asset_planner::fixture_output(&ctx)
            } else {
                return Err(format!("no model fixture for {system}"));
            }
            .map_err(|error| error.0)?;
            let response = match output.payload {
                AgentOutputPayload::Synopsis(synopsis) => json!({ "synopsis": synopsis }),
                AgentOutputPayload::Memory {
                    worldbook,
                    glossary,
                } => json!({ "worldbook": worldbook, "glossary": glossary }),
                AgentOutputPayload::Outline {
                    chapters,
                    scene_plans,
                    branches,
                } => {
                    json!({ "chapters": chapters, "scenePlans": scene_plans, "branches": branches })
                }
                AgentOutputPayload::Characters(characters) => json!({ "characters": characters }),
                AgentOutputPayload::SceneDrafts(drafts) => json!({ "sceneDrafts": drafts }),
                AgentOutputPayload::AssetPlan(tasks) => json!({ "assetPlan": tasks }),
                _ => return Err("unexpected model fixture payload".to_string()),
            };
            Ok(Some((
                response.to_string(),
                "fixture-model".to_string(),
                None,
                None,
            )))
        })
    }
}

fn field<T: DeserializeOwned + Default>(input: &Value, name: &str) -> T {
    input
        .get(name)
        .map(|value| serde_json::from_value(value.clone()).expect("valid model fixture context"))
        .unwrap_or_default()
}
