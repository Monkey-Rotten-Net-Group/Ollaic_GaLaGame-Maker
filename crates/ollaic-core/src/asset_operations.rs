use crate::{assets, catalog, json_store, project, webgal::references, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const JOURNAL: &str = "mobile-asset-pending.json";

#[derive(Debug, Clone)]
pub struct AssetUsage {
    pub file_name: String,
    pub line_number: u32,
    pub command: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct TextResource {
    pub source: String,
    pub revision: String,
}

#[derive(Serialize, Deserialize)]
struct TextWrite {
    name: String,
    source: String,
}

#[derive(Serialize, Deserialize)]
struct Mutation {
    category: String,
    old_name: String,
    new_name: Option<String>,
    asset_digest: String,
    writes: Vec<TextWrite>,
    #[serde(default)]
    related_assets: Vec<RelatedAsset>,
}

#[derive(Serialize, Deserialize)]
struct RelatedAsset {
    old_name: String,
    new_name: String,
    asset_digest: String,
    #[serde(default)]
    keep_old: bool,
}

fn journal_path(root: &Path) -> Result<PathBuf> {
    let directory = root.join(".ollaic");
    project::reject_symlink(&directory)?;
    fs::create_dir_all(&directory)?;
    for name in [
        JOURNAL.to_owned(),
        format!("{JOURNAL}.tmp"),
        format!("{JOURNAL}.bak"),
    ] {
        project::reject_symlink(&directory.join(name))?;
    }
    Ok(directory.join(JOURNAL))
}

fn file_digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn text_path(root: &Path, name: &str) -> Result<PathBuf> {
    if let Some(scene) = name.strip_prefix("game/scene/") {
        project::validate_file_name(scene)?;
        if !scene.ends_with(".txt") {
            return Err(Error::Invalid("Invalid transaction scene".into()));
        }
        let path = project::checked_directory(root, "game/scene")?.join(scene);
        project::reject_symlink(&path)?;
        project::reject_symlink(&path.with_file_name(format!("{scene}.tmp")))?;
        project::reject_symlink(&json_store::backup_path(&path))?;
        Ok(path)
    } else if name == "game/config.txt" {
        let path = project::checked_file(root, name)?;
        project::reject_symlink(&root.join("game/config.txt.tmp"))?;
        project::reject_symlink(&json_store::backup_path(&path))?;
        Ok(path)
    } else if name == "game/config/characters.json" {
        catalog::config_path(root, catalog::CHARACTERS)
    } else if name == "game/config/asset-metadata.json" {
        catalog::config_path(root, catalog::ASSET_METADATA)
    } else {
        Err(Error::Invalid("Invalid asset transaction path".into()))
    }
}

fn apply(root: &Path, mutation: &Mutation) -> Result<()> {
    let old = assets::asset_path(root, &mutation.category, &mutation.old_name)?;
    let new = mutation
        .new_name
        .as_ref()
        .map(|name| assets::asset_path(root, &mutation.category, name))
        .transpose()?;
    let mut moves = vec![(old, new, mutation.asset_digest.as_str(), false)];
    if mutation.new_name.is_none() && !mutation.related_assets.is_empty() {
        return Err(Error::Invalid("Invalid related asset deletion".into()));
    }
    for related in &mutation.related_assets {
        moves.push((
            assets::asset_path(root, "reference", &related.old_name)?,
            Some(assets::asset_path(root, "reference", &related.new_name)?),
            related.asset_digest.as_str(),
            related.keep_old,
        ));
    }
    for (_, _, digest, _) in &moves {
        if digest.len() != 64 || digest.bytes().any(|byte| !byte.is_ascii_hexdigit()) {
            return Err(Error::Invalid("Invalid asset transaction digest".into()));
        }
    }
    for write in &mutation.writes {
        if write.source.len() > project::MAX_SCRIPT_BYTES as usize {
            return Err(Error::Invalid(
                "Asset transaction exceeds the size limit".into(),
            ));
        }
        text_path(root, &write.name)?;
    }
    for (old, new, digest, _) in &moves {
        if let Some(new) = new {
            if old == new {
                return Err(Error::Invalid("Asset names are identical".into()));
            }
            if new.exists() {
                if file_digest(new)? != *digest {
                    return Err(Error::Conflict);
                }
            } else {
                if file_digest(old)? != *digest {
                    return Err(Error::Conflict);
                }
                // Android SELinux rejects app hard links; publish a durable copy without overwriting.
                assets::copy_noclobber(old, new)?;
            }
        }
    }
    for write in &mutation.writes {
        json_store::write_crash_safe(&text_path(root, &write.name)?, write.source.as_bytes())?;
    }
    for (old, _, digest, keep_old) in &moves {
        if !keep_old && old.exists() {
            if file_digest(old)? != *digest {
                return Err(Error::Conflict);
            }
            fs::remove_file(old)?;
            json_store::sync_parent_directory(old)?;
        }
    }
    Ok(())
}

pub(crate) fn recover(root: &Path) -> Result<()> {
    if !root.join(".ollaic").join(JOURNAL).exists() {
        return Ok(());
    }
    let path = journal_path(root)?;
    if fs::metadata(&path)?.len() > project::MAX_SCRIPT_BYTES {
        return Err(Error::Invalid(
            "Asset transaction exceeds the size limit".into(),
        ));
    }
    let mutation: Mutation = serde_json::from_str(&json_store::read_to_string_recovering(&path)?)?;
    apply(root, &mutation)?;
    fs::remove_file(path)?;
    Ok(())
}

fn commit(root: &Path, mutation: Mutation) -> Result<()> {
    for write in &mutation.writes {
        text_path(root, &write.name)?;
    }
    let bytes = serde_json::to_vec(&mutation)?;
    if bytes.len() as u64 > project::MAX_SCRIPT_BYTES {
        return Err(Error::Invalid(
            "Asset transaction exceeds the size limit".into(),
        ));
    }
    let path = journal_path(root)?;
    json_store::write_crash_safe(&path, &bytes)?;
    apply(root, &mutation)?;
    fs::remove_file(path)?;
    Ok(())
}

pub fn asset_usages(root: &Path, category: &str, name: &str) -> Result<Vec<AssetUsage>> {
    assets::validate_asset(category, name)?;
    project::with_project(root, |root| usages_unlocked(root, category, name))
}

fn title_asset_span(
    line: &str,
    category: &str,
    name: &str,
) -> Option<(&'static str, std::ops::Range<usize>)> {
    let field = match category {
        "background" => "Title_img",
        "bgm" => "Title_bgm",
        _ => return None,
    };
    if project::parse_config(line).get(field).map(String::as_str) != Some(name) {
        return None;
    }
    let colon = line.find(':')?;
    let value = &line[colon + 1..];
    let start = colon + 1 + value.len() - value.trim_start().len();
    Some((field, start..start + name.len()))
}

fn usages_unlocked(root: &Path, category: &str, name: &str) -> Result<Vec<AssetUsage>> {
    let mut usages = Vec::new();
    for scene in project::load_workspace_unlocked(root)?.document.scenes {
        for reference in references::find_asset_references_to(&scene.source, category, name) {
            usages.push(AssetUsage {
                file_name: scene.file_name.clone(),
                line_number: reference.line_number as u32,
                command: reference.command.into(),
                content: reference.line_content,
            });
        }
    }
    if matches!(category, "background" | "bgm") {
        let config = fs::read_to_string(project::checked_file(root, "game/config.txt")?)?;
        for (index, line) in config.lines().enumerate() {
            if let Some((field, _)) = title_asset_span(line, category, name) {
                usages.push(AssetUsage {
                    file_name: "game/config.txt".into(),
                    line_number: index as u32 + 1,
                    command: field.into(),
                    content: line.trim().into(),
                });
            }
        }
    }
    let (characters, _) = catalog::read_json(root, catalog::CHARACTERS)?;
    let figure_assets = if category == "figure" {
        assets::list_assets_unlocked(root)?
    } else {
        Vec::new()
    };
    for character in catalog::characters_from(&characters)? {
        let used = match category {
            "figure" => character
                .sprites
                .iter()
                .any(|sprite| catalog::resolve_sprite(&character, sprite, &figure_assets) == name),
            "vocal" => character.default_voice.as_deref() == Some(name),
            "reference" => character
                .reference_images
                .iter()
                .any(|file| format!("{}/{file}", character.id) == name),
            _ => false,
        };
        if used {
            usages.push(AssetUsage {
                file_name: "game/config/characters.json".into(),
                line_number: 0,
                command: "character".into(),
                content: character.name,
            });
        }
    }
    let (metadata, _) = catalog::read_json(root, catalog::ASSET_METADATA)?;
    if category == "reference" {
        if let Some(entries) = metadata.get("references").and_then(Value::as_object) {
            for (owner, values) in entries {
                if let Some(values) = values.as_array() {
                    if values
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|file| reference_matches(owner, file, name))
                    {
                        usages.push(AssetUsage {
                            file_name: "game/config/asset-metadata.json".into(),
                            line_number: 0,
                            command: "references".into(),
                            content: owner.clone(),
                        });
                    }
                }
            }
        }
    }
    for field in ["sceneCards", "cgCards", "voiceCards"] {
        if let Some(cards) = metadata.get(field).and_then(Value::as_object) {
            for (id, card) in cards {
                let Some(key) = card_asset_field(category, field) else {
                    continue;
                };
                if card
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| value == name || value == format!("{category}/{name}"))
                {
                    usages.push(AssetUsage {
                        file_name: "game/config/asset-metadata.json".into(),
                        line_number: 0,
                        command: field.into(),
                        content: id.clone(),
                    });
                }
            }
        }
    }
    Ok(usages)
}

