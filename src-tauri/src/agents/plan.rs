use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

/// Turns the Production Brief into a concise dramatic premise.
pub struct PlanAgent;

#[derive(Deserialize)]
struct PlanResponse {
    synopsis: String,
}

fn validate_response(response: &mut PlanResponse) -> Result<(), AgentError> {
    if response.synopsis.trim().is_empty() {
        return Err(contract_error("$.synopsis", "must not be empty"));
    }
    Ok(())
}

impl Agent for PlanAgent {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            let prompt = ctx.prompt.trim();
            if prompt.is_empty() {
                return Err(AgentError("Plan step received an empty prompt".to_string()));
            }
            let input = serde_json::json!({
                "productionBrief": prompt,
                "stepInstruction": ctx.instruction,
                "requirements": "用中文写 120-220 字梗概，明确主人公、核心关系、冲突、选择与结局悬念。"
            });
            if let Some(routed) = generate_structured_validated::<PlanResponse, _>(
                ctx.chat,
                "Plan / 制片策划",
                "把生产简报转成可供后续世界观、剧情和角色 Agent 共同使用的单段故事梗概。JSON 格式：{\"synopsis\":\"...\"}。",
                &input,
                ctx.allow_local_fallback,
                validate_response,
            ).await? {
                return Ok(AgentOutput::new(AgentOutputPayload::Synopsis(
                    routed.value.synopsis,
                ))
                .with_model(
                    routed.model,
                    routed.prompt_tokens,
                    routed.completion_tokens,
                ));
            }
            let synopsis = format!(
                "《{}》围绕一次打破日常的相遇展开。主人公在追查异常的过程中，与一位掌握关键秘密的少女从互相戒备走向彼此信任；当真相要求他们在安稳生活与共同承担后果之间选择时，两人的关系也成为改变结局的唯一变量。",
                prompt
            );
            Ok(AgentOutput::new(AgentOutputPayload::Synopsis(synopsis)).local_fallback())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_model_synopsis_reports_contract_path() {
        let mut response = PlanResponse {
            synopsis: " ".into(),
        };
        let error = validate_response(&mut response).unwrap_err();
        assert!(error.0.contains("$.synopsis"));
    }

    #[tokio::test]
    async fn plan_agent_produces_synopsis_from_prompt() {
        let agent = PlanAgent;
        let ctx = AgentContext {
            chat: &crate::agents::router::NoChatGateway,
            prompt: "赛博朋克校园恋爱",
            instruction: "",
            synopsis: "",
            chapters: &[],
            worldbook: "",
            glossary: &Default::default(),
            characters: &[],
            scene_plans: &[],
            branches: &Default::default(),
            scene_drafts: &[],
            asset_plan: &[],
            allow_local_fallback: true,
        };
        let out = agent.run(&ctx).await.unwrap();
        let AgentOutputPayload::Synopsis(synopsis) = out.payload else {
            panic!("Plan must return a synopsis")
        };
        assert!(synopsis.contains("赛博朋克校园恋爱"));
    }

    #[tokio::test]
    async fn plan_agent_rejects_empty_prompt() {
        let agent = PlanAgent;
        let ctx = AgentContext {
            chat: &crate::agents::router::NoChatGateway,
            prompt: "   ",
            instruction: "",
            synopsis: "",
            chapters: &[],
            worldbook: "",
            glossary: &Default::default(),
            characters: &[],
            scene_plans: &[],
            branches: &Default::default(),
            scene_drafts: &[],
            asset_plan: &[],
            allow_local_fallback: true,
        };
        assert!(agent.run(&ctx).await.is_err());
    }
}
