use crate::CoreError;
use ollaic_core::{asset_operations, catalog};
use std::path::Path;

#[uniffi::export]
pub fn asset_reference_prefix(category: String, name: String) -> Result<String, CoreError> {
    ollaic_core::assets::validate_asset(&category, &name)?;
    Ok(ollaic_core::assets::reference_prefix(&category, &name).unwrap_or_default())
}

fn extensions(source: &str) -> Result<serde_json::Map<String, serde_json::Value>, CoreError> {
    serde_json::from_str(source).map_err(|error| CoreError::from(ollaic_core::Error::from(error)))
}

macro_rules! extension_record {
    ($name:ident, $core:ty, {$($field:ident: $type:ty),+ $(,)?}) => {
        #[derive(uniffi::Record)]
        pub struct $name { $(pub $field: $type,)+ pub extra_json: String }
        impl From<$core> for $name {
            fn from(value: $core) -> Self { Self { $($field: value.$field,)+ extra_json: serde_json::Value::Object(value.extra).to_string() } }
        }
        impl TryFrom<$name> for $core {
            type Error = CoreError;
            fn try_from(value: $name) -> Result<Self, CoreError> { Ok(Self { $($field: value.$field,)+ extra: extensions(&value.extra_json)? }) }
        }
    };
}

extension_record!(CharacterSprite, catalog::CharacterSprite, {emotion: String, file: String, prompt: Option<String>});
extension_record!(CharacterRelation, catalog::CharacterRelation, {target_id: String, relation_type: String, description: String});

macro_rules! character_record {
    ($($field:ident: $type:ty),+ $(,)?) => {
        #[derive(uniffi::Record)]
        pub struct CharacterInfo { $(pub $field: $type,)+ pub sprites: Vec<CharacterSprite>, pub relations: Vec<CharacterRelation>, pub extra_json: String }
        impl From<catalog::Character> for CharacterInfo {
            fn from(value: catalog::Character) -> Self {
                Self { $($field: value.$field,)+ sprites: value.sprites.into_iter().map(Into::into).collect(),
                    relations: value.relations.into_iter().map(Into::into).collect(), extra_json: serde_json::Value::Object(value.extra).to_string() }
            }
        }
        impl TryFrom<CharacterInfo> for catalog::Character {
            type Error = CoreError;
            fn try_from(value: CharacterInfo) -> Result<Self, CoreError> {
                Ok(Self { $($field: value.$field,)+ sprites: value.sprites.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
                    relations: value.relations.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?, extra: extensions(&value.extra_json)? })
            }
        }
    };
}
character_record! {
    id: String, name: String, aliases: Vec<String>, description: String, personality: String,
    reference_images: Vec<String>, stance: String, keywords: Vec<String>, dialogue_style: String,
    gender: String, age: String, default_voice: Option<String>, voice_timbre: Option<String>, color_theme: Option<String>, notes: String,
}

#[derive(uniffi::Record)]
pub struct CharactersSnapshot {
    pub characters: Vec<CharacterInfo>,
    pub revision: String,
}
impl From<catalog::CharactersSnapshot> for CharactersSnapshot {
    fn from(value: catalog::CharactersSnapshot) -> Self {
        Self {
            characters: value.characters.into_iter().map(Into::into).collect(),
            revision: value.revision,
        }
    }
}

#[derive(uniffi::Record)]
pub struct AssetDetails {
    pub alias: String,
    pub description: String,
    pub tags: Vec<String>,
    pub references: Vec<String>,
    pub revision: String,
}
impl From<catalog::AssetDetails> for AssetDetails {
    fn from(value: catalog::AssetDetails) -> Self {
        Self {
            alias: value.alias,
            description: value.description,
            tags: value.tags,
            references: value.references,
            revision: value.revision,
        }
    }
}

#[derive(uniffi::Record)]
pub struct AssetUsage {
    pub file_name: String,
    pub line_number: u32,
    pub command: String,
    pub content: String,
}
#[derive(uniffi::Record)]
pub struct TextResource {
    pub source: String,
    pub revision: String,
}
impl From<asset_operations::TextResource> for TextResource {
    fn from(value: asset_operations::TextResource) -> Self {
        Self {
            source: value.source,
            revision: value.revision,
        }
    }
}

