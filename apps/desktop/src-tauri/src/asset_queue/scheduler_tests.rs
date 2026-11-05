use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

struct RetryOnce(AtomicUsize);
struct AlwaysGenerate;
struct TransparentFigure;
struct AlwaysFail(AtomicUsize);
struct CountingGenerate(AtomicUsize);
struct PlaceholderThenImage(AtomicUsize);
struct MissingConfiguration(AtomicUsize);
/// Mirrors production preflight: BGM/SFX have no AI route, and every other
/// task would fail if it were ever run.
struct ManualAudioOnly(AtomicUsize);
struct FailFourThenSucceed(AtomicUsize);
struct BlockingGenerator {
    started: Arc<tokio::sync::Semaphore>,
    proceed: Arc<tokio::sync::Semaphore>,
}
struct ConcurrencyProbe {
    current: [AtomicUsize; 3],
    maximum: [AtomicUsize; 3],
}

impl AssetGenerator for RetryOnce {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                Err("transient".to_string())
            } else {
                Ok(GeneratedArtifact {
                    extension: "png".to_string(),
                    bytes: b"image".to_vec(),
                    used_local_fallback: false,
                })
            }
        })
    }
}

impl AssetGenerator for AlwaysGenerate {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async {
            Ok(GeneratedArtifact {
                extension: "wav".to_string(),
                bytes: b"audio".to_vec(),
                used_local_fallback: false,
            })
        })
    }
}

fn transparent_png() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        1,
        1,
        image::Rgba([0, 0, 0, 0]),
    ))
    .write_to(&mut bytes, image::ImageFormat::Png)
    .unwrap();
    bytes.into_inner()
}

impl AssetGenerator for TransparentFigure {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async {
            Ok(GeneratedArtifact {
                extension: "png".to_string(),
                bytes: transparent_png(),
                used_local_fallback: false,
            })
        })
    }
}

impl AssetGenerator for AlwaysFail {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err("nope".to_string())
        })
    }
}

impl AssetGenerator for CountingGenerate {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(GeneratedArtifact {
                extension: "wav".to_string(),
                bytes: b"asset".to_vec(),
                used_local_fallback: false,
            })
        })
    }
}

impl AssetGenerator for PlaceholderThenImage {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            Ok(GeneratedArtifact {
                extension: "png".into(),
                bytes: transparent_png(),
                used_local_fallback: self.0.fetch_add(1, Ordering::SeqCst) == 0,
            })
        })
    }
}

impl AssetGenerator for MissingConfiguration {
    fn preflight(&self, _task: &AssetTask) -> Result<(), String> {
        Err("missing API key".to_string())
    }

    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err("must not run".to_string())
        })
    }
}

impl AssetGenerator for ManualAudioOnly {
    fn preflight(&self, task: &AssetTask) -> Result<(), String> {
        if task.kind.requires_manual_import() {
            return Err("BGM/SFX does not support AI generation".to_string());
        }
        Ok(())
    }

    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(format!("{} must not be generated", task.id))
        })
    }
}

impl AssetGenerator for FailFourThenSucceed {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            if self.0.fetch_add(1, Ordering::SeqCst) < 4 {
                Err("nope".to_string())
            } else {
                Ok(GeneratedArtifact {
                    extension: "png".to_string(),
                    bytes: b"image".to_vec(),
                    used_local_fallback: false,
                })
            }
        })
    }
}

impl AssetGenerator for BlockingGenerator {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            self.started.add_permits(1);
            self.proceed
                .acquire()
                .await
                .map_err(|_| "test semaphore closed".to_string())?
                .forget();
            Ok(GeneratedArtifact {
                extension: "png".to_string(),
                bytes: b"image".to_vec(),
                used_local_fallback: false,
            })
        })
    }
}

impl ConcurrencyProbe {
    fn new() -> Self {
        Self {
            current: std::array::from_fn(|_| AtomicUsize::new(0)),
            maximum: std::array::from_fn(|_| AtomicUsize::new(0)),
        }
    }

    fn class(kind: AssetKind) -> usize {
        match kind {
            AssetKind::Background | AssetKind::Figure => 0,
            AssetKind::Tts => 1,
            AssetKind::Bgm | AssetKind::Sfx => 2,
        }
    }
}

impl AssetGenerator for ConcurrencyProbe {
    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            let class = Self::class(task.kind);
            let current = self.current[class].fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum[class].fetch_max(current, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            self.current[class].fetch_sub(1, Ordering::SeqCst);
            Ok(GeneratedArtifact {
                extension: if class == 0 { "png" } else { "wav" }.to_string(),
                bytes: vec![class as u8],
                used_local_fallback: false,
            })
        })
    }
}

fn task(id: String, kind: AssetKind, index: Option<usize>) -> AssetTask {
    AssetTask {
        target_stem: id.clone(),
        prompt: "test".to_string(),
        scene_ref: Some("start.txt".to_string()),
        character_ref: None,
        emotion: (kind == AssetKind::Figure).then(|| "default".to_string()),
        reference_image: None,
        aspect_ratio: None,
        dialogue_index: index,
        text: index.map(|value| format!("line {value}")),
        id,
        kind,
        status: AssetTaskStatus::Pending,
        attempts: Vec::new(),
        asset_file: None,
        error: None,
        used_local_fallback: false,
    }
}

