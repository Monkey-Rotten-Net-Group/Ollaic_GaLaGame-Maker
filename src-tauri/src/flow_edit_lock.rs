use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum FlowResource {
    Characters,
    StoryPlan,
}

impl FlowResource {
    fn label(self) -> &'static str {
        match self {
            Self::Characters => "角色资料",
            Self::StoryPlan => "故事计划",
        }
    }
}

type LockKey = (PathBuf, FlowResource);

fn active_locks() -> &'static Mutex<HashMap<LockKey, usize>> {
    static LOCKS: OnceLock<Mutex<HashMap<LockKey, usize>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn project_key(project_path: &Path) -> PathBuf {
    project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_path_buf())
}

pub(crate) struct FlowEditGuard {
    project: PathBuf,
    resources: Vec<FlowResource>,
}

impl FlowEditGuard {
    pub(crate) fn acquire(project_path: &Path, resources: &[FlowResource]) -> Result<Self, String> {
        crate::project_lock::with_project_lock(project_path, || {
            let project = project_key(project_path);
            let mut locks = active_locks()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for resource in resources {
                *locks.entry((project.clone(), *resource)).or_default() += 1;
            }
            Ok(Self {
                project,
                resources: resources.to_vec(),
            })
        })
    }
}

impl Drop for FlowEditGuard {
    fn drop(&mut self) {
        let mut locks = active_locks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for resource in &self.resources {
            let key = (self.project.clone(), *resource);
            if let Some(count) = locks.get_mut(&key) {
                *count -= 1;
                if *count == 0 {
                    locks.remove(&key);
                }
            }
        }
    }
}

pub(crate) fn ensure_editable(project_path: &Path, resource: FlowResource) -> Result<(), String> {
    let key = (project_key(project_path), resource);
    let locks = active_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if locks.contains_key(&key) {
        Err(format!(
            "Agent Flow 正在使用{}，暂时无法保存修改。请等待当前步骤结束或先停止流程。",
            resource.label()
        ))
    } else {
        Ok(())
    }
}
