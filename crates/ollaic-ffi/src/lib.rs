use ollaic_core::{archive, assets, document, project};
use std::path::Path;
mod catalog;
mod editor;
pub use catalog::*;
pub use editor::*;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CoreError {
    #[error("{reason}")]
    Failure { reason: String },
}

impl From<ollaic_core::Error> for CoreError {
    fn from(error: ollaic_core::Error) -> Self {
        Self::Failure {
            reason: error.to_string(),
        }
    }
}

#[derive(uniffi::Record)]
pub struct ProjectSummary {
    pub path: String,
    pub name: String,
    pub description: String,
    pub scenes: Vec<String>,
}

fn summary(info: project::ProjectInfo) -> Result<ProjectSummary, CoreError> {
    Ok(ProjectSummary {
        description: project::project_description(Path::new(&info.path))?,
        name: info.config.get("Game_name").cloned().unwrap_or_default(),
        path: info.path,
        scenes: info.scenes,
    })
}

#[derive(uniffi::Record)]
pub struct SceneSource {
    pub file_name: String,
    pub source: String,
}

#[derive(uniffi::Record)]
pub struct WorkspaceSnapshot {
    pub scenes: Vec<SceneSource>,
    pub notes: String,
    pub editor_state: String,
    pub revision: String,
}

#[derive(uniffi::Record)]
pub struct ScriptLine {
    pub source: String,
    pub kind: String,
    pub speaker: String,
    pub text: String,
    pub command: String,
    pub preview: String,
}

#[derive(uniffi::Record)]
pub struct ExportReport {
    pub output_path: String,
    pub warnings: Vec<String>,
}

#[derive(uniffi::Record)]
pub struct AssetInfo {
    pub category: String,
    pub name: String,
    pub size: u64,
    pub alias: String,
}

#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

#[uniffi::export]
pub fn create_project(path: String, name: String) -> Result<ProjectSummary, CoreError> {
    summary(project::create_project(Path::new(&path), &name)?)
}

#[uniffi::export]
pub fn open_project(path: String) -> Result<ProjectSummary, CoreError> {
    summary(project::open_project(Path::new(&path))?)
}

#[uniffi::export]
pub fn update_project_metadata(
    path: String,
    name: String,
    description: String,
) -> Result<(), CoreError> {
    Ok(project::update_metadata(
        Path::new(&path),
        &name,
        &description,
    )?)
}

#[uniffi::export]
pub fn import_project(
    archive_path: String,
    target_path: String,
) -> Result<ProjectSummary, CoreError> {
    summary(archive::import_project(
        Path::new(&archive_path),
        Path::new(&target_path),
    )?)
}

#[uniffi::export]
pub fn export_project(path: String, archive_path: String) -> Result<ExportReport, CoreError> {
    let warnings = archive::export_project(Path::new(&path), Path::new(&archive_path))?;
    Ok(ExportReport {
        output_path: archive_path,
        warnings,
    })
}

#[uniffi::export]
pub fn load_workspace(path: String) -> Result<WorkspaceSnapshot, CoreError> {
    let snapshot = project::load_workspace(Path::new(&path))?;
    Ok(WorkspaceSnapshot {
        scenes: snapshot
            .document
            .scenes
            .into_iter()
            .map(|scene| SceneSource {
                file_name: scene.file_name,
                source: scene.source,
            })
            .collect(),
        notes: snapshot.document.notes,
        editor_state: snapshot.document.editor_state,
        revision: snapshot.revision,
    })
}

#[uniffi::export]
pub fn save_workspace(
    path: String,
    scenes: Vec<SceneSource>,
    notes: String,
    editor_state: String,
    expected_revision: String,
) -> Result<String, CoreError> {
    Ok(project::save_workspace(
        Path::new(&path),
        project::WorkspaceDocument {
            scenes: scenes
                .into_iter()
                .map(|scene| project::SceneSource {
                    file_name: scene.file_name,
                    source: scene.source,
                })
                .collect(),
            notes,
            editor_state,
        },
        &expected_revision,
    )?)
}

#[uniffi::export]
pub fn decode_lines(source: String) -> Vec<ScriptLine> {
    document::decode_lines(&source)
        .into_iter()
        .map(|line| ScriptLine {
            source: line.source,
            kind: line.kind,
            speaker: line.speaker,
            text: line.text,
            command: line.command,
            preview: line.preview,
        })
        .collect()
}

#[uniffi::export]
pub fn edit_line(
    original: String,
    kind: String,
    speaker: String,
    text: String,
) -> Result<String, CoreError> {
    Ok(document::edit_line(&original, &kind, &speaker, &text)?)
}

#[uniffi::export]
pub fn assemble_lines(lines: Vec<String>) -> String {
    document::assemble_lines(&lines)
}

#[uniffi::export]
pub fn scene_file_name(name: String) -> Result<String, CoreError> {
    Ok(project::scene_file_name(&name)?)
}

#[uniffi::export]
pub fn rename_scene_references(source: String, old_name: String, new_name: String) -> String {
    document::rename_scene_references(&source, &old_name, &new_name)
}

#[uniffi::export]
pub fn list_assets(path: String) -> Result<Vec<AssetInfo>, CoreError> {
    Ok(assets::list_assets(Path::new(&path))?
        .into_iter()
        .map(|asset| AssetInfo {
            category: asset.category,
            name: asset.name,
            size: asset.size,
            alias: asset.alias,
        })
        .collect())
}

#[uniffi::export]
pub fn asset_command(category: String, name: String) -> Result<String, CoreError> {
    Ok(assets::asset_command(&category, &name)?)
}

#[uniffi::export]
pub fn import_asset(
    path: String,
    source_path: String,
    category: String,
    name: String,
) -> Result<AssetInfo, CoreError> {
    let asset = assets::import_asset(Path::new(&path), Path::new(&source_path), &category, &name)?;
    Ok(AssetInfo {
        category: asset.category,
        name: asset.name,
        size: asset.size,
        alias: asset.alias,
    })
}
