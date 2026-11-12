use std::path::Path;

use crate::story_plan::types::SceneApprovalStatus;
use crate::story_plan::StoryPlan;

pub(crate) fn require_scene_unlocked(plan: &StoryPlan, scene_id: &str) -> Result<(), String> {
    let scene = plan
        .scene_plans
        .iter()
        .find(|scene| scene.id == scene_id)
        .ok_or_else(|| format!("未知场景：{scene_id}"))?;
    if scene.approval_status == SceneApprovalStatus::Approved {
        return Err("本场景已通过并锁定；请先解锁再修改。".into());
    }
    Ok(())
}

pub(crate) fn approve_scene(project: &Path, scene_id: &str) -> Result<StoryPlan, String> {
    update_review(project, scene_id, true)
}

pub(crate) fn unlock_scene(project: &Path, scene_id: &str) -> Result<StoryPlan, String> {
    update_review(project, scene_id, false)
}

fn update_review(project: &Path, scene_id: &str, approve: bool) -> Result<StoryPlan, String> {
    crate::project_lock::with_project_lock(project, || {
        crate::flow_edit_lock::ensure_editable(
            project,
            crate::flow_edit_lock::FlowResource::StoryPlan,
        )?;
        if crate::pipeline::store::list_run_states(project)
            .map_err(|error| error.to_string())?
            .iter()
            .any(|run| !run.status.is_terminal())
        {
            return Err("请先完成或停止当前流程，再审阅场景。".into());
        }
        let mut plan = crate::story_plan::load_plan(project)
            .map_err(|error| error.to_string())?
            .ok_or("项目尚无故事计划")?;
        let index = plan
            .scene_plans
            .iter()
            .position(|scene| scene.id == scene_id)
            .ok_or_else(|| format!("未知场景：{scene_id}"))?;
        let scene = &plan.scene_plans[index];
        if approve {
            if scene.approval_status == SceneApprovalStatus::Stale {
                return Err("本场景已过期，请重新生成并审阅后再通过。".into());
            }
            if !plan.scenes.contains(&scene.file)
                || !plan
                    .scene_drafts
                    .iter()
                    .any(|draft| draft.scene_id == scene_id)
            {
                return Err("本场景尚未完成对白和脚本生成。".into());
            }
            let source = read_scene_source(project, &scene.file)?;
            let nodes = crate::webgal::parser::parse_script(&source);
            let dialogue: Vec<&str> = nodes
                .iter()
                .filter(|node| {
                    matches!(
                        node.cmd_type,
                        crate::webgal::types::CommandType::Dialogue
                            | crate::webgal::types::CommandType::Narrator
                    )
                })
                .map(|node| node.content.trim())
                .filter(|content| !content.is_empty())
                .collect();
            if dialogue.is_empty() {
                return Err("本场景脚本没有可审阅的对白或旁白。".into());
            }
            let summary = dialogue[dialogue.len().saturating_sub(10)..].join("\n");
            plan.scene_plans[index].rolling_summary = Some(summary);
            plan.scene_plans[index].approval_status = SceneApprovalStatus::Approved;
        } else if scene.approval_status == SceneApprovalStatus::Approved {
            plan.scene_plans[index].approval_status = SceneApprovalStatus::Drafted;
        }
        crate::story_plan::save_plan(project, &plan).map_err(|error| error.to_string())?;
        Ok(plan)
    })
}

fn read_scene_source(project: &Path, file: &str) -> Result<String, String> {
    let root = project
        .canonicalize()
        .map_err(|error| format!("failed to resolve project for review: {error}"))?;
    let path = project
        .join("game/scene")
        .join(file)
        .canonicalize()
        .map_err(|error| format!("failed to resolve scene for review: {error}"))?;
    if !path.starts_with(root.join("game/scene")) {
        return Err("scene review path must remain inside the project's scene directory".into());
    }
    std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read scene for review: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review_project(name: &str) -> (std::path::PathBuf, StoryPlan) {
        let project =
            std::env::temp_dir().join(format!("ollaic_scene_review_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(project.join("game/scene")).unwrap();
        let mut plan = StoryPlan::new("Review");
        plan.chapters = serde_json::from_value(serde_json::json!([
            {"id":"ch1", "title":"Chapter", "summary":"Chapter summary"}
        ]))
        .unwrap();
        plan.scene_plans = serde_json::from_value(serde_json::json!([
            {"id":"opening", "file":"start.txt", "chapterId":"ch1", "title":"Opening", "summary":"Opening summary", "approvalStatus":"drafted"}
        ]))
        .unwrap();
        plan.branches.entry_scene = "opening".into();
        plan.scene_drafts = serde_json::from_value(serde_json::json!([
            {"sceneId":"opening", "title":"Opening", "beats":[{"text":"A remembered line"}]}
        ]))
        .unwrap();
        plan.scenes.push("start.txt".into());
        std::fs::write(
            project.join("game/scene/start.txt"),
            ":A manually edited line;",
        )
        .unwrap();
        crate::story_plan::save_plan(&project, &plan).unwrap();
        (project, plan)
    }

    #[test]
    fn approval_and_explicit_unlock_survive_reload_without_changing_script() {
        let (project, _) = review_project("approve");
        let approved = approve_scene(&project, "opening").unwrap();
        assert_eq!(
            approved.scene_plans[0].approval_status,
            SceneApprovalStatus::Approved
        );
        assert_eq!(
            approved.scene_plans[0].rolling_summary.as_deref(),
            Some("A manually edited line")
        );
        let reloaded = crate::story_plan::load_plan(&project).unwrap().unwrap();
        assert_eq!(reloaded, approved);
        assert!(require_scene_unlocked(&reloaded, "opening").is_err());
        let unlocked = unlock_scene(&project, "opening").unwrap();
        assert_eq!(
            unlocked.scene_plans[0].approval_status,
            SceneApprovalStatus::Drafted
        );
        require_scene_unlocked(&unlocked, "opening").unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            ":A manually edited line;"
        );
        std::fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn stale_or_missing_scripts_cannot_be_approved() {
        let (project, mut plan) = review_project("stale");
        plan.scene_plans[0].approval_status = SceneApprovalStatus::Stale;
        crate::story_plan::save_plan(&project, &plan).unwrap();
        assert!(approve_scene(&project, "opening")
            .unwrap_err()
            .contains("过期"));
        plan.scene_plans[0].approval_status = SceneApprovalStatus::Drafted;
        crate::story_plan::save_plan(&project, &plan).unwrap();
        std::fs::remove_file(project.join("game/scene/start.txt")).unwrap();
        assert!(approve_scene(&project, "opening").is_err());
        assert_eq!(
            crate::story_plan::load_plan(&project)
                .unwrap()
                .unwrap()
                .scene_plans[0]
                .approval_status,
            SceneApprovalStatus::Drafted
        );
        std::fs::remove_dir_all(project).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn review_rejects_a_scene_symlink_outside_the_project() {
        let (project, _) = review_project("symlink");
        let external = project
            .parent()
            .unwrap()
            .join(format!("ollaic_review_external_{}.txt", std::process::id()));
        std::fs::write(&external, ":External private line;").unwrap();
        std::fs::remove_file(project.join("game/scene/start.txt")).unwrap();
        std::os::unix::fs::symlink(&external, project.join("game/scene/start.txt")).unwrap();
        assert!(approve_scene(&project, "opening")
            .unwrap_err()
            .contains("inside"));
        std::fs::remove_dir_all(project).unwrap();
        std::fs::remove_file(external).unwrap();
    }
}
