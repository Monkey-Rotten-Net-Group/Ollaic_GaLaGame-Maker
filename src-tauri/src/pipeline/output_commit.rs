use std::collections::HashSet;
use std::path::Path;

use crate::agents::{AgentError, AgentOutput, AgentOutputPayload};
use crate::asset_queue::AssetTaskStatus;
use crate::pipeline::dsl::{StepExecutor, StepKind};
use crate::pipeline::recovery::PipelineError;
use crate::pipeline::state::{Clock, RunState, StepStatus};
use crate::story_plan::StoryPlan;

pub(crate) fn validate_output_contract(
    kind: StepKind,
    executor: &StepExecutor,
    out: &AgentOutput,
) -> Result<(), AgentError> {
    let valid = match (kind, executor, &out.payload) {
        (StepKind::Asset, StepExecutor::AssetQueue, AgentOutputPayload::AssetQueue(_)) => true,
        (_, StepExecutor::AssetQueue, _) => false,
        (StepKind::Plan, _, AgentOutputPayload::Synopsis(_)) => true,
        (StepKind::Memory, _, AgentOutputPayload::Memory { .. }) => true,
        (StepKind::Outline, _, AgentOutputPayload::Outline { .. }) => true,
        (StepKind::Character, _, AgentOutputPayload::Characters(_)) => true,
        (
            StepKind::Scene,
            _,
            AgentOutputPayload::SceneDrafts(_) | AgentOutputPayload::Scenes(_),
        ) => true,
        (StepKind::Asset, _, AgentOutputPayload::AssetPlan(_)) => true,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(AgentError(format!(
            "step kind '{}' cannot commit '{}' output from executor {:?}",
            kind.as_str(),
            output_kind(&out.payload),
            executor
        )))
    }
}

fn output_kind(payload: &AgentOutputPayload) -> &'static str {
    match payload {
        AgentOutputPayload::Synopsis(_) => "synopsis",
        AgentOutputPayload::Memory { .. } => "memory",
        AgentOutputPayload::Outline { .. } => "outline",
        AgentOutputPayload::Characters(_) => "characters",
        AgentOutputPayload::SceneDrafts(_) => "sceneDrafts",
        AgentOutputPayload::AssetPlan(_) => "assetPlan",
        AgentOutputPayload::Scenes(_) => "scenes",
        AgentOutputPayload::AssetQueue(_) => "assetQueue",
    }
}

pub(crate) fn apply_output(plan: &mut StoryPlan, out: &AgentOutput) {
    match &out.payload {
        AgentOutputPayload::Synopsis(synopsis) => {
            plan.synopsis = synopsis.clone();
            plan.memory = Default::default();
            clear_after_memory(plan);
        }
        AgentOutputPayload::Memory {
            worldbook,
            glossary,
        } => {
            plan.memory.worldbook = worldbook.clone();
            plan.memory.glossary = glossary.clone();
            clear_after_memory(plan);
        }
        AgentOutputPayload::Outline {
            chapters,
            scene_plans,
            branches,
        } => {
            plan.chapters = chapters.clone();
            plan.scene_plans = scene_plans.clone();
            plan.branches = branches.clone();
            plan.characters.clear();
            plan.scene_drafts.clear();
            plan.asset_plan.clear();
            plan.scenes.clear();
        }
        AgentOutputPayload::Characters(characters) => {
            reconcile_scene_casts(&mut plan.scene_plans, characters);
            plan.characters = characters.clone();
            plan.scene_drafts.clear();
            plan.asset_plan.clear();
            plan.scenes.clear();
        }
        AgentOutputPayload::SceneDrafts(drafts) => {
            merge_scene_casts_from_drafts(&mut plan.scene_plans, drafts);
            plan.scene_drafts = drafts.clone();
            plan.asset_plan.clear();
            plan.scenes.clear();
        }
        AgentOutputPayload::AssetPlan(asset_plan) => {
            plan.asset_plan = asset_plan.clone();
            plan_figure_sprites(&mut plan.characters, asset_plan);
            plan.scenes.clear();
        }
        AgentOutputPayload::Scenes(scenes) => {
            plan.scenes = scenes.iter().map(|scene| scene.name.clone()).collect();
        }
        AgentOutputPayload::AssetQueue(_) => {}
    }
}

