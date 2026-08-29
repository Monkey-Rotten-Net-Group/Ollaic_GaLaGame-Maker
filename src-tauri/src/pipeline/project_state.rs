use std::path::Path;

use crate::pipeline::recovery::PipelineError;
use crate::pipeline::state::Clock;
use crate::pipeline::store;
use crate::story_plan;
use crate::story_plan::types::PipelineRunSummary;
use crate::story_plan::StoryPlan;

#[cfg(test)]
pub(crate) fn project_has_story_content(project_path: &Path) -> Result<bool, String> {
    crate::project_lock::with_project_lock(project_path, || {
        project_has_story_content_locked(project_path)
    })
}

pub(crate) fn project_has_story_content_locked(project_path: &Path) -> Result<bool, String> {
    if story_plan::load_plan(project_path)
        .map_err(|error| error.to_string())?
        .is_some_and(|plan| {
            !plan.synopsis.trim().is_empty()
                || !plan.memory.worldbook.trim().is_empty()
                || !plan.memory.glossary.is_empty()
                || !plan.chapters.is_empty()
                || !plan.characters.is_empty()
                || !plan.scene_plans.is_empty()
                || !plan.scene_drafts.is_empty()
                || !plan.asset_plan.is_empty()
                || !plan.scenes.is_empty()
        })
    {
        return Ok(true);
    }

    let characters_path = project_path.join("game/config/characters.json");
    if characters_path.is_file()
        && !crate::characters::commands::list_characters_locked(&project_path.to_string_lossy())?
            .is_empty()
    {
        return Ok(true);
    }

    let scene_dir = project_path.join("game/scene");
    let entries = match std::fs::read_dir(&scene_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("failed to read {}: {error}", scene_dir.display())),
    };
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("txt") {
            continue;
        }
        let source = std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        if crate::webgal::parser::parse_script(&source)
            .iter()
            .any(|node| node.cmd_type != crate::webgal::types::CommandType::Comment)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn record_run_summary(
    project_path: &Path,
    run_id: &str,
    clock: &dyn Clock,
) -> Result<(), PipelineError> {
    let state = store::load_run_state(project_path, run_id)
        .map_err(PipelineError::Store)?
        .ok_or_else(|| PipelineError::RunNotFound(run_id.to_string()))?;
    crate::project_lock::with_project_lock(project_path, || {
        let mut plan = story_plan::load_plan(project_path)
            .map_err(PipelineError::Plan)?
            .unwrap_or_else(|| StoryPlan::new(""));
        let summary = PipelineRunSummary {
            run_id: run_id.to_string(),
            status: format!("{:?}", state.status).to_lowercase(),
            started_at: state.started_at,
            updated_at: clock.now_ms(),
        };
        plan.pipeline_runs
            .retain(|run| run.run_id != summary.run_id);
        plan.pipeline_runs.push(summary);
        story_plan::save_plan(project_path, &plan).map_err(PipelineError::Plan)
    })
}