pub fn rename_asset(
    root: &Path,
    category: &str,
    old_name: &str,
    new_name: &str,
    expected_revision: &str,
) -> Result<()> {
    assets::validate_asset(category, old_name)?;
    assets::validate_asset(category, new_name)?;
    if old_name.eq_ignore_ascii_case(new_name) {
        return Err(Error::Invalid("Choose a different asset name".into()));
    }
    project::with_project(root, |root| {
        let workspace = project::load_workspace_unlocked(root)?;
        if workspace.revision != expected_revision {
            return Err(Error::Conflict);
        }
        let old = assets::asset_path(root, category, old_name)?;
        let new = assets::asset_path(root, category, new_name)?;
        if new.exists() {
            return Err(Error::Invalid(
                "An asset with this name already exists".into(),
            ));
        }
        let all_assets = assets::list_assets_unlocked(root)?;
        let keep_legacy = all_assets.iter().any(|asset| {
            asset.category != category && asset.category != "reference" && asset.name == old_name
        });
        let mut writes = Vec::new();
        for scene in workspace.document.scenes {
            let (source, changed) =
                references::rename_asset_references(&scene.source, category, old_name, new_name);
            if changed > 0 {
                writes.push(TextWrite {
                    name: format!("game/scene/{}", scene.file_name),
                    source,
                });
            }
        }
        if matches!(category, "background" | "bgm") {
            let config = fs::read_to_string(project::checked_file(root, "game/config.txt")?)?;
            let source: String = config
                .split_inclusive('\n')
                .map(|line| match title_asset_span(line, category, old_name) {
                    Some((_, span)) => {
                        format!("{}{new_name}{}", &line[..span.start], &line[span.end..])
                    }
                    None => line.to_owned(),
                })
                .collect();
            if source != config {
                writes.push(TextWrite {
                    name: "game/config.txt".into(),
                    source,
                });
            }
        }
        let (mut characters, _) = catalog::read_json(root, catalog::CHARACTERS)?;
        let previous = characters.clone();
        let parsed_characters = catalog::characters_from(&characters)?;
        let figure_assets = if category == "figure" {
            assets::list_assets_unlocked(root)?
        } else {
            Vec::new()
        };
        if let Some(entries) = characters
            .get_mut("characters")
            .and_then(Value::as_array_mut)
        {
            for character in entries {
                let parsed = parsed_characters.iter().find(|entry| {
                    character.get("id").and_then(Value::as_str) == Some(entry.id.as_str())
                });
                if category == "figure" {
                    if let Some(sprites) =
                        character.get_mut("sprites").and_then(Value::as_array_mut)
                    {
                        for (index, sprite) in sprites.iter_mut().enumerate() {
                            let resolved = parsed.and_then(|character| {
                                character.sprites.get(index).map(|sprite| {
                                    catalog::resolve_sprite(character, sprite, &figure_assets)
                                })
                            });
                            if sprite.get("file").and_then(Value::as_str) == Some(old_name)
                                || resolved.as_deref() == Some(old_name)
                            {
                                sprite["file"] = new_name.into();
                            }
                        }
                    }
                }
                if category == "vocal"
                    && character.get("defaultVoice").and_then(Value::as_str) == Some(old_name)
                {
                    character["defaultVoice"] = new_name.into();
                }
                if category == "reference" {
                    let id = character
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if let Some(files) = character
                        .get_mut("referenceImages")
                        .and_then(Value::as_array_mut)
                    {
                        for file in files {
                            if file
                                .as_str()
                                .is_some_and(|file| format!("{id}/{file}") == old_name)
                            {
                                let prefix = format!("{id}/");
                                let tail = new_name
                                    .strip_prefix(&prefix)
                                    .filter(|tail| !tail.contains('/'))
                                    .ok_or_else(|| {
                                        Error::Invalid(
                                            "Keep reference images in their character directory"
                                                .into(),
                                        )
                                    })?;
                                *file = tail.into();
                            }
                        }
                    }
                }
            }
        }
        if characters != previous {
            writes.push(TextWrite {
                name: "game/config/characters.json".into(),
                source: serde_json::to_string_pretty(&characters)?,
            });
        }
        let (mut metadata, _) = catalog::read_json(root, catalog::ASSET_METADATA)?;
        let old_key = format!("{category}/{old_name}");
        let new_key = format!("{category}/{new_name}");
        if category == "reference" {
            if let Some(entries) = metadata
                .get_mut("references")
                .and_then(Value::as_object_mut)
            {
                for (owner, values) in entries {
                    if let Some(values) = values.as_array_mut() {
                        for value in values {
                            if let Some(file) = value.as_str() {
                                if reference_matches(owner, file, old_name) {
                                    let prefixes = reference_prefixes(owner);
                                    let replacement = if let Some(prefix) = prefixes
                                        .iter()
                                        .find(|prefix| format!("{prefix}{file}") == old_name)
                                    {
                                        new_name.strip_prefix(prefix).filter(|tail| !tail.contains('/')).ok_or_else(|| Error::Invalid("Keep reference assets in their owner directory".into()))?.to_owned()
                                    } else if file == old_name {
                                        new_name.to_owned()
                                    } else {
                                        format!("reference/{new_name}")
                                    };
                                    *value = replacement.into();
                                }
                            }
                        }
                    }
                }
            }
        }
        move_metadata(
            &mut metadata,
            category,
            old_name,
            new_name,
            false,
            keep_legacy,
        )?;
        let mut related_assets = Vec::new();
        if let (Some(old_prefix), Some(new_prefix)) = (
            assets::reference_prefix(category, old_name),
            assets::reference_prefix(category, new_name),
        ) {
            let keep_old = all_assets.iter().any(|asset| {
                asset.category != category
                    && assets::reference_prefix(&asset.category, &asset.name).as_ref()
                        == Some(&old_prefix)
            }) || metadata
                .get("references")
                .and_then(Value::as_object)
                .is_some_and(|entries| {
                    entries
                        .keys()
                        .any(|owner| reference_prefixes(owner).contains(&old_prefix))
                });
            for asset in all_assets.into_iter().filter(|asset| {
                asset.category == "reference" && asset.name.starts_with(&old_prefix)
            }) {
                let new_reference = format!("{new_prefix}{}", &asset.name[old_prefix.len()..]);
                if assets::asset_path(root, "reference", &new_reference)?.exists() {
                    return Err(Error::Invalid(
                        "A reference asset with this name already exists".into(),
                    ));
                }
                related_assets.push(RelatedAsset {
                    asset_digest: file_digest(&assets::asset_path(
                        root,
                        "reference",
                        &asset.name,
                    )?)?,
                    old_name: asset.name.clone(),
                    new_name: new_reference.clone(),
                    keep_old,
                });
                move_metadata(
                    &mut metadata,
                    "reference",
                    &asset.name,
                    &new_reference,
                    keep_old,
                    false,
                )?;
            }
        }
        for field in ["sceneCards", "cgCards", "voiceCards"] {
            if let Some(cards) = metadata.get_mut(field).and_then(Value::as_object_mut) {
                for card in cards.values_mut() {
                    let Some(key) = card_asset_field(category, field) else {
                        continue;
                    };
                    if let Some(value) = card.get_mut(key) {
                        if value.as_str() == Some(old_name) {
                            *value = new_name.into();
                        } else if value.as_str() == Some(old_key.as_str()) {
                            *value = new_key.clone().into();
                        }
                    }
                    let old_stem = Path::new(old_name)
                        .with_extension("")
                        .to_string_lossy()
                        .into_owned();
                    if card.get("targetStem").and_then(Value::as_str) == Some(old_stem.as_str()) {
                        card["targetStem"] = Path::new(new_name)
                            .with_extension("")
                            .to_string_lossy()
                            .into_owned()
                            .into();
                    }
                }
            }
        }
        writes.push(TextWrite {
            name: "game/config/asset-metadata.json".into(),
            source: serde_json::to_string_pretty(&metadata)?,
        });
        commit(
            root,
            Mutation {
                category: category.into(),
                old_name: old_name.into(),
                new_name: Some(new_name.into()),
                asset_digest: file_digest(&old)?,
                writes,
                related_assets,
            },
        )
    })
}