fn clear_after_memory(plan: &mut StoryPlan) {
    plan.chapters.clear();
    plan.characters.clear();
    plan.scene_plans.clear();
    plan.branches = Default::default();
    plan.scene_drafts.clear();
    plan.asset_plan.clear();
    plan.scenes.clear();
}

fn plan_figure_sprites(
    characters: &mut [crate::characters::types::Character],
    asset_plan: &[crate::story_plan::AssetTaskPlan],
) {
    for task in asset_plan.iter().filter(|task| task.kind == "figure") {
        let (Some(character_ref), Some(emotion)) =
            (task.character_ref.as_deref(), task.emotion.as_deref())
        else {
            continue;
        };
        let Some(character) = characters
            .iter_mut()
            .find(|character| character.id == character_ref || character.name == character_ref)
        else {
            continue;
        };
        if let Some(sprite) = character
            .sprites
            .iter_mut()
            .find(|sprite| sprite.emotion.eq_ignore_ascii_case(emotion))
        {
            if sprite.prompt.as_deref().is_none_or(str::is_empty) {
                sprite.prompt = Some(task.prompt.clone());
            }
        } else {
            character
                .sprites
                .push(crate::characters::types::CharacterSprite {
                    emotion: emotion.to_string(),
                    file: String::new(),
                    prompt: Some(task.prompt.clone()),
                });
        }
    }
}

pub(crate) fn apply_canonical_characters(
    plan: &mut StoryPlan,
    characters: Vec<crate::characters::types::Character>,
    preserve_scene_cast: bool,
) {
    if !preserve_scene_cast {
        let ids: HashSet<&str> = characters
            .iter()
            .map(|character| character.id.as_str())
            .collect();
        for scene in &mut plan.scene_plans {
            scene.character_ids.retain(|id| ids.contains(id.as_str()));
        }
    }
    plan.characters = characters;
}

pub(crate) fn reconcile_scene_casts(
    scenes: &mut [crate::story_plan::ScenePlan],
    characters: &[crate::characters::types::Character],
) {
    for scene in scenes {
        let mut seen = HashSet::new();
        scene.character_ids = scene
            .character_ids
            .iter()
            .filter_map(|reference| {
                characters
                    .iter()
                    .find(|character| {
                        matches_character_reference(reference, &character.id)
                            || matches_character_reference(reference, &character.name)
                            || character
                                .aliases
                                .iter()
                                .any(|alias| matches_character_reference(reference, alias))
                    })
                    .map(|character| character.id.clone())
            })
            .filter(|character| seen.insert(character.clone()))
            .collect();
    }
}

fn matches_character_reference(reference: &str, candidate: &str) -> bool {
    reference == candidate || reference.eq_ignore_ascii_case(candidate)
}

fn merge_scene_casts_from_drafts(
    scenes: &mut [crate::story_plan::ScenePlan],
    drafts: &[crate::story_plan::SceneDraft],
) {
    for scene in scenes {
        let Some(draft) = drafts.iter().find(|draft| draft.scene_id == scene.id) else {
            continue;
        };
        for character_id in draft
            .beats
            .iter()
            .flat_map(|beat| &beat.figure_cues)
            .map(|cue| &cue.character_id)
        {
            if !scene.character_ids.contains(character_id) {
                scene.character_ids.push(character_id.clone());
            }
        }
    }
}

pub(crate) struct OutputTransaction {
    backups: Vec<(std::path::PathBuf, Option<Vec<u8>>)>,
}