fn plan_for(queue: &AssetQueue, scenes: Vec<String>) -> StoryPlan {
    let scene_plans = scenes
        .iter()
        .map(|file| crate::story_plan::ScenePlan {
            id: file.trim_end_matches(".txt").to_string(),
            file: file.clone(),
            chapter_id: "chapter".into(),
            title: file.clone(),
            summary: file.clone(),
            character_ids: Vec::new(),
            location_id: None,
            time_of_day: None,
            ..Default::default()
        })
        .collect::<Vec<_>>();
    let asset_plan = queue
        .tasks
        .iter()
        .filter(|task| task.kind != AssetKind::Tts)
        .map(|task| crate::story_plan::AssetTaskPlan {
            id: task.id.clone(),
            kind: match task.kind {
                AssetKind::Background => "background",
                AssetKind::Figure => "figure",
                AssetKind::Bgm => "bgm",
                AssetKind::Sfx => "sfx",
                AssetKind::Tts => unreachable!(),
            }
            .to_string(),
            target_stem: task.target_stem.clone(),
            prompt: task.prompt.clone(),
            scene_ref: task
                .scene_ref
                .as_deref()
                .map(|file| file.trim_end_matches(".txt").to_string()),
            character_ref: task.character_ref.clone(),
            emotion: task.emotion.clone(),
            reference_image: None,
            aspect_ratio: None,
            status: "pending".to_string(),
        })
        .collect();
    StoryPlan {
        scenes,
        scene_plans,
        asset_plan,
        ..StoryPlan::new("test")
    }
}

#[tokio::test]
async fn retries_generation_then_binds_serially() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_run_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-1",
        vec![AssetTask {
            id: "bg_start".to_string(),
            kind: AssetKind::Background,
            target_stem: "bg_start".to_string(),
            prompt: "background".to_string(),
            scene_ref: Some("start.txt".to_string()),
            character_ref: None,
            emotion: None,
            reference_image: None,
            aspect_ratio: None,
            dialogue_index: None,
            text: None,
            status: AssetTaskStatus::Pending,
            attempts: Vec::new(),
            asset_file: None,
            error: None,
            used_local_fallback: false,
        }],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".to_string()]);
    save_queue(&project, &queue).unwrap();
    let result = run_queue(
        &project,
        "run-1",
        &plan,
        Arc::new(RetryOnce(AtomicUsize::new(0))),
    )
    .await
    .unwrap();
    assert_eq!(result.tasks[0].status, AssetTaskStatus::Succeeded);
    assert_eq!(result.tasks[0].attempts.len(), 2);
    assert!(project.join("game/background/bg_start.png").is_file());
    assert!(
        std::fs::read_to_string(project.join("game/scene/start.txt"))
            .unwrap()
            .contains("changeBg:bg_start.png;")
    );
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn resumes_unfinished_queue_tasks_without_rerunning_succeeded_tasks() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_resume_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let artifact = project.join(".ollaic/artifacts/assets/done/1.wav");
    std::fs::create_dir_all(artifact.parent().unwrap()).unwrap();
    std::fs::write(&artifact, b"done").unwrap();
    std::fs::create_dir_all(project.join("game/background")).unwrap();
    std::fs::write(project.join("game/background/done.wav"), b"done").unwrap();

    let mut done = task("done".into(), AssetKind::Background, None);
    done.status = AssetTaskStatus::Succeeded;
    done.asset_file = Some("done.wav".into());
    done.attempts.push(AssetAttempt {
        attempt: 1,
        started_at: 1,
        finished_at: 2,
        artifact: Some(artifact.to_string_lossy().into_owned()),
        imported_file: None,
        error: None,
        used_local_fallback: false,
    });
    let mut running = task("running".into(), AssetKind::Background, None);
    running.status = AssetTaskStatus::Running;
    let mut retrying = task("retrying".into(), AssetKind::Background, None);
    retrying.status = AssetTaskStatus::Retrying;
    let queue = AssetQueue::new("run-resume", vec![done, running, retrying], now_ms());
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(CountingGenerate(AtomicUsize::new(0)));

    let resumed = run_queue(&project, "run-resume", &plan, generator.clone())
        .await
        .unwrap();

    assert_eq!(generator.0.load(Ordering::SeqCst), 2);
    assert!(resumed
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded));
    assert_eq!(resumed.tasks[0].attempts.len(), 1);
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn fallback_keeps_material_requirements_without_creating_media() {
    for kind in [AssetKind::Background, AssetKind::Figure, AssetKind::Tts] {
        let project = std::env::temp_dir().join(format!("ollaic_missing_{kind:?}_{}", now_ms()));
        std::fs::create_dir_all(project.join("game/scene")).unwrap();
        let script = "; Ollaic Scene Staging\n; ollaic-asset-task:missing\n:line 0;\n";
        std::fs::write(project.join("game/scene/start.txt"), script).unwrap();
        let mut missing = task(
            "missing".into(),
            kind,
            (kind == AssetKind::Tts).then_some(0),
        );
        if kind == AssetKind::Figure {
            missing.character_ref = Some("alice".into());
        }
        let queue = AssetQueue::new("run-missing", vec![missing], now_ms());
        save_queue(&project, &queue).unwrap();
        let queue = Mutex::new(queue);
        let generator = PlaceholderThenImage(AtomicUsize::new(0));
        let binding = generate_task(&project, &queue, 0, 1, &generator)
            .await
            .unwrap();
        assert!(
            binding.is_none(),
            "missing media must not enter the binding pass"
        );
        let result = load_queue(&project).unwrap();
        let missing = &result.tasks[0];
        assert_eq!(missing.status, AssetTaskStatus::Succeeded);
        assert!(missing.used_local_fallback);
        assert!(missing.asset_file.is_none());
        assert!(missing.attempts[0].artifact.is_none());
        assert!(!project.join(".ollaic/artifacts/assets").exists());
        assert!(!project.join("game").join(kind.game_dir()).exists());
        assert_eq!(
            std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
            script
        );
        std::fs::remove_dir_all(project).unwrap();
    }
}

