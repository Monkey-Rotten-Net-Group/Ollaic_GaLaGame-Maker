use std::collections::HashSet;
use std::path::Path;

use crate::agents::{AgentOutput, AgentOutputPayload};
use crate::story_plan::StoryPlan;

use super::dsl::FlowScope;

/// Read the actual saved predecessor scripts, including changes made in the editor.
pub(super) fn preceding_scene_tail(
    project: &Path,
    plan: &StoryPlan,
    target: &str,
) -> Result<String, String> {
    let root = project
        .canonicalize()
        .map_err(|error| format!("failed to resolve project: {error}"))?;
    let mut predecessors = Vec::new();
    for edge in plan.branches.edges.iter().filter(|edge| edge.to == target) {
        if predecessors.contains(&edge.from) {
            continue;
        }
        predecessors.push(edge.from.clone());
    }
    let mut tails = Vec::new();
    for predecessor in predecessors {
        let scene = plan
            .scene_plans
            .iter()
            .find(|scene| scene.id == predecessor)
            .ok_or_else(|| format!("unknown predecessor scene: {predecessor}"))?;
        let path = root.join("game/scene").join(&scene.file);
        // Branches from unproduced scenes do not have an entry state yet.
        if !path.exists() && !plan.scenes.contains(&scene.file) {
            continue;
        }
        let resolved = path.canonicalize().map_err(|error| {
            format!("failed to resolve preceding scene {}: {error}", scene.file)
        })?;
        if !resolved.starts_with(root.join("game/scene")) {
            return Err("preceding scene path escapes the project scene directory".into());
        }
        let text = std::fs::read_to_string(&resolved)
            .map_err(|error| format!("failed to read preceding scene {}: {error}", scene.file))?;
        let lines: Vec<_> = text.lines().collect();
        tails.push(format!(
            "[{}]\n{}",
            scene.id,
            lines[lines.len().saturating_sub(10)..].join("\n")
        ));
    }
    Ok(tails.join("\n\n"))
}

/// Limit executable assets while retaining the complete graph for ID/file resolution.
pub(super) fn production_plan(plan: &StoryPlan, scope: &FlowScope) -> StoryPlan {
    let mut selected = plan.clone();
    match scope {
        FlowScope::Project => {}
        FlowScope::Setup => {
            selected
                .asset_plan
                .retain(|task| task.kind == "figure" && task.emotion.as_deref() == Some("default"));
            selected.scenes.clear();
            selected.scene_drafts.clear();
        }
        FlowScope::Scene { scene_id } => {
            let scene = plan.scene_plans.iter().find(|scene| &scene.id == scene_id);
            let visible: HashSet<_> = plan
                .scene_drafts
                .iter()
                .filter(|draft| &draft.scene_id == scene_id)
                .flat_map(|draft| &draft.beats)
                .flat_map(|beat| &beat.figure_cues)
                .map(|cue| (cue.character_id.as_str(), cue.emotion.as_str()))
                .collect();
            selected.asset_plan.retain(|task| match task.kind.as_str() {
                "figure" => task.character_ref.as_deref().is_some_and(|character| {
                    visible.contains(&(character, task.emotion.as_deref().unwrap_or("default")))
                        || (task.emotion.as_deref() == Some("default")
                            && visible.iter().any(|(id, _)| *id == character))
                }),
                "background" => task
                    .scene_ref
                    .as_deref()
                    .and_then(|id| plan.scene_plans.iter().find(|source| source.id == id))
                    .zip(scene)
                    .is_some_and(|(source, scene)| {
                        crate::agents::asset_planner::shares_background(source, scene)
                    }),
                _ => task.scene_ref.is_none() || task.scene_ref.as_ref() == Some(scene_id),
            });
            selected
                .scene_drafts
                .retain(|draft| &draft.scene_id == scene_id);
            selected.scenes = scene
                .map(|scene| vec![scene.file.clone()])
                .unwrap_or_default();
        }
    }
    selected
}

