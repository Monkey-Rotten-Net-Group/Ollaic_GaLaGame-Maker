use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;
use std::collections::BTreeMap;

use super::router::{contract_error, generate_structured_validated};
use super::{Agent, AgentContext, AgentError, AgentOutput, AgentOutputPayload};

/// Worldbuilder: creates shared canon and terminology for all downstream Agents.
pub struct MemoryAgent;

#[derive(Deserialize)]
struct MemoryResponse {
    worldbook: String,
    #[serde(default)]
    glossary: BTreeMap<String, String>,
}

fn validate_response(response: &mut MemoryResponse) -> Result<(), AgentError> {
    if response.worldbook.trim().is_empty() {
        return Err(contract_error("$.worldbook", "must not be empty"));
    }
    if response.glossary.len() < 4 {
        return Err(contract_error(
            "$.glossary",
            "must contain at least 4 terms",
        ));
    }
    for (term, definition) in &response.glossary {
        if term.trim().is_empty() || definition.trim().is_empty() {
            return Err(contract_error(
                format!("$.glossary[{term:?}]"),
                "term and definition must not be empty",
            ));
        }
    }
    Ok(())
}

impl Agent for MemoryAgent {
    fn run<'a>(
        &'a self,
        ctx: &'a AgentContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentOutput, AgentError>> + Send + 'a>> {
        Box::pin(async move {
            let synopsis = ctx.synopsis.trim();
            if synopsis.is_empty() {
                return Err(AgentError(
                    "Memory step received an empty synopsis".to_string(),
                ));
            }
            let input = serde_json::json!({
                "productionBrief": ctx.prompt,
                "synopsis": synopsis,
                "stepInstruction": ctx.instruction,
                "requirements": "世界规则、主要舞台、社会日常、核心秘密、冲突边界；glossary 至少 4 项。"
            });
            if let Some(routed) = generate_structured_validated::<MemoryResponse, _>(
                ctx.chat,
                "Worldbuilder / 世界观设计",
                "建立能约束后续剧情和对白的世界设定。JSON 格式：{\"worldbook\":\"...\",\"glossary\":{\"术语\":\"定义\"}}。",
                &input,
                ctx.allow_local_fallback,
                validate_response,
            ).await? {
                return Ok(AgentOutput::new(AgentOutputPayload::Memory {
                    worldbook: routed.value.worldbook,
                    glossary: routed.value.glossary,
                })
                .with_model(
                    routed.model,
                    routed.prompt_tokens,
                    routed.completion_tokens,
                ));
            }
            let worldbook = format!(
                "故事发生在一个表面维持日常秩序、实际被异常事件悄悄改变的城市。核心舞台既是主人公最熟悉的生活圈，也是秘密留下痕迹的地方。世界规则要求每次获得真相都必须付出关系或记忆上的代价；公开权力希望维持安稳，年轻角色则更在意真实与彼此。所有超常现象都应服务于人物选择，不可无条件解决冲突。故事基线：{}",
                synopsis
            );
            let glossary = BTreeMap::from([
                (
                    "异常回声".to_string(),
                    "秘密在日常环境中留下、只有当事人能够感知的重复信号。".to_string(),
                ),
                (
                    "静默协议".to_string(),
                    "知情者为保护现有秩序而共同遵守的隐瞒规则。".to_string(),
                ),
                (
                    "锚点".to_string(),
                    "能帮助角色确认自身记忆与情感真实存在的人或物。".to_string(),
                ),
                (
                    "越界".to_string(),
                    "角色主动承担代价、打破静默协议追索真相的行为。".to_string(),
                ),
            ]);
            Ok(AgentOutput::new(AgentOutputPayload::Memory {
                worldbook,
                glossary,
            })
            .local_fallback())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undersized_glossary_reports_contract_path() {
        let mut response = MemoryResponse {
            worldbook: "规则".into(),
            glossary: BTreeMap::from([("锚点".into(), "定义".into())]),
        };
        let error = validate_response(&mut response).unwrap_err();
        assert!(error.0.contains("$.glossary"));
    }

    #[tokio::test]
    async fn memory_agent_produces_worldbook_from_synopsis() {
        let agent = MemoryAgent;
        let ctx = AgentContext {
            chat: &crate::agents::router::NoChatGateway,
            prompt: "",
            instruction: "",
            synopsis: "赛博校园里的记忆黑客",
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
        let AgentOutputPayload::Memory {
            worldbook,
            glossary,
        } = out.payload
        else {
            panic!("Memory Agent must return memory")
        };
        assert!(worldbook.contains("赛博校园"));
        assert_eq!(glossary.len(), 4);
    }

    #[tokio::test]
    async fn memory_agent_rejects_empty_synopsis() {
        let agent = MemoryAgent;
        let ctx = AgentContext {
            chat: &crate::agents::router::NoChatGateway,
            prompt: "",
            instruction: "",
            synopsis: "  ",
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