pub fn delete_asset(
    root: &Path,
    category: &str,
    name: &str,
    expected_revision: &str,
) -> Result<()> {
    assets::validate_asset(category, name)?;
    project::with_project(root, |root| {
        if project::load_workspace_unlocked(root)?.revision != expected_revision {
            return Err(Error::Conflict);
        }
        if !usages_unlocked(root, category, name)?.is_empty() {
            return Err(Error::Invalid(
                "Asset is still referenced; remove its usages before deleting it".into(),
            ));
        }
        let path = assets::asset_path(root, category, name)?;
        let (mut metadata, _) = catalog::read_json(root, catalog::ASSET_METADATA)?;
        let keep_legacy = assets::list_assets_unlocked(root)?.iter().any(|asset| {
            asset.category != category && asset.category != "reference" && asset.name == name
        });
        for field in ["aliases", "descriptions", "tags", "references"] {
            if let Some(map) = metadata.get_mut(field).and_then(Value::as_object_mut) {
                map.remove(&format!("{category}/{name}"));
                if category != "reference" && !keep_legacy {
                    map.remove(name);
                }
            }
        }
        commit(
            root,
            Mutation {
                category: category.into(),
                old_name: name.into(),
                new_name: None,
                related_assets: Vec::new(),
                asset_digest: file_digest(&path)?,
                writes: vec![TextWrite {
                    name: "game/config/asset-metadata.json".into(),
                    source: serde_json::to_string_pretty(&metadata)?,
                }],
            },
        )
    })
}

