use std::future::Future;
use std::pin::Pin;

use crate::story_plan::types::AssetTaskPlan;

use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

/// Plans only identity anchors; expressions belong to scene production.
pub(crate) struct AnchorPlannerAgent;

impl Agent for AnchorPlannerAgent {
    fn run<'a>(
        &'a self,
        context: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            let tasks = context
                .characters
                .iter()
                .map(|character| AssetTaskPlan {
                    id: format!("figure_{}_default", character.id),
                    kind: "figure".into(),
                    target_stem: format!("{}_default", character.id),
                    prompt: super::asset_planner::build_styled_prompt(
                        &format!(
                    "视觉小说角色立绘，单人，完整身体，默认表情，纯白背景 #FFFFFF；{}；性格：{}",
                    character.description, character.personality,
                ),
                        context.visual_style,
                    ),
                    character_ref: Some(character.id.clone()),
                    emotion: Some("default".into()),
                    reference_image: context.visual_style.style_reference_image.clone(),
                    aspect_ratio: Some("3:4".into()),
                    status: "pending".into(),
                    ..Default::default()
                })
                .collect();
            Ok(AgentOutput::new(AgentOutputPayload::AssetPlan(tasks)))
        })
    }
}