/// Existing shared assets keep their canonical prompts and names during scene production.
pub(super) fn preserve_shared_assets(
    output: &mut AgentOutput,
    plan: &StoryPlan,
    scope: &FlowScope,
) {
    let FlowScope::Scene { .. } = scope else {
        return;
    };
    let AgentOutputPayload::AssetPlan(tasks) = &mut output.payload else {
        return;
    };
    for task in tasks {
        if let Some(previous) = plan.asset_plan.iter().find(|previous| {
            (previous.id == task.id
                || (previous.kind == task.kind && previous.target_stem == task.target_stem)
                || (previous.kind == "figure"
                    && task.kind == "figure"
                    && previous.character_ref == task.character_ref
                    && previous.emotion.as_deref().unwrap_or("default")
                        == task.emotion.as_deref().unwrap_or("default")))
                && (task.kind == "figure" || task.kind == "background" || task.scene_ref.is_none())
        }) {
            *task = previous.clone();
        }
    }
}

pub(super) fn validate_scoped_output(
    output: &AgentOutput,
    plan: &StoryPlan,
    scope: &FlowScope,
) -> Result<(), String> {
    let FlowScope::Scene { scene_id } = scope else {
        return Ok(());
    };
    let scene = plan
        .scene_plans
        .iter()
        .find(|scene| &scene.id == scene_id)
        .ok_or("target scene disappeared")?;
    let valid = match &output.payload {
        AgentOutputPayload::SceneDrafts(drafts) => {
            drafts.len() == 1 && drafts[0].scene_id == *scene_id
        }
        AgentOutputPayload::Scenes(scenes) => scenes.len() == 1 && scenes[0].name == scene.file,
        AgentOutputPayload::AssetPlan(tasks) => tasks.iter().all(|task| {
            task.scene_ref.as_ref().is_none_or(|id| id == scene_id)
                || plan.asset_plan.iter().any(|old| old == task)
        }),
        AgentOutputPayload::AssetQueue(_) => true,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("scene-scoped step attempted to modify another scene".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::story_plan::types::{BranchEdge, ScenePlan};

    #[test]
    fn missing_produced_predecessor_is_an_error_and_multiple_saved_parents_are_kept() {
        let project =
            std::env::temp_dir().join(format!("ollaic_preceding_tail_{}", std::process::id()));
        std::fs::create_dir_all(project.join("game/scene")).unwrap();
        let mut plan = StoryPlan::new("story");
        for id in ["one", "two", "next"] {
            plan.scene_plans.push(ScenePlan {
                id: id.into(),
                file: format!("{id}.txt"),
                ..Default::default()
            });
        }
        for from in ["one", "two"] {
            plan.branches.edges.push(BranchEdge {
                from: from.into(),
                to: "next".into(),
                choice: None,
                ..Default::default()
            });
        }
        plan.scenes = vec!["one.txt".into(), "two.txt".into()];
        std::fs::write(project.join("game/scene/one.txt"), ":First saved parent;").unwrap();
        assert!(preceding_scene_tail(&project, &plan, "next")
            .unwrap_err()
            .contains("two.txt"));
        std::fs::write(project.join("game/scene/two.txt"), ":Second saved parent;").unwrap();
        let tail = preceding_scene_tail(&project, &plan, "next").unwrap();
        assert!(tail.contains("First saved parent") && tail.contains("Second saved parent"));
        std::fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn scene_output_cannot_commit_another_scene() {
        let mut plan = StoryPlan::new("story");
        plan.scene_plans.push(ScenePlan {
            id: "one".into(),
            file: "one.txt".into(),
            ..Default::default()
        });
        let out = AgentOutput::new(AgentOutputPayload::Scenes(vec![
            crate::agents::SceneScript {
                name: "other.txt".into(),
                content: ":Wrong scene;".into(),
            },
        ]));
        assert!(validate_scoped_output(
            &out,
            &plan,
            &FlowScope::Scene {
                scene_id: "one".into()
            }
        )
        .is_err());
    }
}
