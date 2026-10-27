pub mod archive;
pub mod asset_operations;
pub mod assets;
pub mod catalog;
pub mod document;
pub mod editor;
pub mod json_store;
pub mod project;
pub mod webgal;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Project changed on disk; reopen it before saving")]
    Conflict,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
}

pub type Result<T> = std::result::Result<T, Error>;