impl OutputTransaction {
    #[cfg(test)]
    pub(crate) fn apply(
        project_path: &Path,
        out: &AgentOutput,
        plan: &StoryPlan,
    ) -> Result<Self, AgentError> {
        crate::project_lock::with_project_lock(project_path, || {
            Self::apply_locked(project_path, out, plan)
        })
    }

    fn apply_locked(
        project_path: &Path,
        out: &AgentOutput,
        plan: &StoryPlan,
    ) -> Result<Self, AgentError> {
        let mut writes: Vec<(std::path::PathBuf, Vec<u8>)> = Vec::new();
        if matches!(
            &out.payload,
            AgentOutputPayload::Characters(_) | AgentOutputPayload::AssetPlan(_)
        ) {
            let document = crate::characters::types::CharactersDocument {
                version: 1,
                characters: plan.characters.clone(),
            };
            let bytes = serde_json::to_vec_pretty(&document)
                .map_err(|error| AgentError(format!("failed to serialize characters: {error}")))?;
            writes.push((project_path.join("game/config/characters.json"), bytes));
        }
        if let AgentOutputPayload::Scenes(scenes) = &out.payload {
            writes.extend(scenes.iter().map(|scene| {
                (
                    project_path.join("game/scene").join(&scene.name),
                    scene.content.as_bytes().to_vec(),
                )
            }));
        }
        crate::story_plan::validate(plan)
            .map_err(|error| AgentError(format!("failed to validate StoryPlan: {error}")))?;
        let plan_bytes = serde_json::to_vec_pretty(plan)
            .map_err(|error| AgentError(format!("failed to serialize StoryPlan: {error}")))?;
        writes.push((crate::story_plan::plan_path(project_path), plan_bytes));

        let mut transaction = Self {
            backups: Vec::new(),
        };
        for (path, bytes) in writes {
            let previous = match std::fs::read(&path) {
                Ok(content) => Some(content),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    let rollback = transaction.rollback_locked();
                    return Err(AgentError(format!(
                        "failed to snapshot output '{}': {}{}",
                        path.display(),
                        error,
                        rollback_suffix(rollback)
                    )));
                }
            };
            transaction.backups.push((path.clone(), previous));
            if let Some(parent) = path.parent() {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    let rollback = transaction.rollback_locked();
                    return Err(AgentError(format!(
                        "failed to create output directory '{}': {}{}",
                        parent.display(),
                        error,
                        rollback_suffix(rollback)
                    )));
                }
            }
            if let Err(error) = crate::json_store::write_crash_safe(&path, &bytes) {
                let rollback = transaction.rollback_locked();
                return Err(AgentError(format!(
                    "failed to write output '{}': {}{}",
                    path.display(),
                    error,
                    rollback_suffix(rollback)
                )));
            }
        }
        Ok(transaction)
    }

    fn rollback_locked(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, previous) in self.backups.iter().rev() {
            let result = match previous {
                Some(content) => crate::json_store::write_crash_safe(path, content)
                    .map_err(|error| error.to_string()),
                None if path.exists() => {
                    std::fs::remove_file(path).map_err(|error| error.to_string())
                }
                None => Ok(()),
            };
            if let Err(error) = result {
                errors.push(format!("{}: {}", path.display(), error));
            }
        }
        self.backups.clear();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join(", "))
        }
    }

    pub(crate) fn commit(mut self) {
        self.backups.clear();
    }
}

pub(crate) struct CommittedStepOutput {
    pub(crate) run_id: String,
    pub(crate) output: Option<String>,
}

