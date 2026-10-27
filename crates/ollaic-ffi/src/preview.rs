use crate::CoreError;
use std::path::Path;
use std::sync::{Arc, Mutex};

fn failure(reason: impl Into<String>) -> CoreError {
    CoreError::Failure {
        reason: reason.into(),
    }
}

#[derive(uniffi::Record)]
pub struct PreviewEngineInfo {
    pub installed: bool,
    pub version: Option<String>,
}

#[uniffi::export]
pub fn preview_engine_version() -> String {
    ollaic_runtime::engine_version().to_owned()
}

#[uniffi::export]
pub fn preview_engine_info(path: String) -> Result<PreviewEngineInfo, CoreError> {
    let info = ollaic_runtime::engine::installed_info(Path::new(&path)).map_err(failure)?;
    Ok(PreviewEngineInfo {
        installed: info.installed,
        version: info.version,
    })
}

#[uniffi::export]
pub fn install_preview_engine(
    archive_path: String,
    target_path: String,
) -> Result<PreviewEngineInfo, CoreError> {
    let info =
        ollaic_runtime::engine::install_archive(Path::new(&archive_path), Path::new(&target_path))
            .map_err(failure)?;
    Ok(PreviewEngineInfo {
        installed: info.installed,
        version: info.version,
    })
}

#[derive(uniffi::Object)]
pub struct NativePreviewSession {
    inner: Mutex<Option<ollaic_runtime::session::PreviewSession>>,
    url: String,
}

#[uniffi::export]
pub fn start_preview_session(
    engine_path: String,
    project_path: String,
) -> Result<Arc<NativePreviewSession>, CoreError> {
    let inner = ollaic_runtime::session::PreviewSession::start(
        Path::new(&engine_path),
        Path::new(&project_path),
    )
    .map_err(failure)?;
    let url = inner.url();
    Ok(Arc::new(NativePreviewSession {
        inner: Mutex::new(Some(inner)),
        url,
    }))
}

#[uniffi::export]
impl NativePreviewSession {
    pub fn url(&self) -> String {
        self.url.clone()
    }
    pub fn is_ready(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .is_some_and(|inner| inner.as_ref().is_some_and(|session| session.is_ready()))
    }
    pub fn begin(&self) -> Result<(), CoreError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| failure("Preview session is unavailable"))?;
        inner
            .as_ref()
            .ok_or_else(|| failure("Preview session is closed"))?
            .begin()
            .map_err(failure)
    }
    pub fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.take();
        }
    }
}
