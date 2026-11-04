use crate::{engine, server::RuntimeServer};
use std::path::Path;
use tokio::runtime::{Builder, Runtime};

pub struct PreviewSession {
    server: RuntimeServer,
    runtime: Option<Runtime>,
}

impl PreviewSession {
    pub fn start(engine_dir: &Path, project_dir: &Path) -> Result<Self, String> {
        engine::installed_info(engine_dir)?;
        engine::validate(engine_dir)?;
        let runtime = Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|error| format!("Start preview worker: {error}"))?;
        let server = runtime
            .block_on(RuntimeServer::start_preview(
                engine_dir.into(),
                project_dir.into(),
            ))
            .map_err(|error| format!("Start preview service: {error}"))?;
        Ok(Self {
            server,
            runtime: Some(runtime),
        })
    }

    pub fn url(&self) -> String {
        self.server.preview_url()
    }
    pub fn is_ready(&self) -> bool {
        self.server.is_ready()
    }

    pub fn close(&mut self) {
        self.server.stop();
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(std::time::Duration::from_secs(2));
        }
    }
}

impl Drop for PreviewSession {
    fn drop(&mut self) {
        self.close();
    }
}
