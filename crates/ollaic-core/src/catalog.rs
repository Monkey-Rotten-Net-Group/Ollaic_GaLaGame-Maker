use crate::{json_store, project, Error, Result};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub const CHARACTERS: &str = "characters.json";
pub const ASSET_METADATA: &str = "asset-metadata.json";
const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CharacterSprite {
    pub emotion: String,
    pub file: String,
    pub prompt: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CharacterRelation {
    pub target_id: String,
    pub relation_type: String,
    pub description: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Character {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub personality: String,
    pub reference_images: Vec<String>,
    pub stance: String,
    pub keywords: Vec<String>,
    pub dialogue_style: String,
    pub gender: String,
    #[serde(deserialize_with = "text_or_number")]
    pub age: String,
    pub sprites: Vec<CharacterSprite>,
    pub default_voice: Option<String>,
    pub voice_timbre: Option<String>,
    pub relations: Vec<CharacterRelation>,
    pub color_theme: Option<String>,
    pub notes: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn text_or_number<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::String(value) => Ok(value),
        Value::Number(value) => Ok(value.to_string()),
        Value::Null => Ok(String::new()),
        _ => Err(serde::de::Error::custom("Expected text or number")),
    }
}

#[derive(Debug, Clone)]
pub struct CharactersSnapshot {
    pub characters: Vec<Character>,
    pub revision: String,
}

pub fn resolve_sprite(
    character: &Character,
    sprite: &CharacterSprite,
    assets: &[crate::assets::AssetInfo],
) -> String {
    if !sprite.file.is_empty() {
        return sprite.file.clone();
    }
    fn token(value: &str, fallback: &str) -> String {
        let value: String = value
            .trim()
            .chars()
            .map(|character| {
                if character.is_whitespace() || "\\/:*?\"<>|".contains(character) {
                    '_'
                } else {
                    character
                }
            })
            .collect();
        let value = value
            .split('_')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("_");
        if value.is_empty() {
            fallback.into()
        } else {
            value
        }
    }
    let prefix = format!(
        "{}_{}_",
        token(
            if character.name.is_empty() {
                &character.id
            } else {
                &character.name
            },
            "character"
        ),
        token(&sprite.emotion, "sprite")
    );
    let emotion = token(&sprite.emotion, "").to_lowercase();
    assets
        .iter()
        .filter(|asset| asset.category == "figure")
        .filter(|asset| {
            let tail = asset.name.rsplit('/').next().unwrap_or_default();
            if tail.starts_with(&prefix) {
                return true;
            }
            let stem = tail.rsplit_once('.').map_or(tail, |(stem, _)| stem);
            let stem = token(stem, "").to_lowercase();
            if emotion.is_empty() || !stem.contains(&emotion) {
                return false;
            }
            asset.name.starts_with(&format!("{}/", character.id))
                || std::iter::once(&character.id)
                    .chain(std::iter::once(&character.name))
                    .chain(character.aliases.iter())
                    .map(|value| token(value, "").to_lowercase())
                    .any(|name| !name.is_empty() && stem.contains(&name))
        })
        .max_by_key(|asset| asset.name.rsplit('/').next().unwrap_or_default())
        .map(|asset| asset.name.clone())
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
pub struct AssetDetails {
    pub alias: String,
    pub description: String,
    pub tags: Vec<String>,
    pub references: Vec<String>,
    pub revision: String,
}

pub(crate) fn config_path(root: &Path, name: &str) -> Result<PathBuf> {
    project::validate_file_name(name)?;
    let game = project::checked_directory(root, "game")?;
    let directory = game.join("config");
    project::reject_symlink(&directory)?;
    fs::create_dir_all(&directory)?;
    let path = directory.join(name);
    project::reject_symlink(&path)?;
    project::reject_symlink(&json_store::backup_path(&path))?;
    project::reject_symlink(&directory.join(format!("{name}.tmp")))?;
    Ok(path)
}

pub(crate) fn read_json(root: &Path, name: &str) -> Result<(Value, String)> {
    let path = config_path(root, name)?;
    if !path.exists() && !json_store::backup_path(&path).exists() {
        return Ok((serde_json::json!({}), digest(&[])));
    }
    for candidate in [&path, &json_store::backup_path(&path)] {
        if candidate.exists() && fs::metadata(candidate)?.len() > MAX_BYTES {
            return Err(Error::Invalid("Catalog exceeds the 4 MiB limit".into()));
        }
    }
    let source = json_store::read_to_string_recovering(&path)?;
    let value: Value = serde_json::from_str(&source)?;
    if !value.is_object() {
        return Err(Error::Invalid("Invalid project catalog".into()));
    }
    Ok((value, digest(source.as_bytes())))
}

pub(crate) fn write_json(root: &Path, name: &str, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Error::Invalid("Catalog exceeds the 4 MiB limit".into()));
    }
    Ok(json_store::write_crash_safe(
        &config_path(root, name)?,
        &bytes,
    )?)
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn characters_from(value: &Value) -> Result<Vec<Character>> {
    if value
        .get("version")
        .is_some_and(|version| version.as_u64() != Some(1))
    {
        return Err(Error::Invalid(
            "Unsupported character catalog version".into(),
        ));
    }
    let entries = value
        .get("characters")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let mut characters: Vec<Character> = serde_json::from_value(entries)?;
    let mut seen = HashSet::new();
    characters.reverse();
    characters.retain(|character| seen.insert(character.id.clone()));
    characters.reverse();
    Ok(characters)
}

pub fn load_characters(root: &Path) -> Result<CharactersSnapshot> {
    project::with_project(root, |root| {
        let (value, revision) = read_json(root, CHARACTERS)?;
        Ok(CharactersSnapshot {
            characters: characters_from(&value)?,
            revision,
        })
    })
}

pub fn save_character(
    root: &Path,
    mut character: Character,
    expected_revision: &str,
) -> Result<CharactersSnapshot> {
    project::with_project(root, |root| {
        let (mut value, revision) = read_json(root, CHARACTERS)?;
        if revision != expected_revision {
            return Err(Error::Conflict);
        }
        let mut characters = characters_from(&value)?;
        if character.name.trim().is_empty() || character.name.contains(['\r', '\n']) {
            return Err(Error::Invalid(
                "A character requires a name on one line".into(),
            ));
        }
        if serde_json::from_value::<Character>(serde_json::to_value(&character)?)? != character {
            return Err(Error::Invalid(
                "Extension fields cannot replace character properties".into(),
            ));
        }
        if character.id.is_empty() {
            character.id = format!(
                "char_{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
        } else if !characters.iter().any(|entry| entry.id == character.id) {
            return Err(Error::Invalid("Character no longer exists".into()));
        }
        project::validate_file_name(&character.id)?;
        if characters
            .iter()
            .any(|entry| entry.id != character.id && entry.name.trim() == character.name.trim())
        {
            return Err(Error::Invalid("Character name already exists".into()));
        }
        for sprite in &character.sprites {
            if sprite.emotion.trim().is_empty() {
                return Err(Error::Invalid("Sprite emotion cannot be empty".into()));
            }
            if !sprite.file.is_empty() {
                crate::assets::validate_asset_name(&sprite.file)?;
            }
        }
        if let Some(voice) = character
            .default_voice
            .as_ref()
            .filter(|voice| !voice.is_empty())
        {
            crate::assets::validate_asset_name(voice)?;
        }
        if character.reference_images.len() > 5 {
            return Err(Error::Invalid(
                "A character can have at most five reference images".into(),
            ));
        }
        for file in &character.reference_images {
            project::validate_file_name(file)?;
        }
        for relation in &character.relations {
            if relation.target_id == character.id
                || !characters
                    .iter()
                    .any(|entry| entry.id == relation.target_id)
            {
                return Err(Error::Invalid("Invalid character relation target".into()));
            }
        }
        if let Some(index) = characters.iter().position(|entry| entry.id == character.id) {
            characters[index] = character;
        } else {
            characters.push(character);
        }
        value["version"] = 1.into();
        value["characters"] = serde_json::to_value(&characters)?;
        write_json(root, CHARACTERS, &value)?;
        let (_, revision) = read_json(root, CHARACTERS)?;
        Ok(CharactersSnapshot {
            characters,
            revision,
        })
    })
}

pub fn delete_character(
    root: &Path,
    id: &str,
    expected_revision: &str,
) -> Result<CharactersSnapshot> {
    project::with_project(root, |root| {
        let (mut value, revision) = read_json(root, CHARACTERS)?;
        if revision != expected_revision {
            return Err(Error::Conflict);
        }
        let mut characters = characters_from(&value)?;
        if !characters.iter().any(|entry| entry.id == id) {
            return Err(Error::Invalid("Character no longer exists".into()));
        }
        characters.retain(|entry| entry.id != id);
        for character in &mut characters {
            character
                .relations
                .retain(|relation| relation.target_id != id);
        }
        value["characters"] = serde_json::to_value(&characters)?;
        write_json(root, CHARACTERS, &value)?;
        let (_, revision) = read_json(root, CHARACTERS)?;
        Ok(CharactersSnapshot {
            characters,
            revision,
        })
    })
}

pub fn asset_details(root: &Path, category: &str, name: &str) -> Result<AssetDetails> {
    crate::assets::validate_asset(category, name)?;
    project::with_project(root, |root| {
        let (value, revision) = read_json(root, ASSET_METADATA)?;
        let key = format!("{category}/{name}");
        let entry = |field: &str| {
            value.get(field).and_then(|map| {
                map.get(&key).or_else(|| {
                    if category != "reference" {
                        map.get(name)
                    } else {
                        None
                    }
                })
            })
        };
        Ok(AssetDetails {
            alias: entry("aliases")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            description: entry("descriptions")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            tags: entry("tags")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()?
                .unwrap_or_default(),
            references: entry("references")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()?
                .unwrap_or_default(),
            revision,
        })
    })
}

pub fn save_asset_details(
    root: &Path,
    category: &str,
    name: &str,
    details: AssetDetails,
) -> Result<()> {
    crate::assets::validate_asset(category, name)?;
    project::with_project(root, |root| {
        let (mut value, revision) = read_json(root, ASSET_METADATA)?;
        if revision != details.revision {
            return Err(Error::Conflict);
        }
        let key = format!("{category}/{name}");
        for (field, entry) in [
            ("aliases", Value::String(details.alias)),
            ("descriptions", Value::String(details.description)),
            ("tags", serde_json::to_value(details.tags)?),
            ("references", serde_json::to_value(details.references)?),
        ] {
            if value.get(field).is_none() {
                value[field] = serde_json::json!({});
            }
            let map = value[field]
                .as_object_mut()
                .ok_or_else(|| Error::Invalid("Invalid asset metadata map".into()))?;
            map.insert(key.clone(), entry);
        }
        write_json(root, ASSET_METADATA, &value)
    })
}