#[tokio::test]
async fn rerun_replaces_a_successful_placeholder_with_a_generated_image() {
    let project = std::env::temp_dir().join(format!("ollaic_upgrade_placeholder_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-upgrade",
        vec![task("bg_placeholder".into(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(PlaceholderThenImage(AtomicUsize::new(0)));
    let placeholder = run_queue(&project, "run-upgrade", &plan, generator.clone())
        .await
        .unwrap();
    assert!(placeholder.tasks[0].used_local_fallback);
    assert!(placeholder.tasks[0].asset_file.is_none());
    assert!(placeholder.tasks[0].attempts[0].artifact.is_none());
    assert!(!project.join(".ollaic/artifacts/assets").exists());
    assert!(!project.join("game/background").exists());
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
        "; empty\n"
    );

    let upgraded = run_queue_cancellable(
        &project,
        "run-upgrade",
        &plan,
        generator.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
        QueueRunOptions {
            scope: None,
            retry_placeholders: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        generator.0.load(Ordering::SeqCst),
        2,
        "rerun must call the image provider again"
    );
    assert_eq!(upgraded.tasks[0].status, AssetTaskStatus::Succeeded);
    assert!(!upgraded.tasks[0].used_local_fallback);
    assert_eq!(upgraded.tasks[0].attempts.len(), 2);
    assert!(upgraded.tasks[0].attempts[0].used_local_fallback);
    let metadata =
        crate::assets::commands::read_asset_metadata(&project.to_string_lossy()).unwrap();
    let filename = upgraded.tasks[0].asset_file.as_deref().unwrap();
    let tags = &metadata.tags[&format!("background/{filename}")];
    assert!(tags.iter().any(|tag| tag == "source:ai"));
    assert!(!tags.iter().any(|tag| tag == "source:fallback"));
    let resumed = run_queue(&project, "run-upgrade", &plan, generator.clone())
        .await
        .unwrap();
    assert_eq!(
        generator.0.load(Ordering::SeqCst),
        2,
        "a real image must remain reusable"
    );
    assert!(!resumed.tasks[0].used_local_fallback);
    let metadata =
        crate::assets::commands::read_asset_metadata(&project.to_string_lossy()).unwrap();
    assert!(metadata.tags[&format!("background/{filename}")]
        .iter()
        .any(|tag| tag == "source:ai"));
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn scoped_rerun_upgrades_a_reused_placeholder_without_changing_inactive_tasks() {
    let project = std::env::temp_dir().join(format!("ollaic_upgrade_scoped_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "setup-run",
        vec![task("bg_anchor".into(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(PlaceholderThenImage(AtomicUsize::new(0)));
    let mut existing = run_queue(&project, "setup-run", &plan, generator.clone())
        .await
        .unwrap();
    // Model a persisted queue from before missing media stopped producing files.
    let artifact = project.join(".ollaic/artifacts/assets/bg_anchor/1.png");
    std::fs::create_dir_all(artifact.parent().unwrap()).unwrap();
    std::fs::write(&artifact, transparent_png()).unwrap();
    existing.tasks[0].attempts[0].artifact = Some(artifact.to_string_lossy().into_owned());
    existing.tasks[0].asset_file =
        Some(super::super::binder::bind_asset(&project, &existing.tasks[0]).unwrap());
    let inactive = serde_json::to_value(&existing.tasks[0]).unwrap();
    let mut reused = task("bg_reused".into(), AssetKind::Background, None);
    reused.status = AssetTaskStatus::Succeeded;
    reused.asset_file = existing.tasks[0].asset_file.clone();
    reused.attempts.push(AssetAttempt {
        attempt: 1,
        started_at: 1,
        finished_at: 2,
        artifact: None,
        imported_file: reused.asset_file.clone(),
        error: None,
        used_local_fallback: false,
    });
    existing.tasks.push(reused);
    save_queue(&project, &existing).unwrap();
    let plan = plan_for(&existing, vec!["start.txt".into()]);
    let upgraded = run_queue_cancellable(
        &project,
        "scene-run",
        &plan,
        generator.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
        QueueRunOptions {
            scope: Some(&QueueScope {
                task_ids: HashSet::from(["bg_reused".into()]),
                scene_file: Some("start.txt".into()),
            }),
            retry_placeholders: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 2);
    assert_eq!(serde_json::to_value(&upgraded.tasks[0]).unwrap(), inactive);
    assert!(!upgraded.tasks[1].used_local_fallback);
    assert_eq!(upgraded.tasks[1].attempts.len(), 2);
    assert_ne!(upgraded.tasks[0].asset_file, upgraded.tasks[1].asset_file);
    std::fs::remove_dir_all(project).unwrap();
}

#[tokio::test]
async fn a_new_run_does_not_treat_a_placeholder_as_a_manual_image_import() {
    let project = std::env::temp_dir().join(format!("ollaic_upgrade_new_run_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "old-run",
        vec![task("bg_placeholder".into(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(PlaceholderThenImage(AtomicUsize::new(0)));
    run_queue(&project, "old-run", &plan, generator.clone())
        .await
        .unwrap();
    let upgraded = run_queue(&project, "new-run", &plan, generator.clone())
        .await
        .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 2);
    assert!(!upgraded.tasks[0].used_local_fallback);
    assert!(upgraded.tasks[0].attempts[0].artifact.is_some());
    assert!(upgraded.tasks[0].attempts[0].imported_file.is_none());
    std::fs::remove_dir_all(project).unwrap();
}

#[tokio::test]
async fn binding_failure_does_not_leave_a_formal_asset() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_bind_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), ":actual;\n").unwrap();
    let queue = AssetQueue::new(
        "run-2",
        vec![AssetTask {
            id: "figure_alice".to_string(),
            kind: AssetKind::Figure,
            target_stem: "alice_default".to_string(),
            prompt: "Alice".to_string(),
            scene_ref: Some("start.txt".to_string()),
            character_ref: Some("alice".to_string()),
            emotion: Some("default".to_string()),
            reference_image: None,
            aspect_ratio: None,
            dialogue_index: None,
            text: None,
            status: AssetTaskStatus::Pending,
            attempts: Vec::new(),
            asset_file: None,
            error: None,
            used_local_fallback: false,
        }],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".to_string()]);
    save_queue(&project, &queue).unwrap();
    let result = run_queue(&project, "run-2", &plan, Arc::new(TransparentFigure))
        .await
        .unwrap();
    assert_eq!(result.tasks[0].status, AssetTaskStatus::Failed);
    assert!(!project.join("game/figure/alice_default.png").exists());
    assert!(project
        .join(".ollaic/artifacts/assets/figure_alice/1.png")
        .is_file());
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn enforces_image_and_music_concurrency_limits() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_limits_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    let scene = (0..8)
        .map(|index| format!(":line {index};"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(project.join("game/scene/start.txt"), scene).unwrap();
    let mut tasks = Vec::new();
    tasks.extend((0..6).map(|index| task(format!("bg_{index}"), AssetKind::Background, None)));
    tasks.extend((0..3).map(|index| task(format!("bgm_{index}"), AssetKind::Bgm, None)));
    let queue = AssetQueue::new("run-limits", tasks, now_ms());
    let plan = plan_for(&queue, vec!["start.txt".to_string()]);
    save_queue(&project, &queue).unwrap();
    let probe = Arc::new(ConcurrencyProbe::new());
    let result = run_queue(&project, "run-limits", &plan, probe.clone())
        .await
        .unwrap();
    assert!(result
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded));
    assert_eq!(probe.maximum[0].load(Ordering::SeqCst), 2);
    assert_eq!(probe.maximum[1].load(Ordering::SeqCst), 0);
    assert_eq!(probe.maximum[2].load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn permanent_failure_stops_after_initial_attempt_plus_three_retries() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_fail_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-fail",
        vec![task("bg_fail".to_string(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".to_string()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(AlwaysFail(AtomicUsize::new(0)));
    let result = run_queue(&project, "run-fail", &plan, generator.clone())
        .await
        .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 4);
    assert_eq!(result.tasks[0].attempts.len(), 4);
    assert_eq!(result.tasks[0].status, AssetTaskStatus::Failed);
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn unavailable_capability_stays_pending_without_retrying() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_blocked_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-blocked",
        vec![task("bg_blocked".into(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(MissingConfiguration(AtomicUsize::new(0)));

    let result = run_queue(&project, "run-blocked", &plan, generator.clone())
        .await
        .unwrap();

    assert_eq!(generator.0.load(Ordering::SeqCst), 0);
    assert_eq!(result.tasks[0].status, AssetTaskStatus::Pending);
    assert!(result.tasks[0]
        .error
        .as_deref()
        .unwrap()
        .starts_with("pending configuration:"));
    assert!(result.tasks[0].attempts.is_empty());
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn manual_rerun_gets_a_fresh_retry_budget() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_rerun_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-rerun",
        vec![task("bg_rerun".to_string(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".to_string()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(FailFourThenSucceed(AtomicUsize::new(0)));

    let failed = run_queue(&project, "run-rerun", &plan, generator.clone())
        .await
        .unwrap();
    assert_eq!(failed.tasks[0].status, AssetTaskStatus::Failed);
    let succeeded = run_queue(&project, "run-rerun", &plan, generator)
        .await
        .unwrap();
    assert_eq!(succeeded.tasks[0].status, AssetTaskStatus::Succeeded);
    assert_eq!(succeeded.tasks[0].attempts.len(), 5);
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn manual_audio_tasks_stay_pending_until_an_audio_file_is_imported() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_manual_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-manual",
        vec![
            task("bgm_theme".into(), AssetKind::Bgm, None),
            task("sfx_door".into(), AssetKind::Sfx, None),
        ],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();

    let blocked = run_queue(
        &project,
        "run-manual",
        &plan,
        Arc::new(ManualAudioOnly(AtomicUsize::new(0))),
    )
    .await
    .unwrap();

    for task in &blocked.tasks {
        assert_eq!(task.status, AssetTaskStatus::Pending);
        assert!(task.attempts.is_empty());
        assert!(
            task.error
                .as_deref()
                .unwrap()
                .starts_with(PENDING_MANUAL_IMPORT_PREFIX),
            "{} should wait for a manual import, not a provider: {:?}",
            task.id,
            task.error
        );
    }
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn rerun_binds_imported_bgm_and_sfx_and_stays_idempotent() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_import_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::create_dir_all(project.join("game/bgm")).unwrap();
    std::fs::create_dir_all(project.join("game/vocal")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-import",
        vec![
            task("bgm_theme".into(), AssetKind::Bgm, None),
            task("sfx_door".into(), AssetKind::Sfx, None),
        ],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(ManualAudioOnly(AtomicUsize::new(0)));

    let blocked = run_queue(&project, "run-import", &plan, generator.clone())
        .await
        .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 0);
    assert!(blocked
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Pending));

    // The user imports audio through the asset library, which only copies the
    // file into game/bgm or game/vocal.
    std::fs::write(project.join("game/bgm/bgm_theme.mp3"), b"theme").unwrap();
    std::fs::write(project.join("game/vocal/sfx_door.wav"), b"door").unwrap();

    let bound = run_queue(&project, "run-import", &plan, generator.clone())
        .await
        .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 0);
    assert!(bound
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded));
    assert_eq!(bound.tasks[0].asset_file.as_deref(), Some("bgm_theme.mp3"));
    assert_eq!(bound.tasks[1].asset_file.as_deref(), Some("sfx_door.wav"));
    assert!(bound.tasks.iter().all(|task| task
        .attempts
        .last()
        .and_then(|attempt| attempt.imported_file.as_deref())
        .is_some()));
    assert!(bound.tasks.iter().all(|task| !task.used_local_fallback));
    let scene = std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap();
    assert!(scene.contains("bgm:bgm_theme.mp3;"), "{scene}");
    assert!(scene.contains("playEffect:sfx_door.wav;"), "{scene}");

    let persisted = load_queue(&project).unwrap();
    assert_eq!(persisted, bound);
    let scene_before_rerun = scene;

    let rerun = run_queue(&project, "run-import", &plan, generator.clone())
        .await
        .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 0);
    assert!(rerun
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded));
    assert_eq!(
        rerun.tasks[0].attempts.len(),
        1,
        "rerun must not add attempts"
    );
    assert_eq!(
        rerun.tasks[1].attempts.len(),
        1,
        "rerun must not add attempts"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
        scene_before_rerun,
        "rebinding the same file must not duplicate scene commands"
    );
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn manual_import_ignores_unrelated_audio_files() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_unrelated_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::create_dir_all(project.join("game/bgm")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    std::fs::write(project.join("game/bgm/someone_elses_song.mp3"), b"other").unwrap();
    let queue = AssetQueue::new(
        "run-unrelated",
        vec![task("bgm_theme".into(), AssetKind::Bgm, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();

    let result = run_queue(
        &project,
        "run-unrelated",
        &plan,
        Arc::new(ManualAudioOnly(AtomicUsize::new(0))),
    )
    .await
    .unwrap();

    assert_eq!(result.tasks[0].status, AssetTaskStatus::Pending);
    assert!(result.tasks[0].asset_file.is_none());
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
        "; empty\n"
    );
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn cancellation_after_generation_stops_serial_binding() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_cancel_bind_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let queue = AssetQueue::new(
        "run-cancel-bind",
        vec![task("bg_one".into(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let binding_gate = Arc::new(Mutex::new(()));
    let binding_guard = binding_gate.lock().await;
    let run_binding_gate = binding_gate.clone();
    let run_project = project.clone();
    let run_cancelled = cancelled.clone();
    let run = tokio::spawn(async move {
        run_queue_cancellable(
            &run_project,
            "run-cancel-bind",
            &plan,
            Arc::new(AlwaysGenerate),
            run_cancelled,
            run_binding_gate,
            QueueRunOptions::default(),
        )
        .await
    });
    let artifact = project.join(".ollaic/artifacts/assets/bg_one/1.wav");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !artifact.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("generation did not reach the binding gate");
    cancelled.store(true, Ordering::SeqCst);
    drop(binding_guard);

    let result = run.await.unwrap();
    assert_eq!(result.unwrap_err(), ASSET_QUEUE_CANCELLED);
    assert!(cancelled.load(Ordering::SeqCst));
    assert!(!project.join("game/background/bg_one.wav").exists());
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn scheduler_does_not_overwrite_artifact_command_edits() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_command_race_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    let artifact = project.join(".ollaic/artifacts/assets/old/1.png");
    std::fs::create_dir_all(artifact.parent().unwrap()).unwrap();
    std::fs::write(&artifact, b"old").unwrap();
    let mut old = task("old".into(), AssetKind::Background, None);
    old.status = AssetTaskStatus::Succeeded;
    old.asset_file = Some("old.png".into());
    old.attempts.push(AssetAttempt {
        attempt: 1,
        started_at: 0,
        finished_at: 1,
        artifact: Some(artifact.to_string_lossy().into_owned()),
        imported_file: None,
        error: None,
        used_local_fallback: false,
    });
    let queue = AssetQueue::new(
        "run-command-race",
        vec![old, task("new".into(), AssetKind::Background, None)],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let proceed = Arc::new(tokio::sync::Semaphore::new(0));
    let generator = Arc::new(BlockingGenerator {
        started: started.clone(),
        proceed: proceed.clone(),
    });
    let run_project = project.clone();
    let run =
        tokio::spawn(
            async move { run_queue(&run_project, "run-command-race", &plan, generator).await },
        );
    tokio::time::timeout(Duration::from_secs(1), started.acquire())
        .await
        .expect("generator did not start")
        .unwrap()
        .forget();
    let edit_project = project.to_string_lossy().into_owned();
    let mut edit = tokio::spawn(async move {
        crate::asset_queue::commands::asset_queue_delete_artifact(edit_project, "old".into(), 1)
            .await
    });
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut edit)
        .await
        .is_err());
    proceed.add_permits(10);
    run.await.unwrap().unwrap();
    let edited = edit.await.unwrap().unwrap();
    assert!(edited.tasks[0].attempts[0].artifact.is_none());

    let persisted = load_queue(&project).unwrap();
    assert!(persisted.tasks[0].attempts[0].artifact.is_none());
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn recovery_preserves_completed_fallback_provenance() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_provenance_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::create_dir_all(project.join("game/background")).unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "; empty\n").unwrap();
    std::fs::write(project.join("game/background/fallback.png"), b"fallback").unwrap();
    let mut fallback = task("fallback".into(), AssetKind::Background, None);
    fallback.status = AssetTaskStatus::Succeeded;
    fallback.asset_file = Some("fallback.png".into());
    fallback.used_local_fallback = true;
    fallback.attempts.push(AssetAttempt {
        attempt: 1,
        started_at: 0,
        finished_at: 1,
        artifact: None,
        imported_file: None,
        error: None,
        used_local_fallback: true,
    });
    let queue = AssetQueue::new(
        "run-provenance",
        vec![
            fallback,
            task("provider".into(), AssetKind::Background, None),
        ],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();

    let recovered = run_queue(&project, "run-provenance", &plan, Arc::new(AlwaysGenerate))
        .await
        .unwrap();

    assert!(recovered.tasks[0].used_local_fallback);
    assert!(!recovered.tasks[1].used_local_fallback);
    let persisted = load_queue(&project).unwrap();
    assert!(persisted.tasks[0].used_local_fallback);
    let _ = std::fs::remove_dir_all(project);
}

#[tokio::test]
async fn same_run_rebinds_succeeded_assets_after_scene_recompile() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_rebind_{}", now_ms()));
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::create_dir_all(project.join("game/config")).unwrap();
    std::fs::create_dir_all(project.join("game/background")).unwrap();
    std::fs::create_dir_all(project.join("game/figure")).unwrap();
    std::fs::write(
            project.join("game/scene/start.txt"),
            "; Ollaic Scene Staging\n; ollaic-asset-task:alice\n; ollaic-figure-staging:changeFigure:none -id=alice -figureCharacter=alice -figureEmotion=default -right;\n",
        )
        .unwrap();
    std::fs::write(
        project.join("game/config/characters.json"),
        r#"{"version":1,"characters":[{"id":"alice","name":"Alice"}]}"#,
    )
    .unwrap();
    std::fs::write(project.join("game/background/room.png"), b"background").unwrap();
    std::fs::write(project.join("game/figure/alice.png"), transparent_png()).unwrap();

    let mut background = task("room".into(), AssetKind::Background, None);
    background.status = AssetTaskStatus::Succeeded;
    background.asset_file = Some("room.png".into());
    let mut figure = task("alice".into(), AssetKind::Figure, None);
    figure.status = AssetTaskStatus::Succeeded;
    figure.asset_file = Some("alice.png".into());
    figure.character_ref = Some("alice".into());
    let queue = AssetQueue::new("run-rebind", vec![background, figure], now_ms());
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();

    let generated = Arc::new(AlwaysFail(AtomicUsize::new(0)));
    let result = run_queue(&project, "run-rebind", &plan, generated.clone())
        .await
        .unwrap();

    assert!(result
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded));
    assert_eq!(generated.0.load(Ordering::SeqCst), 0);
    let scene = std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap();
    assert!(scene.contains("changeBg:room.png;"));
    assert!(scene.contains(
        "changeFigure:alice.png -right -id=alice -figureCharacter=alice -figureEmotion=default;"
    ));
    let _ = std::fs::remove_dir_all(project);
}

struct AnchorOrderProbe {
    project: std::path::PathBuf,
    fail_anchor: bool,
    variants: AtomicUsize,
}

impl AssetGenerator for AnchorOrderProbe {
    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            if task.emotion.as_deref() == Some("default") {
                if self.fail_anchor {
                    return Err("anchor failed".into());
                }
                let reference = self
                    .project
                    .join("game/config/references/alice/anchor_raw.png");
                std::fs::create_dir_all(reference.parent().unwrap()).unwrap();
                std::fs::write(reference, transparent_png()).unwrap();
            } else {
                let persisted = load_queue(&self.project).unwrap();
                assert!(persisted
                    .tasks
                    .iter()
                    .any(|anchor| anchor.emotion.as_deref() == Some("default")
                        && anchor.status == AssetTaskStatus::Succeeded));
                assert!(self
                    .project
                    .join("game/config/references/alice/anchor_raw.png")
                    .is_file());
                assert!(self.project.join("game/figure/alice_default.png").is_file());
                self.variants.fetch_add(1, Ordering::SeqCst);
            }
            Ok(GeneratedArtifact {
                extension: "png".into(),
                bytes: transparent_png(),
                used_local_fallback: false,
            })
        })
    }
}

fn anchor_order_project(fail_anchor: bool) -> (std::path::PathBuf, AssetQueue, StoryPlan) {
    let project =
        std::env::temp_dir().join(format!("ollaic_anchor_order_{}_{fail_anchor}", now_ms()));
    std::fs::create_dir_all(project.join("game/config/references/alice")).unwrap();
    std::fs::create_dir_all(project.join("game/scene")).unwrap();
    std::fs::write(
        project.join("game/config/characters.json"),
        r#"{"version":1,"characters":[{"id":"alice","name":"Alice"}]}"#,
    )
    .unwrap();
    std::fs::write(project.join("game/scene/start.txt"), "Alice:hello;\n").unwrap();
    let tasks = ["smile", "default"].map(|emotion| AssetTask {
        id: format!("figure_alice_{emotion}"),
        target_stem: format!("alice_{emotion}"),
        kind: AssetKind::Figure,
        character_ref: Some("alice".into()),
        emotion: Some(emotion.into()),
        prompt: "Alice".into(),
        ..Default::default()
    });
    let mut queue = AssetQueue::new("run-anchors", tasks.to_vec(), now_ms());
    queue.limits.max_retries = 0;
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    (project, queue, plan)
}

#[tokio::test]
async fn variants_start_only_after_anchor_is_saved_and_bound() {
    let (project, _, plan) = anchor_order_project(false);
    let probe = Arc::new(AnchorOrderProbe {
        project: project.clone(),
        fail_anchor: false,
        variants: AtomicUsize::new(0),
    });
    let result = run_queue(&project, "run-anchors", &plan, probe.clone())
        .await
        .unwrap();
    assert!(result
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded));
    assert_eq!(probe.variants.load(Ordering::SeqCst), 1);
    std::fs::remove_dir_all(project).unwrap();
}

#[tokio::test]
async fn failed_anchor_blocks_variants_even_with_stale_reference() {
    let (project, _, plan) = anchor_order_project(true);
    std::fs::write(
        project.join("game/config/references/alice/anchor_raw.png"),
        transparent_png(),
    )
    .unwrap();
    let probe = Arc::new(AnchorOrderProbe {
        project: project.clone(),
        fail_anchor: true,
        variants: AtomicUsize::new(0),
    });
    let result = run_queue(&project, "run-anchors", &plan, probe.clone())
        .await
        .unwrap();
    assert!(result
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Failed));
    assert_eq!(probe.variants.load(Ordering::SeqCst), 0);
    std::fs::remove_dir_all(project).unwrap();
}

#[tokio::test]
async fn provided_background_and_nested_default_sprite_bind_without_generation_and_resume() {
    let project = std::env::temp_dir().join(format!("ollaic_queue_presets_{}", now_ms()));
    for directory in [
        "game/scene",
        "game/background",
        "game/figure/alice",
        "game/config",
    ] {
        std::fs::create_dir_all(project.join(directory)).unwrap();
    }
    std::fs::write(project.join("game/scene/start.txt"), "Alice:hello;\n").unwrap();
    std::fs::write(
        project.join("game/background/courtyard.png"),
        transparent_png(),
    )
    .unwrap();
    std::fs::write(
        project.join("game/figure/alice/chosen.png"),
        transparent_png(),
    )
    .unwrap();
    std::fs::write(project.join("game/config/characters.json"), r#"{"version":1,"characters":[{"id":"alice","name":"Alice","sprites":[{"emotion":"default","file":"alice/chosen.png"}]}]}"#).unwrap();
    let queue = AssetQueue::new(
        "run-presets",
        vec![
            AssetTask {
                id: "background".into(),
                kind: AssetKind::Background,
                target_stem: "courtyard".into(),
                prompt: "courtyard".into(),
                scene_ref: Some("start.txt".into()),
                ..Default::default()
            },
            AssetTask {
                id: "figure_alice_default".into(),
                kind: AssetKind::Figure,
                target_stem: "alice_default".into(),
                prompt: "Alice".into(),
                character_ref: Some("alice".into()),
                emotion: Some("default".into()),
                ..Default::default()
            },
        ],
        now_ms(),
    );
    let plan = plan_for(&queue, vec!["start.txt".into()]);
    save_queue(&project, &queue).unwrap();
    let generator = Arc::new(MissingConfiguration(AtomicUsize::new(0)));
    let bound = run_queue(&project, "run-presets", &plan, generator.clone())
        .await
        .unwrap();
    assert!(bound
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded));
    assert_eq!(bound.tasks[0].asset_file.as_deref(), Some("courtyard.png"));
    assert_eq!(
        bound.tasks[1].asset_file.as_deref(),
        Some("alice/chosen.png")
    );
    let script = std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap();
    assert!(script.contains("changeBg:courtyard.png;"));
    assert!(script.contains("changeFigure:alice/chosen.png"));
    let resumed = run_queue(&project, "run-presets", &plan, generator.clone())
        .await
        .unwrap();
    assert!(resumed
        .tasks
        .iter()
        .all(|task| task.status == AssetTaskStatus::Succeeded && task.attempts.len() == 1));
    assert_eq!(generator.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        script,
        std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap()
    );
    std::fs::remove_dir_all(project).unwrap();
}

struct ScopedImageGenerator(AtomicUsize);

impl AssetGenerator for ScopedImageGenerator {
    fn generate<'a>(
        &'a self,
        _task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(GeneratedArtifact {
                extension: "png".into(),
                bytes: transparent_png(),
                used_local_fallback: false,
            })
        })
    }
}

#[tokio::test]
async fn scoped_queue_preserves_inactive_history_and_approved_scenes_across_reruns() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let project = std::env::temp_dir().join(format!("ollaic_scoped_queue_{nonce}"));
    for directory in [
        "game/scene",
        "game/config",
        "game/background",
        "game/figure",
    ] {
        std::fs::create_dir_all(project.join(directory)).unwrap();
    }
    let approved = "; Ollaic Scene Staging\n; ollaic-asset-task:bg_shared\nchangeBg:shared.png -next;\n; ollaic-asset-task:figure_alice_default\nchangeFigure:alice_default.png -id=alice -figureCharacter=alice -figureEmotion=default -right -next;\nAlice:author edited this line;\n";
    let selected = "; Ollaic Scene Staging\n; ollaic-asset-task:bg_shared\nchangeBg:placeholder.png -next;\n; ollaic-asset-task:figure_alice_default\n; ollaic-figure-staging:changeFigure:none -id=alice -figureCharacter=alice -figureEmotion=default -left;\nAlice:second scene;\n";
    std::fs::write(project.join("game/scene/start.txt"), approved).unwrap();
    std::fs::write(project.join("game/scene/second.txt"), selected).unwrap();
    std::fs::write(
        project.join("game/config/characters.json"),
        r#"{"version":1,"characters":[{"id":"alice","name":"Alice"}]}"#,
    )
    .unwrap();
    std::fs::write(
        project.join("game/background/shared.png"),
        b"approved background",
    )
    .unwrap();
    std::fs::write(
        project.join("game/figure/alice_default.png"),
        transparent_png(),
    )
    .unwrap();
    let attempt = AssetAttempt {
        attempt: 1,
        started_at: 10,
        finished_at: 11,
        artifact: None,
        imported_file: None,
        error: None,
        used_local_fallback: false,
    };
    let mut inactive = task("unrelated_failed".into(), AssetKind::Background, None);
    inactive.status = AssetTaskStatus::Failed;
    inactive.attempts = vec![AssetAttempt {
        error: Some("historical failure".into()),
        ..attempt.clone()
    }];
    inactive.error = Some("historical failure".into());
    let shared = AssetTask {
        id: "bg_shared".into(),
        kind: AssetKind::Background,
        target_stem: "shared".into(),
        prompt: "original".into(),
        scene_ref: Some("start.txt".into()),
        status: AssetTaskStatus::Succeeded,
        asset_file: Some("shared.png".into()),
        attempts: vec![attempt.clone()],
        ..Default::default()
    };
    let anchor = AssetTask {
        id: "figure_alice_default".into(),
        kind: AssetKind::Figure,
        target_stem: "alice_default".into(),
        prompt: "Alice".into(),
        character_ref: Some("alice".into()),
        emotion: Some("default".into()),
        status: AssetTaskStatus::Succeeded,
        asset_file: Some("alice_default.png".into()),
        attempts: vec![attempt],
        ..Default::default()
    };
    let existing = AssetQueue::new(
        "old-run",
        vec![inactive.clone(), shared.clone(), anchor.clone()],
        now_ms(),
    );
    save_queue(&project, &existing).unwrap();
    let active = AssetQueue::new("new-run", vec![shared, anchor], now_ms());
    let mut plan = plan_for(&active, vec!["start.txt".into(), "second.txt".into()]);
    let scope = QueueScope {
        task_ids: active.tasks.iter().map(|task| task.id.clone()).collect(),
        scene_file: Some("second.txt".into()),
    };
    let generator = Arc::new(ScopedImageGenerator(AtomicUsize::new(0)));
    let result = run_queue_cancellable(
        &project,
        "new-run",
        &plan,
        generator.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
        QueueRunOptions {
            scope: Some(&scope),
            retry_placeholders: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 0);
    assert_eq!(result.tasks[0], inactive);
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
        approved
    );
    let second = std::fs::read_to_string(project.join("game/scene/second.txt")).unwrap();
    assert!(second.contains("changeBg:shared.png"));
    assert!(second.contains("changeFigure:alice_default.png"));
    plan.asset_plan
        .iter_mut()
        .find(|task| task.id == "bg_shared")
        .unwrap()
        .prompt = "revised background".into();
    let changed = run_queue_cancellable(
        &project,
        "third-run",
        &plan,
        generator.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
        QueueRunOptions {
            scope: Some(&scope),
            retry_placeholders: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 1);
    assert_eq!(changed.tasks[0], inactive);
    assert_eq!(changed.tasks[1].attempts.len(), 2);
    assert_ne!(changed.tasks[1].asset_file.as_deref(), Some("shared.png"));
    assert_eq!(
        std::fs::read(project.join("game/background/shared.png")).unwrap(),
        b"approved background"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
        approved
    );
    let recovered = run_queue_cancellable(
        &project,
        "retry-run",
        &plan,
        generator.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
        QueueRunOptions {
            scope: Some(&scope),
            retry_placeholders: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(generator.0.load(Ordering::SeqCst), 1);
    assert_eq!(recovered.tasks[0], inactive);
    assert_eq!(recovered.tasks[1].attempts.len(), 2);
    assert_eq!(
        std::fs::read_to_string(project.join("game/scene/start.txt")).unwrap(),
        approved
    );
    std::fs::remove_dir_all(project).unwrap();
}

#[tokio::test]
async fn setup_queue_binds_anchors_without_touching_existing_scene_scripts() {
    let (project, mut queue, plan) = anchor_order_project(false);
    queue
        .tasks
        .retain(|task| task.emotion.as_deref() == Some("default"));
    save_queue(&project, &queue).unwrap();
    let original = std::fs::read(project.join("game/scene/start.txt")).unwrap();
    let scope = QueueScope {
        task_ids: queue.tasks.iter().map(|task| task.id.clone()).collect(),
        scene_file: None,
    };
    let result = run_queue_cancellable(
        &project,
        "setup-run",
        &plan,
        Arc::new(ScopedImageGenerator(AtomicUsize::new(0))),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
        QueueRunOptions {
            scope: Some(&scope),
            retry_placeholders: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.tasks.len(), 1);
    assert_eq!(result.tasks[0].status, AssetTaskStatus::Succeeded);
    assert!(project.join("game/figure/alice_default.png").is_file());
    assert_eq!(
        std::fs::read(project.join("game/scene/start.txt")).unwrap(),
        original
    );
    std::fs::remove_dir_all(project).unwrap();
}
