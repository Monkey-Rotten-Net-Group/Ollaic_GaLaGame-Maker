use crate::{project, Error, Result};
use std::{fs, path::Path};

#[derive(Debug, Clone)]
pub struct AssetInfo {
    pub category: String,
    pub name: String,
    pub size: u64,
    pub alias: String,
}

pub const CATEGORIES: &[&str] = &[
    "background",
    "figure",
    "bgm",
    "vocal",
    "video",
    "animation",
    "tex",
    "reference",
];

pub fn validate_asset_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.contains('\\')
        || name
            .split('/')
            .any(|part| part.is_empty() || project::validate_file_name(part).is_err())
    {
        return Err(Error::Invalid("Invalid asset path".into()));
    }
    Ok(())
}

pub fn validate_asset(category: &str, name: &str) -> Result<()> {
    if !CATEGORIES.contains(&category) {
        return Err(Error::Invalid("Unsupported asset category".into()));
    }
    if category == "animation" && name == crate::webgal::animations::TABLE_FILE {
        return Err(Error::Invalid(
            "The animation registry is managed automatically".into(),
        ));
    }
    validate_asset_name(name)
}

pub fn reference_prefix(category: &str, name: &str) -> Option<String> {
    match category {
        "background" => Some(format!("backgrounds/{name}/")),
        "bgm" | "vocal" => Some(format!("audio/{name}/")),
        _ => None,
    }
}

pub(crate) fn asset_path(root: &Path, category: &str, name: &str) -> Result<std::path::PathBuf> {
    validate_asset(category, name)?;
    let mut directory = project::checked_directory(root, "game")?;
    directory.push(category);
    project::reject_symlink(&directory)?;
    fs::create_dir_all(&directory)?;
    let parts: Vec<_> = name.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        directory.push(part);
        project::reject_symlink(&directory)?;
        fs::create_dir_all(&directory)?;
    }
    let path = directory.join(parts.last().unwrap());
    project::reject_symlink(&path)?;
    Ok(path)
}

pub fn asset_command(category: &str, name: &str) -> Result<String> {
    let command = match category {
        "background" => "changeBg",
        "figure" => "changeFigure",
        "bgm" => "bgm",
        "vocal" => "playEffect",
        "video" => "playVideo",
        "animation" => "setAnimation",
        _ => {
            return Err(Error::Invalid(
                "This asset category has no direct script command".into(),
            ))
        }
    };
    for component in Path::new(name).components() {
        let std::path::Component::Normal(value) = component else {
            return Err(Error::Invalid("Invalid asset path".into()));
        };
        project::validate_file_name(
            value
                .to_str()
                .ok_or_else(|| Error::Invalid("Invalid asset file name".into()))?,
        )?;
    }
    if name.is_empty() {
        return Err(Error::Invalid("Asset name is empty".into()));
    }
    Ok(format!(
        "{command}:{};\n",
        if category == "animation" {
            crate::webgal::animations::validate_file(name)?;
            crate::webgal::animations::name(name)
        } else {
            crate::webgal::resource_paths::encode(name)
        }
    ))
}

pub fn list_assets(root: &Path) -> Result<Vec<AssetInfo>> {
    project::with_project(root, list_assets_unlocked)
}

pub(crate) fn list_assets_unlocked(root: &Path) -> Result<Vec<AssetInfo>> {
    let game = project::checked_directory(root, "game")?;
    let mut assets = Vec::new();
    for category in CATEGORIES {
        let directory = game.join(category);
        project::reject_symlink(&directory)?;
        if directory.is_dir() {
            list_category(&directory, Path::new(""), category, &mut assets)?;
        }
    }
    assets.sort_by(|a, b| (&a.category, &a.name).cmp(&(&b.category, &b.name)));
    let (metadata, _) = crate::catalog::read_json(root, crate::catalog::ASSET_METADATA)?;
    for asset in &mut assets {
        asset.alias = metadata
            .get("aliases")
            .and_then(|aliases| {
                aliases
                    .get(format!("{}/{}", asset.category, asset.name))
                    .or_else(|| {
                        if asset.category != "reference" {
                            aliases.get(&asset.name)
                        } else {
                            None
                        }
                    })
            })
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
    }
    Ok(assets)
}

fn list_category(
    directory: &Path,
    relative: &Path,
    category: &str,
    assets: &mut Vec<AssetInfo>,
) -> Result<()> {
    for entry in fs::read_dir(directory.join(relative))? {
        let entry = entry?;
        project::reject_symlink(&entry.path())?;
        let name = relative.join(entry.file_name());
        if category == "animation" && name == Path::new(crate::webgal::animations::TABLE_FILE) {
            continue;
        }
        if entry.path().is_dir() {
            list_category(directory, &name, category, assets)?;
        } else {
            if assets.len() >= crate::archive::MAX_ARCHIVE_ENTRIES {
                return Err(Error::Invalid("Too many assets".into()));
            }
            assets.push(AssetInfo {
                category: category.into(),
                name: name
                    .to_str()
                    .ok_or_else(|| Error::Invalid("Asset name is not UTF-8".into()))?
                    .replace('\\', "/"),
                size: entry.metadata()?.len(),
                alias: String::new(),
            });
        }
    }
    Ok(())
}

pub fn import_asset(root: &Path, source: &Path, category: &str, name: &str) -> Result<AssetInfo> {
    validate_asset(category, name)?;
    project::reject_symlink(source)?;
    if fs::metadata(source)?.len() > crate::archive::MAX_ARCHIVE_BYTES {
        return Err(Error::Invalid("Asset exceeds the 512 MiB limit".into()));
    }
    if category == "animation" {
        return crate::asset_operations::import_animation(root, source, name);
    }
    project::with_project(root, |root| {
        let target = asset_path(root, category, name)?;
        copy_noclobber(source, &target)?;
        Ok(AssetInfo {
            category: category.into(),
            name: name.into(),
            size: fs::metadata(target)?.len(),
            alias: String::new(),
        })
    })
}

pub(crate) fn copy_noclobber(source: &Path, target: &Path) -> Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(target.parent().unwrap())?;
    std::io::copy(&mut fs::File::open(source)?, temporary.as_file_mut())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(target)
        .map_err(|error| error.error)?;
    crate::json_store::sync_parent_directory(target)?;
    Ok(())
}
