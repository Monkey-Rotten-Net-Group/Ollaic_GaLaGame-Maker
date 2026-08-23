use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{Mutex, Semaphore};

use super::binder::{bind_asset, rebind_asset};
use super::store::{load_queue, queue_path, save_queue};
use super::types::{AssetAttempt, AssetKind, AssetQueue, AssetTask, AssetTaskStatus};
use crate::project_transaction::ProjectFileTransaction;
use crate::story_plan::types::StoryPlan;

pub const ASSET_QUEUE_CANCELLED: &str = "asset queue cancelled";

pub struct GeneratedArtifact {
    pub extension: String,
    pub bytes: Vec<u8>,
    pub used_local_fallback: bool,
}

pub struct AssetQueueRun {
    pub queue: AssetQueue,
    pub transaction: ProjectFileTransaction,
}

pub trait AssetGenerator: Send + Sync {
    fn preflight(&self, _task: &AssetTask) -> Result<(), String> {
        Ok(())
    }

    fn generate<'a>(
        &'a self,
        task: &'a AssetTask,
    ) -> Pin<Box<dyn Future<Output = Result<GeneratedArtifact, String>> + Send + 'a>>;
}

/// Generate all runnable tasks with per-capability limits, then bind successful
/// artifacts serially so scene and metadata rewrites cannot lose each other.
pub async fn run_queue(
    project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
    generator: Arc<dyn AssetGenerator>,
) -> Result<AssetQueue, String> {
    run_queue_cancellable(
        project_path,
        run_id,
        plan,
        generator,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(())),
    )
    .await
}

pub async fn run_queue_cancellable(
    project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
    generator: Arc<dyn AssetGenerator>,
    cancelled: Arc<AtomicBool>,
    binding_gate: Arc<Mutex<()>>,
) -> Result<AssetQueue, String> {
    let AssetQueueRun {
        queue,
        mut transaction,
    } = run_queue_cancellable_transactional(
        project_path,
        run_id,
        plan,
        generator,
        cancelled,
        binding_gate,
    )
    .await?;
    if let Err(error) = transaction.prepare_commit() {
        let rollback = transaction
            .rollback()
            .err()
            .map(|rollback| format!("; rollback failed: {rollback}"))
            .unwrap_or_default();
        return Err(format!("{error}{rollback}"));
    }
    transaction.commit();
    Ok(queue)
}

pub async fn run_queue_cancellable_transactional(
    project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
    generator: Arc<dyn AssetGenerator>,
    cancelled: Arc<AtomicBool>,
    binding_gate: Arc<Mutex<()>>,
) -> Result<AssetQueueRun, String> {
    let mut transaction = ProjectFileTransaction::begin(
        project_path,
        &format!("asset-queue-{run_id}"),
        asset_queue_transaction_paths(),
    )
    .await?;
    let queue = match run_queue_inner(
        project_path,
        run_id,
        plan,
        generator,
        cancelled,
        binding_gate,
    )
    .await
    {
        Ok(queue) => queue,
        Err(error) => {
            let rollback = transaction
                .rollback()
                .err()
                .map(|rollback| format!("; rollback failed: {rollback}"))
                .unwrap_or_default();
            return Err(format!("{error}{rollback}"));
        }
    };
    Ok(AssetQueueRun { queue, transaction })
}

fn asset_queue_transaction_paths() -> Vec<std::path::PathBuf> {
    [
        "game/scene",
        "game/background",
        "game/figure",
        "game/bgm",
        "game/vocal",
        "game/config/characters.json",
        "game/config/asset-metadata.json",
        ".ollaic/assets/queue.json",
        ".ollaic/plan.json",
    ]
    .into_iter()
    .map(std::path::PathBuf::from)
    .collect()
}