fn reference_prefixes(owner: &str) -> Vec<String> {
    if let Some((category, name)) = owner.split_once('/') {
        if let Some(prefix) = assets::reference_prefix(category, name) {
            return vec![prefix];
        }
    }
    ["background", "bgm"]
        .into_iter()
        .filter_map(|category| assets::reference_prefix(category, owner))
        .collect()
}

fn card_asset_field(category: &str, collection: &str) -> Option<&'static str> {
    match (category, collection) {
        ("background", "sceneCards" | "cgCards") => Some("imageAsset"),
        ("vocal", "voiceCards") => Some("voiceAsset"),
        _ => None,
    }
}

fn reference_matches(owner: &str, file: &str, name: &str) -> bool {
    file == name
        || file == format!("reference/{name}")
        || reference_prefixes(owner)
            .iter()
            .any(|prefix| format!("{prefix}{file}") == name)
}

fn move_metadata(
    metadata: &mut Value,
    category: &str,
    old: &str,
    new: &str,
    keep_original: bool,
    keep_legacy: bool,
) -> Result<()> {
    let old_key = format!("{category}/{old}");
    let new_key = format!("{category}/{new}");
    for field in ["aliases", "descriptions", "tags", "references"] {
        if let Some(map) = metadata.get_mut(field).and_then(Value::as_object_mut) {
            let canonical = map.contains_key(&old_key);
            if let Some(value) = map.get(&old_key).cloned().or_else(|| {
                if category != "reference" {
                    map.get(old).cloned()
                } else {
                    None
                }
            }) {
                if map.get(&new_key).is_some_and(|existing| existing != &value) {
                    return Err(Error::Invalid(
                        "Target asset metadata already exists".into(),
                    ));
                }
                if !keep_original && (canonical || !keep_legacy) {
                    map.remove(if canonical { old_key.as_str() } else { old });
                }
                map.insert(new_key.clone(), value);
            }
        }
    }
    Ok(())
}

