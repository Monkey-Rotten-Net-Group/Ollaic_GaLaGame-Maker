use serde::{Deserialize, Serialize};

/// A single sprite/expression variation for a character.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSprite {
    /// Emotion label, e.g. "default", "happy", "sad", "angry", "surprised".
    pub emotion: String,
    /// Filename relative to game/figure/, e.g. "girl_happy.webp".
    pub file: String,
}

/// A directional relation to another character.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRelation {
    /// Target character id.
    pub target_id: String,
    /// Relation type in Chinese, e.g. "哥哥", "朋友", "敌人".
    pub relation_type: String,
    /// Optional detail.
    #[serde(default)]
    pub description: String,
}

/// A character in the visual novel project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    /// Primary name used in script dialogue lines.
    pub name: String,
    /// Alternative names / nicknames.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Backstory / role description.
    #[serde(default)]
    pub description: String,
    /// Personality traits.
    #[serde(default)]
    pub personality: String,
    /// Stable image-generation prompt prefix for visual consistency.
    #[serde(default)]
    pub consistency_prompt: Option<String>,
    /// Uploaded subject reference images stored in game/config/references/{characterId}/.
    #[serde(default)]
    pub reference_images: Vec<String>,
    /// Moral / faction stance: e.g. "正义", "混沌", "中立", "邪恶".
    #[serde(default)]
    pub stance: String,
    /// Searchable keywords / tags (e.g. ["学生", "学生会", "傲娇"]).
    #[serde(default)]
    pub keywords: Vec<String>,
    /// Dialogue style guide for character voice consistency (AI use).
    #[serde(default)]
    pub dialogue_style: String,
    /// Gender: e.g. "男", "女", "其他".
    #[serde(default)]
    pub gender: String,
    /// Age group or specific age as free text.
    #[serde(default)]
    pub age: String,
    /// Emotion → figure file mappings.
    #[serde(default)]
    pub sprites: Vec<CharacterSprite>,
    /// Default voice file path (relative to game/vocal/).
    #[serde(default)]
    pub default_voice: Option<String>,
    /// TTS voice type identifier (for future use).
    #[serde(default)]
    pub voice_timbre: Option<String>,
    /// Relations to other characters.
    #[serde(default)]
    pub relations: Vec<CharacterRelation>,
    /// Display accent color (CSS-compatible string).
    #[serde(default)]
    pub color_theme: Option<String>,
    /// Free-form notes.
    #[serde(default)]
    pub notes: String,
}

/// Lightweight reference for dropdowns / lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRef {
    pub id: String,
    pub name: String,
}

/// Top-level characters.json document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharactersDocument {
    pub version: u32,
    #[serde(default)]
    pub characters: Vec<Character>,
}

impl Default for CharactersDocument {
    fn default() -> Self {
        Self {
            version: 1,
            characters: Vec::new(),
        }
    }
}