/// Commit under one project lock. Persisting the snapshot id before project
/// writes is the recovery record for a crash before the success state lands.
pub(crate) fn commit_step_output(
    project_path: &Path,
    state: &mut RunState,
    step_id: &str,
    out: &AgentOutput,
    plan: &StoryPlan,
    clock: &dyn Clock,
) -> Result<CommittedStepOutput, AgentError> {
    crate::project_lock::with_project_lock(project_path, || {
        let snapshot_id =
            create_rollback_snapshot_locked(project_path, &state.run_id, step_id, out)?;
        if let Some(snapshot_id) = snapshot_id.as_deref() {
            if let Some(attempt) = state
                .find_step_mut(step_id)
                .and_then(|step| step.history.last_mut())
            {
                attempt.rollback_snapshot = Some(snapshot_id.to_string());
            }
            state.updated_at = clock.now_ms();
            if let Err(error) = crate::pipeline::store::save_run_state(project_path, state) {
                if let Some(attempt) = state
                    .find_step_mut(step_id)
                    .and_then(|step| step.history.last_mut())
                {
                    attempt.rollback_snapshot = None;
                }
                let cleanup = crate::webgal::project::delete_project_snapshot_locked(
                    &project_path.to_string_lossy(),
                    snapshot_id,
                )
                .err()
                .map(|error| format!("; snapshot cleanup failed: {error}"))
                .unwrap_or_default();
                return Err(AgentError(format!(
                    "failed to persist rollback snapshot: {error}{cleanup}"
                )));
            }
        }

        let mut transaction = OutputTransaction::apply_locked(project_path, out, plan)?;
        let running_state = state.clone();
        {
            let step = state.find_step_mut(step_id).expect("step exists");
            let finished_at = clock.now_ms();
            let output = serialize_output(out);
            step.status = StepStatus::Succeeded;
            step.finished_at = Some(finished_at);
            step.output = Some(output.clone());
            if let Some(attempt) = step.history.last_mut() {
                attempt.output = Some(output);
                attempt.finished_at = Some(finished_at);
                attempt.duration_ms = Some(finished_at.saturating_sub(attempt.started_at));
                attempt.diff = Some(describe_output(out));
                attempt.prompt_tokens = out.prompt_tokens;
                attempt.completion_tokens = out.completion_tokens;
                for warning in &out.warnings {
                    if !attempt.warnings.contains(warning) {
                        attempt.warnings.push(warning.clone());
                    }
                }
                attempt.downgrade = out.downgrade.clone();
            }
        }
        state.updated_at = clock.now_ms();
        if let Err(error) = crate::pipeline::store::save_run_state(project_path, state) {
            let rollback = transaction.rollback_locked();
            *state = running_state;
            return Err(AgentError(format!(
                "failed to persist step success: {error}{}",
                rollback_suffix(rollback)
            )));
        }
        transaction.commit();
        Ok(CommittedStepOutput {
            run_id: state.run_id.clone(),
            output: state
                .find_step(step_id)
                .expect("step exists")
                .output
                .clone(),
        })
    })
}

pub(crate) fn rollback_suffix(result: Result<(), String>) -> String {
    result
        .err()
        .map(|error| format!("; rollback failed: {error}"))
        .unwrap_or_default()
}

fn create_rollback_snapshot_locked(
    project_path: &Path,
    run_id: &str,
    step_id: &str,
    out: &AgentOutput,
) -> Result<Option<String>, AgentError> {
    if !matches!(
        &out.payload,
        AgentOutputPayload::Characters(_)
            | AgentOutputPayload::AssetPlan(_)
            | AgentOutputPayload::Scenes(_)
    ) {
        return Ok(None);
    }
    std::fs::create_dir_all(project_path.join("game"))
        .map_err(|error| AgentError(format!("failed to prepare project snapshot: {error}")))?;
    let project = project_path.to_string_lossy().to_string();
    crate::webgal::project::create_project_snapshot_locked(
        &project,
        Some(format!("Agent {run_id} {step_id}")),
        Some("auto".to_string()),
        Some("Automatic rollback point before an Agent Flow writes playable files".to_string()),
    )
    .map(|snapshot| Some(snapshot.id))
    .map_err(|error| AgentError(format!("failed to create rollback snapshot: {error}")))
}

