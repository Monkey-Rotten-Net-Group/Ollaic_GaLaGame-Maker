//! Structured edits keep opaque parameters and untouched source slices verbatim.
use crate::document::{decode_lines, escape_literal, unescape_literal};
use crate::webgal::parser::{delimiter_positions, flag_ranges, parse_script};
use crate::webgal::serializer::serialize_script;
use crate::webgal::types::{ChoiceBranch, CommandType, FigurePosition, WebGalNode};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EditKind {
    Dialogue,
    Narrator,
    Comment,
    Intro,
    Choose,
    ChangeScene,
    CallScene,
    End,
    Label,
    JumpLabel,
    SetVar,
    GetUserInput,
    SetTextbox,
    SetTransform,
    ChangeBg,
    ChangeFigure,
    MiniAvatar,
    Bgm,
    PlayEffect,
    PlayVideo,
    SetAnimation,
    UnlockCg,
    UnlockBgm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditChoice {
    pub text: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandEdit {
    pub kind: EditKind,
    pub content: String,
    pub speaker: String,
    pub choices: Vec<EditChoice>,
    pub scene: String,
    pub label: String,
    pub variable: String,
    pub value: String,
    pub title: String,
    pub button: String,
    pub intro_lines: Vec<String>,
    pub target: String,
    pub next: bool,
    pub when: String,
    pub asset: String,
    pub voice: String,
    pub figure_position: String,
    pub figure_id: String,
    pub figure_character: String,
    pub figure_emotion: String,
    pub volume: Option<i32>,
    pub display_name: String,
}

pub fn new_command(kind: EditKind) -> CommandEdit {
    CommandEdit {
        kind,
        content: match kind {
            EditKind::SetTextbox => "show",
            EditKind::SetTransform => "{}",
            _ => "",
        }
        .into(),
        speaker: String::new(),
        choices: Vec::new(),
        scene: String::new(),
        label: String::new(),
        variable: String::new(),
        value: String::new(),
        title: String::new(),
        button: String::new(),
        intro_lines: Vec::new(),
        target: String::new(),
        next: false,
        when: String::new(),
        asset: match kind {
            EditKind::ChangeBg
            | EditKind::ChangeFigure
            | EditKind::MiniAvatar
            | EditKind::Bgm
            | EditKind::PlayEffect
            | EditKind::PlayVideo => "none",
            _ => "",
        }
        .into(),
        voice: String::new(),
        figure_position: if kind == EditKind::ChangeFigure {
            "center".into()
        } else {
            String::new()
        },
        figure_id: String::new(),
        figure_character: String::new(),
        figure_emotion: String::new(),
        volume: None,
        display_name: String::new(),
    }
}

pub fn read_command(source: &str) -> Result<CommandEdit> {
    if decode_lines(source).len() != 1
        || source.trim_end_matches(['\r', '\n']).contains(['\r', '\n'])
    {
        return Err(Error::Invalid(
            "Structured editing requires one script statement".into(),
        ));
    }
    let node = parse_script(source)
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("Empty script statement".into()))?;
    let kind = match node.cmd_type {
        CommandType::Dialogue => EditKind::Dialogue,
        CommandType::Narrator => EditKind::Narrator,
        CommandType::Comment => EditKind::Comment,
        CommandType::Intro => EditKind::Intro,
        CommandType::Choose => EditKind::Choose,
        CommandType::ChangeScene => EditKind::ChangeScene,
        CommandType::CallScene => EditKind::CallScene,
        CommandType::End => EditKind::End,
        CommandType::Label => EditKind::Label,
        CommandType::JumpLabel => EditKind::JumpLabel,
        CommandType::SetVar => EditKind::SetVar,
        CommandType::GetUserInput => EditKind::GetUserInput,
        CommandType::SetTextbox => EditKind::SetTextbox,
        CommandType::SetTransform => EditKind::SetTransform,
        CommandType::ChangeBg => EditKind::ChangeBg,
        CommandType::ChangeFigure => EditKind::ChangeFigure,
        CommandType::MiniAvatar => EditKind::MiniAvatar,
        CommandType::Bgm => EditKind::Bgm,
        CommandType::PlayEffect => EditKind::PlayEffect,
        CommandType::PlayVideo => EditKind::PlayVideo,
        CommandType::SetAnimation => EditKind::SetAnimation,
        CommandType::UnlockCg => EditKind::UnlockCg,
        CommandType::UnlockBgm => EditKind::UnlockBgm,
    };
    Ok(CommandEdit {
        kind,
        content: match kind {
            EditKind::Comment => node.content,
            EditKind::SetTransform => node.content.replace("\\;", ";"),
            EditKind::Dialogue | EditKind::Narrator | EditKind::SetTextbox => {
                unescape_literal(&node.content)
            }
            _ => String::new(),
        },
        speaker: unescape_literal(&node.character.unwrap_or_default()),
        choices: node
            .choices
            .unwrap_or_default()
            .into_iter()
            .map(|choice| EditChoice {
                text: unescape_literal(&choice.text),
                target: unescape_literal(&choice.target),
            })
            .collect(),
        scene: unescape_literal(&node.target_scene.unwrap_or_default()),
        label: unescape_literal(&node.label_name.unwrap_or_default()),
        variable: unescape_literal(&node.var_name.unwrap_or_default()),
        value: unescape_literal(&node.var_value.unwrap_or_default()),
        title: unescape_literal(&node.input_title.unwrap_or_default()),
        button: unescape_literal(&node.input_button.unwrap_or_default()),
        intro_lines: node
            .intro_lines
            .unwrap_or_default()
            .iter()
            .map(|line| unescape_literal(line))
            .collect(),
        target: unescape_literal(
            &node
                .flags
                .iter()
                .find(|flag| flag.key == "target")
                .and_then(|flag| match &flag.value {
                    crate::webgal::types::FlagValue::Str(value) => Some(value.clone()),
                    _ => None,
                })
                .unwrap_or_default(),
        ),
        next: node.next.unwrap_or(false),
        when: unescape_literal(&node.when.unwrap_or_default()),
        asset: unescape_literal(&node.asset.or(node.animation_name).unwrap_or_default()),
        voice: unescape_literal(&node.voice.unwrap_or_default()),
        figure_position: node
            .figure_position
            .map(|position| {
                match position {
                    FigurePosition::Left => "left",
                    FigurePosition::Center => "center",
                    FigurePosition::Right => "right",
                }
                .into()
            })
            .unwrap_or_default(),
        figure_id: unescape_literal(&node.figure_id.unwrap_or_default()),
        figure_character: unescape_literal(&node.figure_character.unwrap_or_default()),
        figure_emotion: unescape_literal(&node.figure_emotion.unwrap_or_default()),
        volume: node.volume,
        display_name: unescape_literal(&node.display_name.unwrap_or_default()),
    })
}

fn invalid(reason: &str) -> Error {
    Error::Invalid(reason.into())
}

fn validate(edit: &CommandEdit) -> Result<()> {
    use EditKind::*;
    if matches!(edit.kind, Dialogue | Narrator | Comment) && edit.content.contains('\r') {
        return Err(invalid("Use line feeds between text paragraphs"));
    }
    let required = match edit.kind {
        Dialogue | Narrator | Comment => !edit.content.trim().is_empty(),
        Intro => {
            !edit.intro_lines.is_empty()
                && edit.intro_lines.iter().any(|line| !line.trim().is_empty())
        }
        Choose => {
            !edit.choices.is_empty()
                && edit
                    .choices
                    .iter()
                    .all(|choice| !choice.text.trim().is_empty())
        }
        ChangeScene | CallScene => !edit.scene.trim().is_empty(),
        Label | JumpLabel => !edit.label.trim().is_empty(),
        SetVar => !edit.variable.trim().is_empty() && !edit.value.trim().is_empty(),
        GetUserInput => !edit.variable.trim().is_empty(),
        SetTextbox => matches!(edit.content.as_str(), "show" | "hide"),
        SetTransform => serde_json::from_str::<serde_json::Value>(&edit.content)
            .is_ok_and(|value| value.is_object()),
        End => true,
        ChangeBg | ChangeFigure | MiniAvatar | Bgm | PlayEffect | PlayVideo | SetAnimation
        | UnlockCg | UnlockBgm => !edit.asset.trim().is_empty(),
    };
    if !required {
        return Err(invalid("Required command fields are missing or invalid"));
    }
    let mut single_lines = vec![
        &edit.speaker,
        &edit.scene,
        &edit.label,
        &edit.variable,
        &edit.value,
        &edit.title,
        &edit.button,
        &edit.target,
        &edit.when,
        &edit.asset,
        &edit.voice,
        &edit.figure_id,
        &edit.figure_character,
        &edit.figure_emotion,
        &edit.display_name,
    ];
    single_lines.extend(edit.intro_lines.iter());
    for choice in &edit.choices {
        single_lines.extend([&choice.text, &choice.target]);
    }
    if single_lines
        .iter()
        .any(|value| value.contains(['\r', '\n']))
    {
        return Err(invalid("Command parameters must fit on one line"));
    }
    if matches!(edit.kind, SetVar | GetUserInput)
        && (edit.variable.contains(['=', ' ', '\t']) || edit.variable.starts_with('-'))
    {
        return Err(invalid("Invalid variable name"));
    }
    if edit
        .volume
        .is_some_and(|volume| !(0..=100).contains(&volume))
    {
        return Err(invalid("Volume must be between 0 and 100"));
    }
    if edit.kind == ChangeFigure
        && !matches!(edit.figure_position.as_str(), "left" | "center" | "right")
    {
        return Err(invalid("Invalid figure position"));
    }
    Ok(())
}

fn body(edit: &CommandEdit) -> String {
    use EditKind::*;
    let cmd_type = match edit.kind {
        Dialogue => CommandType::Dialogue,
        Narrator => CommandType::Narrator,
        Comment => CommandType::Comment,
        Intro => CommandType::Intro,
        Choose => CommandType::Choose,
        ChangeScene => CommandType::ChangeScene,
        CallScene => CommandType::CallScene,
        End => CommandType::End,
        Label => CommandType::Label,
        JumpLabel => CommandType::JumpLabel,
        SetVar => CommandType::SetVar,
        GetUserInput => CommandType::GetUserInput,
        SetTextbox => CommandType::SetTextbox,
        SetTransform => CommandType::SetTransform,
        ChangeBg => CommandType::ChangeBg,
        ChangeFigure => CommandType::ChangeFigure,
        MiniAvatar => CommandType::MiniAvatar,
        Bgm => CommandType::Bgm,
        PlayEffect => CommandType::PlayEffect,
        PlayVideo => CommandType::PlayVideo,
        SetAnimation => CommandType::SetAnimation,
        UnlockCg => CommandType::UnlockCg,
        UnlockBgm => CommandType::UnlockBgm,
    };
    let mut node = WebGalNode::new(
        "1".into(),
        cmd_type,
        match edit.kind {
            Comment => edit.content.clone(),
            SetTransform => serde_json::from_str::<serde_json::Value>(&edit.content)
                .map(|value| value.to_string())
                .unwrap_or_else(|_| edit.content.clone())
                .replace(';', "\\;"),
            _ => escape_literal(&edit.content),
        },
    );
    node.character = Some(escape_literal(&edit.speaker));
    node.target_scene = Some(escape_literal(&edit.scene));
    node.label_name = Some(escape_literal(&edit.label));
    node.var_name = Some(escape_literal(&edit.variable));
    node.var_value = Some(escape_literal(&edit.value));
    node.asset = Some(escape_literal(&edit.asset));
    node.animation_name = Some(escape_literal(&edit.asset));
    node.intro_lines = Some(
        edit.intro_lines
            .iter()
            .map(|line| escape_literal(line))
            .collect(),
    );
    node.choices = Some(
        edit.choices
            .iter()
            .map(|choice| ChoiceBranch {
                text: escape_literal(&choice.text),
                target: escape_literal(&choice.target),
            })
            .collect(),
    );
    let rendered = serialize_script(&[node]);
    let rendered = rendered.trim_end_matches(['\r', '\n']);
    if edit.kind == Comment {
        rendered.to_owned()
    } else {
        rendered.strip_suffix(';').unwrap_or(rendered).to_owned()
    }
}

/// Only changed fields are rewritten; source-only commands must use edit_line instead.
pub fn edit_command(original: &str, edit: &CommandEdit) -> Result<String> {
    let before = if original.is_empty() {
        None
    } else {
        Some(read_command(original)?)
    };
    if before.as_ref() == Some(edit) {
        return Ok(original.to_owned());
    }
    validate(edit)?;
    if matches!(
        edit.kind,
        EditKind::Dialogue | EditKind::Narrator | EditKind::Comment
    ) && edit.content.contains('\n')
    {
        let last = edit.content.split('\n').count() - 1;
        let lines: Result<Vec<_>> = edit
            .content
            .split('\n')
            .enumerate()
            .map(|(index, line)| {
                if line.is_empty() {
                    return Ok(String::new());
                }
                let mut part = edit.clone();
                part.content = line.to_owned();
                let template = if index != last && edit.kind != EditKind::Comment {
                    delimiter_positions(original, ';')
                        .next()
                        .map(|end| &original[..end + 1])
                        .unwrap_or(original)
                } else {
                    original
                };
                edit_command(template, &part)
                    .map(|source| source.trim_end_matches(['\r', '\n']).to_owned())
            })
            .collect();
        let separator = if original.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        return Ok(format!("{}{separator}", lines?.join(separator)));
    }
    let line = original.trim_end_matches(['\r', '\n']);
    let leading = &line[..line.len() - line.trim_start().len()];
    if edit.kind == EditKind::Comment {
        let newline = ending(original);
        return Ok(format!("{leading}; {}{newline}", edit.content));
    }
    let is_comment = before
        .as_ref()
        .is_some_and(|value| value.kind == EditKind::Comment);
    let end = if is_comment {
        line.len()
    } else {
        delimiter_positions(line, ';').next().unwrap_or(line.len())
    };
    let statement = if is_comment { "" } else { &line[..end] };
    let ranges = flag_ranges(statement);
    let content_end = ranges.first().map_or(statement.len(), |range| range.start);
    let old_body = statement[..content_end].trim_end();
    let rendered = body(edit);
    let main = if before
        .as_ref()
        .is_some_and(|old| old.kind == edit.kind && body(old) == rendered)
    {
        old_body.to_owned()
    } else {
        format!("{leading}{rendered}")
    };
    let old_fields = before.as_ref().map(managed_fields).unwrap_or_default();
    let replacements: Vec<_> = managed_fields(edit)
        .into_iter()
        .filter(|(key, value)| {
            old_fields
                .iter()
                .find(|(old_key, _)| old_key == key)
                .and_then(|(_, old)| old.as_ref())
                != value.as_ref()
        })
        .collect();
    let voice_changed = before.as_ref().map(voice_value) != Some(voice_value(edit));
    let mut flags = statement[old_body.len()..content_end].to_owned();
    for range in ranges {
        let token = &statement[range];
        let key = token
            .trim_start_matches('-')
            .split(['=', ' ', '\t'])
            .next()
            .unwrap_or_default();
        if !(replacements.iter().any(|(managed, _)| *managed == key)
            || voice_changed && crate::webgal::parser::is_voice_flag(key))
        {
            flags.push_str(token);
        }
    }
    for (_, value) in replacements {
        if let Some(value) = value {
            if !flags.ends_with(char::is_whitespace) {
                flags.push(' ');
            }
            flags.push_str(&value);
        }
    }
    if voice_changed {
        if let Some(voice) = voice_value(edit) {
            if !flags.ends_with(char::is_whitespace) {
                flags.push(' ');
            }
            flags.push_str(&voice);
        }
    }
    let suffix = if is_comment { "" } else { &line[end..] };
    let terminator = if suffix.starts_with(';') { suffix } else { ";" };
    Ok(format!("{main}{flags}{terminator}{}", ending(original)))
}

fn voice_value(edit: &CommandEdit) -> Option<String> {
    matches!(edit.kind, EditKind::Dialogue | EditKind::Narrator)
        .then(|| flag("vocal", &edit.voice))
        .flatten()
}

fn managed_fields(edit: &CommandEdit) -> Vec<(&'static str, Option<String>)> {
    use EditKind::*;
    let input = edit.kind == GetUserInput;
    let figure = edit.kind == ChangeFigure;
    let animation = matches!(edit.kind, SetAnimation | SetTransform);
    let media = matches!(edit.kind, Bgm | PlayEffect | PlayVideo);
    let unlock = matches!(edit.kind, UnlockCg | UnlockBgm);
    vec![
        ("next", edit.next.then(|| "-next".into())),
        ("when", flag("when", &edit.when)),
        ("title", input.then(|| flag("title", &edit.title)).flatten()),
        (
            "buttonText",
            input.then(|| flag("buttonText", &edit.button)).flatten(),
        ),
        (
            "target",
            animation.then(|| flag("target", &edit.target)).flatten(),
        ),
        (
            "name",
            unlock.then(|| flag("name", &edit.display_name)).flatten(),
        ),
        (
            "volume",
            media
                .then(|| edit.volume.map(|value| format!("-volume={value}")))
                .flatten(),
        ),
        (
            "left",
            (figure && edit.figure_position == "left").then(|| "-left".into()),
        ),
        (
            "right",
            (figure && edit.figure_position == "right").then(|| "-right".into()),
        ),
        ("id", figure.then(|| flag("id", &edit.figure_id)).flatten()),
        (
            "figureCharacter",
            figure
                .then(|| flag("figureCharacter", &edit.figure_character))
                .flatten(),
        ),
        (
            "figureEmotion",
            figure
                .then(|| flag("figureEmotion", &edit.figure_emotion))
                .flatten(),
        ),
    ]
}

fn flag(key: &str, value: &str) -> Option<String> {
    (!value.is_empty()).then(|| format!("-{key}={}", escape_literal(value)))
}

fn ending(source: &str) -> &'static str {
    if source.ends_with("\r\n") {
        "\r\n"
    } else if source.is_empty() || source.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}
