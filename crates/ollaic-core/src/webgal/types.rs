use serde::{Deserialize, Serialize};

/// WebGAL command types — mirrors the frontend WebGalCommandType.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CommandType {
    Dialogue,
    Narrator,
    Intro,
    Choose,
    ChangeBg,
    ChangeFigure,
    MiniAvatar,
    ChangeScene,
    CallScene,
    End,
    Bgm,
    PlayEffect,
    PlayVideo,
    Label,
    JumpLabel,
    SetVar,
    SetTextbox,
    GetUserInput,
    SetAnimation,
    SetTransform,
    UnlockCg,
    UnlockBgm,
    Comment,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FigurePosition {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flag {
    pub key: String,
    /// `true` for boolean flags (-next), string for value flags (-volume=30).
    pub value: FlagValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum FlagValue {
    Bool(bool),
    Str(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChoiceBranch {
    pub text: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// A single node in the visual editor, corresponding to one WebGAL script line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebGalNode {
    pub id: String,
    #[serde(rename = "type")]
    pub cmd_type: CommandType,

    // Core
    pub content: String,
    pub flags: Vec<Flag>,

    // Type-specific (all optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub figure_position: Option<FigurePosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub figure_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub figure_character: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub figure_emotion: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<ChoiceBranch>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_scene: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_name: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub var_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub var_value: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_button: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub intro_lines: Option<Vec<String>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation_target: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<i32>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,

    // Common flags (lifted for convenience)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,

    // Visual layout
    pub position: Position,
    pub connections: Vec<String>,
}

impl WebGalNode {
    pub fn new(id: String, cmd_type: CommandType, content: String) -> Self {
        Self {
            id,
            cmd_type,
            content,
            flags: Vec::new(),
            character: None,
            voice: None,
            asset: None,
            figure_position: None,
            figure_id: None,
            figure_character: None,
            figure_emotion: None,
            choices: None,
            target_scene: None,
            label_name: None,
            var_name: None,
            var_value: None,
            input_title: None,
            input_button: None,
            intro_lines: None,
            animation_name: None,
            animation_target: None,
            volume: None,
            display_name: None,
            next: None,
            when: None,
            position: Position { x: 0.0, y: 0.0 },
            connections: Vec::new(),
        }
    }
}
