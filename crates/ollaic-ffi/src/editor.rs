use crate::CoreError;
use ollaic_core::editor;

macro_rules! command_kinds {
    ($($kind:ident),+ $(,)?) => {
        #[derive(Clone, Copy, uniffi::Enum)]
        pub enum CommandKind { $($kind),+ }
        impl From<CommandKind> for editor::EditKind {
            fn from(value: CommandKind) -> Self { match value { $(CommandKind::$kind => Self::$kind),+ } }
        }
        impl From<editor::EditKind> for CommandKind {
            fn from(value: editor::EditKind) -> Self { match value { $(editor::EditKind::$kind => Self::$kind),+ } }
        }
    };
}
command_kinds! {
    Dialogue, Narrator, Comment, Intro, Choose, ChangeScene, CallScene, End,
    Label, JumpLabel, SetVar, GetUserInput, SetTextbox, SetTransform,
    ChangeBg, ChangeFigure, MiniAvatar, Bgm, PlayEffect, PlayVideo, SetAnimation, UnlockCg, UnlockBgm,
}

#[derive(uniffi::Record)]
pub struct CommandChoice {
    pub text: String,
    pub target: String,
}

macro_rules! command_record {
    ($($field:ident: $type:ty),+ $(,)?) => {
        #[derive(uniffi::Record)]
        pub struct CommandEdit {
            pub kind: CommandKind,
            pub choices: Vec<CommandChoice>,
            $(pub $field: $type),+
        }
        impl From<editor::CommandEdit> for CommandEdit {
            fn from(value: editor::CommandEdit) -> Self {
                Self { kind: value.kind.into(), choices: value.choices.into_iter()
                    .map(|choice| CommandChoice { text: choice.text, target: choice.target }).collect(),
                    $($field: value.$field),+ }
            }
        }
        impl From<CommandEdit> for editor::CommandEdit {
            fn from(value: CommandEdit) -> Self {
                Self { kind: value.kind.into(), choices: value.choices.into_iter()
                    .map(|choice| editor::EditChoice { text: choice.text, target: choice.target }).collect(),
                    $($field: value.$field),+ }
            }
        }
    };
}
command_record! {
    content: String, speaker: String, scene: String, label: String,
    variable: String, value: String, title: String, button: String,
    intro_lines: Vec<String>, target: String, next: bool, when: String,
    asset: String, voice: String, figure_position: String, figure_id: String,
    figure_character: String, figure_emotion: String, volume: Option<i32>, display_name: String,
}

#[uniffi::export]
pub fn new_command(kind: CommandKind) -> CommandEdit {
    editor::new_command(kind.into()).into()
}

#[uniffi::export]
pub fn read_command(source: String) -> Result<CommandEdit, CoreError> {
    Ok(editor::read_command(&source)?.into())
}

#[uniffi::export]
pub fn edit_command(original: String, edit: CommandEdit) -> Result<String, CoreError> {
    Ok(editor::edit_command(&original, &edit.into())?)
}
