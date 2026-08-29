use std::path::Path;

use base64::Engine;

use super::transaction::{
    delete_artifact, load_queue_consistent, promote_artifact, resolve_artifact,
};
use super::AssetQueue;

#[tauri::command]
pub fn asset_queue_get(project_path: String) -> Result<Option<AssetQueue>, String> {
    let project = Path::new(&project_path);
    load_queue_consistent(project)
}

#[tauri::command]
pub fn asset_queue_preview_artifact(
    project_path: String,
    task_id: String,
    attempt: u32,
) -> Result<String, String> {
    let project = Path::new(&project_path);
    let queue =
        load_queue_consistent(project)?.ok_or_else(|| "asset queue not found".to_string())?;
    let artifact = resolve_artifact(project, &queue, &task_id, attempt)?;
    let bytes = std::fs::read(&artifact)
        .map_err(|error| format!("failed to read artifact {}: {error}", artifact.display()))?;
    let mime = mime_guess::from_path(&artifact).first_or_octet_stream();
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub async fn asset_queue_delete_artifact(
    project_path: String,
    task_id: String,
    attempt: u32,
) -> Result<AssetQueue, String> {
    let _guard = super::lock_queue_writes().await;
    let project = Path::new(&project_path);
    delete_artifact(project, &task_id, attempt)
}

#[tauri::command]
pub async fn asset_queue_promote_artifact(
    project_path: String,
    task_id: String,
    attempt: u32,
) -> Result<AssetQueue, String> {
    let _guard = super::lock_queue_writes().await;
    let project = Path::new(&project_path);
    promote_artifact(project, &task_id, attempt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_queue::store::save_queue;
    use crate::asset_queue::types::{AssetAttempt, AssetKind, AssetTask};
    use crate::asset_queue::AssetTaskStatus;

    #[tokio::test]
    async fn artifact_can_be_previewed_promoted_and_deleted() {
        let project =
            std::env::temp_dir().join(format!("ollaic_artifact_commands_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(project.join("game/scene")).unwrap();
        std::fs::write(project.join("game/scene/start.txt"), ":hello;\n").unwrap();
        let artifact = project.join(".ollaic/artifacts/assets/bg_start/1.png");
        std::fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        std::fs::write(&artifact, b"png").unwrap();
        let queue = AssetQueue::new(
            "run-1",
            vec![AssetTask {
                id: "bg_start".into(),
                kind: AssetKind::Background,
                target_stem: "bg_start".into(),
                prompt: "background".into(),
                scene_ref: Some("start.txt".into()),
                character_ref: None,
                emotion: None,
                dialogue_index: None,
                text: None,
                status: AssetTaskStatus::Failed,
                attempts: vec![AssetAttempt {
                    attempt: 1,
                    started_at: 1,
                    finished_at: 2,
                    artifact: Some(artifact.to_string_lossy().into_owned()),
                    error: None,
                    used_local_fallback: false,
                }],
                asset_file: None,
                error: Some("review rejected".into()),
                used_local_fallback: false,
            }],
            2,
        );
        save_queue(&project, &queue).unwrap();
        let project_string = project.to_string_lossy().into_owned();

        assert!(
            asset_queue_preview_artifact(project_string.clone(), "bg_start".into(), 1)
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        let promoted = asset_queue_promote_artifact(project_string.clone(), "bg_start".into(), 1)
            .await
            .unwrap();
        assert_eq!(promoted.tasks[0].status, AssetTaskStatus::Succeeded);
        assert!(
            std::fs::read_to_string(project.join("game/scene/start.txt"))
                .unwrap()
                .contains("changeBg:bg_start.png;")
        );
        let cleaned = asset_queue_delete_artifact(project_string, "bg_start".into(), 1)
            .await
            .unwrap();
        assert!(cleaned.tasks[0].attempts[0].artifact.is_none());
        assert!(!artifact.exists());
        let _ = std::fs::remove_dir_all(project);
    }
}