async fn run_queue_inner(
    project_path: &Path,
    run_id: &str,
    plan: &StoryPlan,
    generator: Arc<dyn AssetGenerator>,
    cancelled: Arc<AtomicBool>,
    binding_gate: Arc<Mutex<()>>,
) -> Result<AssetQueue, String> {
    let _queue_guard = super::lock_queue_writes().await;
    let mut queue = load_queue(project_path)?;
    let same_run = queue.run_id == run_id;
    queue = if same_run {
        // The upstream scene may have been re-run since this queue was derived;
        // re-derive so moved dialogue regenerates instead of failing the
        // bind_tts text check. Succeeded tasks whose text/target is unchanged
        // are preserved, so this only re-runs what the upstream edit touched.
        super::store::rederive_queue(project_path, run_id, plan, &queue)?
    } else {
        super::store::derive_queue(project_path, run_id, plan)?
    };
    validate_limits(&queue)?;
    if same_run {
        for task in queue
            .tasks
            .iter_mut()
            .filter(|task| task.status == AssetTaskStatus::Succeeded)
        {
            let _binding_guard = binding_gate.lock().await;
            if cancelled.load(Ordering::SeqCst) {
                return Err(ASSET_QUEUE_CANCELLED.to_string());
            }
            if let Err(error) = rebind_asset(project_path, task) {
                task.status = AssetTaskStatus::Failed;
                task.error = Some(format!("rebinding failed: {error}"));
            }
        }
    }
    let attempt_budget = queue.limits.max_retries + 1;
    let mut runnable = Vec::new();
    for (index, task) in queue.tasks.iter_mut().enumerate() {
        if task.status == AssetTaskStatus::Succeeded {
            continue;
        }
        if let Err(error) = generator.preflight(task) {
            task.status = AssetTaskStatus::Pending;
            task.error = Some(format!("pending configuration: {error}"));
            continue;
        }
        let was_blocked = task
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("pending configuration:"));
        let limit = if same_run && (task.status == AssetTaskStatus::Failed || was_blocked) {
            task.attempts.len() as u32 + attempt_budget
        } else {
            attempt_budget
        };
        task.status = AssetTaskStatus::Pending;
        task.error = None;
        runnable.push((index, limit));
    }
    queue.updated_at = now_ms();
    save_queue(project_path, &queue)?;
    let queue = Arc::new(Mutex::new(queue));
    let image = Arc::new(Semaphore::new(queue.lock().await.limits.image));
    let tts = Arc::new(Semaphore::new(queue.lock().await.limits.tts));
    let music = Arc::new(Semaphore::new(queue.lock().await.limits.music));
    let project_path = project_path.to_path_buf();
    let mut futures = FuturesUnordered::new();

    for (index, attempt_limit) in runnable {
        let queue = queue.clone();
        let generator = generator.clone();
        let project_path = project_path.clone();
        let semaphore = {
            let task = queue.lock().await.tasks[index].clone();
            match task.kind {
                AssetKind::Background | AssetKind::Figure => image.clone(),
                AssetKind::Tts => tts.clone(),
                AssetKind::Bgm | AssetKind::Sfx => music.clone(),
            }
        };
        futures.push(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| "asset semaphore closed".to_string())?;
            generate_task(
                &project_path,
                &queue,
                index,
                attempt_limit,
                generator.as_ref(),
            )
            .await
        });
    }

    let mut generated = Vec::new();
    while let Some(result) = futures.next().await {
        if let Some(index) = result? {
            generated.push(index);
        }
    }
    generated.sort_unstable();

    for (position, &index) in generated.iter().enumerate() {
        let _binding_guard = binding_gate.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            let mut state = queue.lock().await;
            for &pending in &generated[position..] {
                if state.tasks[pending].status != AssetTaskStatus::Succeeded {
                    state.tasks[pending].status = AssetTaskStatus::Pending;
                }
            }
            state.updated_at = now_ms();
            save_queue(&project_path, &state)?;
            return Err(ASSET_QUEUE_CANCELLED.to_string());
        }
        let task = queue.lock().await.tasks[index].clone();
        let result = bind_asset(&project_path, &task);
        let mut state = queue.lock().await;
        let task = &mut state.tasks[index];
        match result {
            Ok(filename) => {
                task.status = AssetTaskStatus::Succeeded;
                task.asset_file = Some(filename);
                task.error = None;
                task.used_local_fallback = task
                    .attempts
                    .iter()
                    .rev()
                    .find(|attempt| attempt.artifact.is_some())
                    .is_some_and(|attempt| attempt.used_local_fallback);
            }
            Err(error) => {
                task.status = AssetTaskStatus::Failed;
                task.error = Some(format!("binding failed: {error}"));
            }
        }
        state.updated_at = now_ms();
        save_queue(&project_path, &state)?;
    }
    let result = queue.lock().await.clone();
    Ok(result)
}

