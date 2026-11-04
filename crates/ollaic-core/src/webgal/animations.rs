use super::resource_paths;
use crate::{assets, Error, Result};

pub const TABLE_FILE: &str = "animationTable.json";

// WebGAL 4.6.0's default registry remains available when the first custom animation is added.
pub const DEFAULT_NAMES: &[&str] = &[
    "enter-from-left",
    "enter-from-bottom",
    "enter-from-right",
    "shake",
    "move-front-and-back",
    "enter",
    "exit",
    "blur",
    "oldFilm",
    "dotFilm",
    "reflectionFilm",
    "glitchFilm",
    "rgbFilm",
    "godrayFilm",
    "removeFilm",
    "shockwaveIn",
    "shockwaveOut",
];

pub fn name(file_name: &str) -> String {
    resource_paths::encode(decoded_name(file_name))
}

pub fn decoded_name(file_name: &str) -> &str {
    file_name.strip_suffix(".json").unwrap_or(file_name)
}

pub fn file_name(encoded_name: &str) -> String {
    format!("{}.json", resource_paths::decode(encoded_name))
}

pub fn validate_file(file_name: &str) -> Result<()> {
    assets::validate_asset("animation", file_name)?;
    if !file_name.ends_with(".json") || file_name == ".json" {
        return Err(Error::Invalid(
            "Animation files must use the .json extension".into(),
        ));
    }
    Ok(())
}
