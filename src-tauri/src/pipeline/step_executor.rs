use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::agents::{AgentContext, AgentError, AgentOutput, AgentOutputPayload, AgentRegistry};
use crate::asset_queue::AssetTaskStatus;
use crate::pipeline::asset_executor::AssetGeneratorFactory;
use crate::pipeline::dsl::{StepExecutor, StepKind};
use crate::story_plan::StoryPlan;

pub(crate) struct ExecutorContext<'a> {
    pub(crate) executor: &'a StepExecutor,
    pub(crate) kind: StepKind,
    pub(crate) agent_context: &'a AgentContext<'a>,
    pub(crate) agents: &'a AgentRegistry,
    pub(crate) asset_generators: &'a dyn AssetGeneratorFactory,
    pub(crate) project_path: &'a Path,
    pub(crate) run_id: &'a str,
    pub(crate) plan: &'a StoryPlan,
    pub(crate) cancelled: &'a Arc<AtomicBool>,
    pub(crate) asset_binding_gate: &'a Arc<Mutex<()>>,
    #[cfg(test)]
    pub(crate) hanging_asset_queue_started: Option<&'a Arc<tokio::sync::Semaphore>>,
}

pub(crate) async fn execute(context: ExecutorContext<'_>) -> Result<AgentOutput, AgentError> {
    match context.executor {
        StepExecutor::Agent | StepExecutor::NamedAgent(_) => {
            let agent = context
                .agents
                .get(context.kind, context.executor)
                .ok_or_else(|| {
                    AgentError(format!(
                        "no agent registered for step kind '{}'",
                        context.kind.as_str()
                    ))
                })?;
            agent.run(context.agent_context).await
        }
        StepExecutor::AssetQueue => execute_asset_queue(context).await,
    }
}

async fn execute_asset_queue(context: ExecutorContext<'_>) -> Result<AgentOutput, AgentError> {
    #[cfg(test)]
    if let Some(started) = context.hanging_asset_queue_started {
        started.add_permits(1);
        return std::future::pending().await;
    }

    let generator = context.asset_generators.create(
        context.agent_context.allow_local_fallback,
        context.cancelled.clone(),
    );
    let queue = crate::asset_queue::run_queue_cancellable(
        context.project_path,
        context.run_id,
        context.plan,
        generator,
        context.cancelled.clone(),
        context.asset_binding_gate.clone(),
    )
    .await
    .map_err(AgentError)?;
    let failed = queue
        .tasks
        .iter()
        .filter(|task| task.status == AssetTaskStatus::Failed)
        .count();
    if failed > 0 {
        return Err(AgentError(format!(
            "asset queue finished with {failed} failed task(s)"
        )));
    }

    let downgraded = queue
        .tasks
        .iter()
        .any(|task| task.status == AssetTaskStatus::Succeeded && task.used_local_fallback);
    let pending_configuration = queue
        .tasks
        .iter()
        .filter(|task| {
            task.status == AssetTaskStatus::Pending
                && task
                    .error
                    .as_deref()
                    .is_some_and(|error| error.starts_with("pending configuration:"))
        })
        .count();
    let mut warnings = downgraded
        .then(|| "部分媒体供应商不可用，已生成本地占位素材".to_string())
        .into_iter()
        .collect::<Vec<_>>();
    if pending_configuration > 0 {
        warnings.push(format!("{pending_configuration} 个媒体任务等待供应商配置"));
    }
    let mut output = AgentOutput::new(AgentOutputPayload::AssetQueue(queue));
    output.warnings = warnings;
    output.downgrade = downgraded
        .then(|| "local-placeholder-assets".to_string())
        .or_else(|| (pending_configuration > 0).then(|| "media-capability-pending".to_string()));
    Ok(output)
}