#[uniffi::export]
pub fn new_character() -> CharacterInfo {
    catalog::Character::default().into()
}

#[uniffi::export]
pub fn encode_character(character: CharacterInfo) -> Result<String, CoreError> {
    serde_json::to_string(&catalog::Character::try_from(character)?)
        .map_err(|error| ollaic_core::Error::from(error).into())
}

#[uniffi::export]
pub fn decode_character(source: String) -> Result<CharacterInfo, CoreError> {
    let character: catalog::Character =
        serde_json::from_str(&source).map_err(ollaic_core::Error::from)?;
    Ok(character.into())
}

#[uniffi::export]
pub fn resolve_sprite(
    character: CharacterInfo,
    sprite: CharacterSprite,
    assets: Vec<crate::AssetInfo>,
) -> Result<String, CoreError> {
    let assets = assets
        .into_iter()
        .map(|asset| ollaic_core::assets::AssetInfo {
            category: asset.category,
            name: asset.name,
            size: asset.size,
            alias: asset.alias,
        })
        .collect::<Vec<_>>();
    Ok(catalog::resolve_sprite(
        &character.try_into()?,
        &sprite.try_into()?,
        &assets,
    ))
}
#[uniffi::export]
pub fn load_characters(path: String) -> Result<CharactersSnapshot, CoreError> {
    Ok(catalog::load_characters(Path::new(&path))?.into())
}
#[uniffi::export]
pub fn save_character(
    path: String,
    character: CharacterInfo,
    expected_revision: String,
) -> Result<CharactersSnapshot, CoreError> {
    Ok(
        catalog::save_character(Path::new(&path), character.try_into()?, &expected_revision)?
            .into(),
    )
}
#[uniffi::export]
pub fn delete_character(
    path: String,
    id: String,
    expected_revision: String,
) -> Result<CharactersSnapshot, CoreError> {
    Ok(catalog::delete_character(Path::new(&path), &id, &expected_revision)?.into())
}
#[uniffi::export]
pub fn asset_details(
    path: String,
    category: String,
    name: String,
) -> Result<AssetDetails, CoreError> {
    Ok(catalog::asset_details(Path::new(&path), &category, &name)?.into())
}
#[uniffi::export]
pub fn save_asset_details(
    path: String,
    category: String,
    name: String,
    details: AssetDetails,
) -> Result<(), CoreError> {
    Ok(catalog::save_asset_details(
        Path::new(&path),
        &category,
        &name,
        catalog::AssetDetails {
            alias: details.alias,
            description: details.description,
            tags: details.tags,
            references: details.references,
            revision: details.revision,
        },
    )?)
}
#[uniffi::export]
pub fn asset_usages(
    path: String,
    category: String,
    name: String,
) -> Result<Vec<AssetUsage>, CoreError> {
    Ok(
        asset_operations::asset_usages(Path::new(&path), &category, &name)?
            .into_iter()
            .map(|usage| AssetUsage {
                file_name: usage.file_name,
                line_number: usage.line_number,
                command: usage.command,
                content: usage.content,
            })
            .collect(),
    )
}
#[uniffi::export]
pub fn rename_asset(
    path: String,
    category: String,
    old_name: String,
    new_name: String,
    expected_revision: String,
) -> Result<(), CoreError> {
    Ok(asset_operations::rename_asset(
        Path::new(&path),
        &category,
        &old_name,
        &new_name,
        &expected_revision,
    )?)
}
#[uniffi::export]
pub fn delete_asset(
    path: String,
    category: String,
    name: String,
    expected_revision: String,
) -> Result<(), CoreError> {
    Ok(asset_operations::delete_asset(
        Path::new(&path),
        &category,
        &name,
        &expected_revision,
    )?)
}
#[uniffi::export]
pub fn read_animation(path: String, name: String) -> Result<TextResource, CoreError> {
    Ok(asset_operations::read_animation(Path::new(&path), &name)?.into())
}
#[uniffi::export]
pub fn save_animation(
    path: String,
    name: String,
    source: String,
    expected_revision: String,
) -> Result<TextResource, CoreError> {
    Ok(
        asset_operations::save_animation(Path::new(&path), &name, &source, &expected_revision)?
            .into(),
    )
}