pub fn read_animation(root: &Path, name: &str) -> Result<TextResource> {
    project::with_project(root, |root| {
        let path = assets::asset_path(root, "animation", name)?;
        if fs::metadata(&path)?.len() > 4 * 1024 * 1024 {
            return Err(Error::Invalid("Animation exceeds the 4 MiB limit".into()));
        }
        let source = fs::read_to_string(path)?;
        Ok(TextResource {
            revision: catalog::digest(source.as_bytes()),
            source,
        })
    })
}

pub fn save_animation(
    root: &Path,
    name: &str,
    source: &str,
    expected_revision: &str,
) -> Result<TextResource> {
    if !name.to_ascii_lowercase().ends_with(".json") || source.len() > 4 * 1024 * 1024 {
        return Err(Error::Invalid(
            "Animation must be a JSON file within 4 MiB".into(),
        ));
    }
    let value: Value = serde_json::from_str(source)?;
    if !value.is_array() && !value.is_object() {
        return Err(Error::Invalid(
            "Animation must contain JSON frames or an object".into(),
        ));
    }
    project::with_project(root, |root| {
        let path = assets::asset_path(root, "animation", name)?;
        if path.exists() {
            if fs::metadata(&path)?.len() > 4 * 1024 * 1024 {
                return Err(Error::Conflict);
            }
            let current = fs::read(&path)?;
            let revision = catalog::digest(&current);
            if current == source.as_bytes() {
                return Ok(TextResource {
                    source: source.into(),
                    revision,
                });
            }
            if revision != expected_revision {
                return Err(Error::Conflict);
            }
        } else if !expected_revision.is_empty() {
            return Err(Error::Conflict);
        }
        project::reject_symlink(&path.with_file_name(format!(
            "{}.tmp",
            path.file_name().unwrap().to_string_lossy()
        )))?;
        project::reject_symlink(&json_store::backup_path(&path))?;
        json_store::write_crash_safe(&path, source.as_bytes())?;
        Ok(TextResource {
            source: source.into(),
            revision: catalog::digest(source.as_bytes()),
        })
    })
}