async fn generate_task(
    project_path: &Path,
    queue: &Mutex<AssetQueue>,
    index: usize,
    attempt_limit: u32,
    generator: &dyn AssetGenerator,
) -> Result<Option<usize>, String> {
    loop {
        let (task, attempt) = {
            let mut state = queue.lock().await;
            let task = &mut state.tasks[index];
            let attempt = task.attempts.len() as u32 + 1;
            if attempt > attempt_limit {
                task.status = AssetTaskStatus::Failed;
                task.error
                    .get_or_insert_with(|| "retry limit reached".to_string());
                state.updated_at = now_ms();
                save_queue(project_path, &state)?;
                return Ok(None);
            }
            task.status = if attempt == 1 {
                AssetTaskStatus::Running
            } else {
                AssetTaskStatus::Retrying
            };
            task.error = None;
            let snapshot = task.clone();
            state.updated_at = now_ms();
            save_queue(project_path, &state)?;
            (snapshot, attempt)
        };
        let started_at = now_ms();
        let generated = generator
            .generate(&task)
            .await
            .and_then(|generated| write_artifact(project_path, &task, attempt, generated));
        match generated {
            Ok((artifact, used_local_fallback)) => {
                let mut state = queue.lock().await;
                state.tasks[index].attempts.push(AssetAttempt {
                    attempt,
                    started_at,
                    finished_at: now_ms(),
                    artifact: Some(artifact.to_string_lossy().into_owned()),
                    error: None,
                    used_local_fallback,
                });
                state.updated_at = now_ms();
                save_queue(project_path, &state)?;
                return Ok(Some(index));
            }
            Err(error) => {
                if error == ASSET_QUEUE_CANCELLED {
                    return Err(error);
                }
                let mut state = queue.lock().await;
                let task = &mut state.tasks[index];
                task.attempts.push(AssetAttempt {
                    attempt,
                    started_at,
                    finished_at: now_ms(),
                    artifact: None,
                    error: Some(error.clone()),
                    used_local_fallback: false,
                });
                task.error = Some(error);
                task.status = if attempt < attempt_limit {
                    AssetTaskStatus::Retrying
                } else {
                    AssetTaskStatus::Failed
                };
                state.updated_at = now_ms();
                save_queue(project_path, &state)?;
                if attempt >= attempt_limit {
                    return Ok(None);
                }
            }
        }
    }
}

fn write_artifact(
    project_path: &Path,
    task: &AssetTask,
    attempt: u32,
    generated: GeneratedArtifact,
) -> Result<(std::path::PathBuf, bool), String> {
    validate_extension(&generated.extension)?;
    validate_component(&task.id)?;
    let artifact = project_path
        .join(".ollaic/artifacts/assets")
        .join(&task.id)
        .join(format!("{attempt}.{}", generated.extension));
    if let Some(parent) = artifact.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create artifact directory {}: {error}",
                parent.display()
            )
        })?;
    }
    crate::json_store::write_crash_safe(&artifact, &generated.bytes)
        .map_err(|error| format!("failed to write artifact {}: {error}", artifact.display()))?;
    Ok((artifact, generated.used_local_fallback))
}

fn validate_limits(queue: &AssetQueue) -> Result<(), String> {
    if queue.limits.image == 0 || queue.limits.tts == 0 || queue.limits.music == 0 {
        return Err("asset queue concurrency limits must be greater than zero".to_string());
    }
    Ok(())
}

fn validate_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(format!("invalid asset task id: {value}"));
    }
    Ok(())
}

fn validate_extension(value: &str) -> Result<(), String> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return Err(format!("invalid generated artifact extension: {value}"));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct RetryOnce(AtomicUsize);
    struct AlwaysGenerate;
    struct TransparentFigure;
    struct AlwaysFail(AtomicUsize);
    struct CountingGenerate(AtomicUsize);
    struct MissingConfiguration(AtomicUsize);
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
    async fn asset_queue_rollback_on_cancellation_after_generation() {
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
        let queue_before = std::fs::read(queue_path(&project)).unwrap();
        let scene_before = std::fs::read(project.join("game/scene/start.txt")).unwrap();
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
        assert_eq!(std::fs::read(queue_path(&project)).unwrap(), queue_before);
        assert_eq!(
            std::fs::read(project.join("game/scene/start.txt")).unwrap(),
            scene_before
        );
        assert!(artifact.is_file(), "generated cache artifacts are retained");
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
        let run = tokio::spawn(async move {
            run_queue(&run_project, "run-command-race", &plan, generator).await
        });
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
}