pub(crate) fn restore_interrupted_outputs(
    project_path: &Path,
    state: &RunState,
) -> Result<(), PipelineError> {
    let project = project_path.to_string_lossy().to_string();
    crate::project_lock::with_project_lock(project_path, || {
        for snapshot_id in state
            .steps
            .iter()
            .filter(|step| step.status == StepStatus::Running)
            .filter_map(|step| step.history.last()?.rollback_snapshot.as_deref())
        {
            crate::webgal::project::restore_project_snapshot_locked(&project, snapshot_id)
                .map_err(|error| {
                    PipelineError::Recovery(format!(
                        "failed to restore rollback snapshot {snapshot_id}: {error}"
                    ))
                })?;
        }
        Ok(())
    })
}

pub(crate) fn serialize_output(out: &AgentOutput) -> String {
    let mut value = match &out.payload {
        AgentOutputPayload::Synopsis(value) => serde_json::json!({ "synopsis": value }),
        AgentOutputPayload::Memory {
            worldbook,
            glossary,
        } => serde_json::json!({
            "worldbook": worldbook.chars().take(500).collect::<String>(), "glossary": glossary
        }),
        AgentOutputPayload::Outline {
            chapters,
            scene_plans,
            branches,
        } => serde_json::json!({
            "chapters": chapters, "scenePlans": scene_plans, "branches": branches
        }),
        AgentOutputPayload::Characters(values) => serde_json::json!({
            "characters": values.iter().map(|value| serde_json::json!({"id": value.id, "name": value.name})).collect::<Vec<_>>()
        }),
        AgentOutputPayload::SceneDrafts(values) => serde_json::json!({
            "sceneDrafts": values.iter().map(|value| serde_json::json!({
                "sceneId": value.scene_id, "title": value.title, "beatCount": value.beats.len(),
                "excerpt": value.beats.first().map(|beat| &beat.text)
            })).collect::<Vec<_>>()
        }),
        AgentOutputPayload::AssetPlan(values) => serde_json::json!({ "assetPlan": values }),
        AgentOutputPayload::Scenes(values) => serde_json::json!({
            "scenes": values.iter().map(|value| serde_json::json!({
                "name": value.name, "contentRef": format!("game/scene/{}", value.name)
            })).collect::<Vec<_>>()
        }),
        AgentOutputPayload::AssetQueue(queue) => serde_json::json!({ "assetQueue": queue }),
    };
    if let Some(fields) = value.as_object_mut() {
        fields.insert("model".into(), serde_json::json!(out.model));
        fields.insert("promptTokens".into(), serde_json::json!(out.prompt_tokens));
        fields.insert(
            "completionTokens".into(),
            serde_json::json!(out.completion_tokens),
        );
        fields.insert("warnings".into(), serde_json::json!(out.warnings));
        fields.insert("downgrade".into(), serde_json::json!(out.downgrade));
    }
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

pub(crate) fn describe_output(out: &AgentOutput) -> String {
    let changed = match &out.payload {
        AgentOutputPayload::Synopsis(_) => "synopsis".to_string(),
        AgentOutputPayload::Memory { .. } => "memory".to_string(),
        AgentOutputPayload::Outline { chapters, .. } => format!("chapters:{}", chapters.len()),
        AgentOutputPayload::Characters(values) => format!("characters:{}", values.len()),
        AgentOutputPayload::SceneDrafts(values) => format!("sceneDrafts:{}", values.len()),
        AgentOutputPayload::AssetPlan(values) => format!("assetPlan:{}", values.len()),
        AgentOutputPayload::Scenes(values) => format!("sceneFiles:{}", values.len()),
        AgentOutputPayload::AssetQueue(queue) => format!(
            "assetQueue:{} succeeded",
            queue
                .tasks
                .iter()
                .filter(|task| task.status == AssetTaskStatus::Succeeded)
                .count()
        ),
    };
    format!("StoryPlan updated: {changed}")
}

#[cfg(test)]
#[path = "output_commit_tests.rs"]
mod tests;
