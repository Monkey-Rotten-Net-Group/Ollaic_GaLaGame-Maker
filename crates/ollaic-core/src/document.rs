use crate::webgal::parser::{delimiter_positions, split_unescaped};
use crate::webgal::{parser::parse_script, serializer::serialize_script, types::*};
use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptLine {
    pub source: String,
    pub kind: String,
    pub speaker: String,
    pub text: String,
    pub command: String,
    pub preview: String,
}

/// Keep the original bytes, including blank lines, flags, comments and line endings.
pub fn decode_lines(source: &str) -> Vec<ScriptLine> {
    let mut chunks: Vec<String> = Vec::new();
    for line in source.split_inclusive('\n') {
        let continuation = chunks.last().is_some_and(|previous| {
            !previous.trim().is_empty()
                && (previous.trim_end_matches(['\r', '\n']).ends_with('\\')
                    || (line.starts_with(char::is_whitespace)
                        && line.trim_start().starts_with(['-', '|'])))
        });
        if continuation {
            chunks.last_mut().unwrap().push_str(line);
        } else {
            chunks.push(line.to_owned());
        }
    }
    chunks
        .into_iter()
        .map(|source| {
            if source.trim_end_matches(['\r', '\n']).contains('\n') {
                return ScriptLine {
                    text: source.trim_end_matches(['\r', '\n']).to_owned(),
                    preview: source.trim_end_matches(['\r', '\n']).to_owned(),
                    source,
                    kind: "Command".into(),
                    speaker: String::new(),
                    command: "raw".into(),
                };
            }
            let node = parse_script(&source).into_iter().next();
            let preview = node
                .as_ref()
                .map(command_preview)
                .unwrap_or_else(|| source.trim_end_matches(['\r', '\n']).to_owned());
            let (kind, speaker, text, command) = match node {
                Some(node) => {
                    let kind = match node.cmd_type {
                        CommandType::Dialogue => "Dialogue",
                        CommandType::Narrator => "Narration",
                        CommandType::Comment => "Note",
                        _ => "Command",
                    };
                    let command = serde_json::to_value(&node.cmd_type)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned();
                    let text = if kind == "Command" {
                        source.trim_end_matches(['\r', '\n']).to_owned()
                    } else {
                        if kind == "Note" {
                            node.content
                        } else {
                            unescape_literal(&node.content)
                        }
                    };
                    (
                        kind,
                        unescape_literal(&node.character.unwrap_or_default()),
                        text,
                        command,
                    )
                }
                None => (
                    "Command",
                    String::new(),
                    source.trim_end_matches(['\r', '\n']).to_owned(),
                    "raw".to_owned(),
                ),
            };
            ScriptLine {
                source: source.to_owned(),
                kind: kind.to_owned(),
                speaker,
                text,
                command,
                preview,
            }
        })
        .collect()
}

fn command_preview(node: &WebGalNode) -> String {
    match node.cmd_type {
        CommandType::Choose => node
            .choices
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|choice| {
                let text = unescape_literal(&choice.text);
                if choice.target.is_empty() {
                    text
                } else {
                    format!("{text} -> {}", unescape_literal(&choice.target))
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        CommandType::Intro => node
            .intro_lines
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|line| unescape_literal(line))
            .collect::<Vec<_>>()
            .join("\n"),
        CommandType::Comment | CommandType::SetTransform => node.content.clone(),
        CommandType::End => String::new(),
        _ => unescape_literal(&node.content),
    }
}

pub fn edit_line(original: &str, kind: &str, speaker: &str, text: &str) -> Result<String> {
    let lines = decode_lines(original);
    let same_line = lines.len() == 1
        && lines[0].kind == kind
        && lines[0].speaker == speaker
        && lines[0].text == text;
    let same_paragraphs = lines.len() > 1
        && matches!(kind, "Dialogue" | "Narration" | "Note")
        && lines.iter().all(|line| {
            (line.kind == kind && line.speaker == speaker)
                || (line.kind == "Command" && line.text.is_empty())
        })
        && lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            == text;
    if same_line || same_paragraphs {
        return Ok(original.to_owned());
    }
    if kind == "Command" {
        return Ok(text.to_owned());
    }
    if text.trim().is_empty() || speaker.contains(['\n', '\r']) {
        return Err(Error::Invalid(
            "A script entry must contain text and its speaker must fit on one line".into(),
        ));
    }
    let cmd_type = match kind {
        "Dialogue" => CommandType::Dialogue,
        "Narration" => CommandType::Narrator,
        "Note" => CommandType::Comment,
        _ => return Err(Error::Invalid("Unknown script entry type".into())),
    };
    let mut node = parse_script(original)
        .into_iter()
        .next()
        .unwrap_or_else(|| WebGalNode::new("1".into(), cmd_type.clone(), String::new()));
    node.cmd_type = cmd_type;
    node.character = if kind == "Dialogue" && !speaker.is_empty() {
        Some(escape_literal(speaker))
    } else {
        None
    };
    let separator = if original.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut rendered = text
        .split('\n')
        .map(|part| {
            if part.is_empty() {
                return String::new();
            }
            let mut part_node = node.clone();
            part_node.content = if kind == "Note" {
                part.trim_end_matches('\r').into()
            } else {
                escape_literal(part.trim_end_matches('\r'))
            };
            serialize_script(&[part_node])
                .trim_end_matches(['\r', '\n'])
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join(separator);
    if let Some(comment) = delimiter_positions(original, ';')
        .next()
        .filter(|_| original.lines().count() == 1)
        .map(|index| &original[index + 1..])
    {
        if kind != "Note" && !comment.trim().is_empty() {
            rendered = format!("{}{}", rendered.trim_end_matches(['\r', '\n']), comment);
        }
    }
    let newline = if original.ends_with("\r\n") {
        "\r\n"
    } else if original.ends_with('\n') || original.is_empty() {
        "\n"
    } else {
        ""
    };
    Ok(format!(
        "{}{newline}",
        rendered.trim_end_matches(['\r', '\n'])
    ))
}

pub fn assemble_lines(lines: &[String]) -> String {
    let mut source = String::new();
    for line in lines {
        if !source.is_empty() && !source.ends_with('\n') {
            source.push('\n');
        }
        source.push_str(line);
    }
    source
}

pub fn rename_scene_references(source: &str, old: &str, new: &str) -> String {
    if old == new {
        return source.to_owned();
    }
    source
        .split_inclusive('\n')
        .map(|line| {
            let Some(colon) = delimiter_positions(line, ':').next() else {
                return line.to_owned();
            };
            let value = &line[colon + 1..];
            let rewritten = match line[..colon].trim() {
                "changeScene" | "callScene"
                    if parse_script(line)
                        .first()
                        .and_then(|node| node.target_scene.as_ref())
                        .is_some_and(|target| unescape_literal(target) == old) =>
                {
                    replace_target(value, old, new)
                }
                "choose" => {
                    let end = delimiter_positions(value, ';')
                        .next()
                        .unwrap_or(value.len());
                    let branches = split_unescaped(&value[..end], '|')
                        .into_iter()
                        .map(|branch| {
                            let matches = parse_script(&format!("choose:{branch};"))
                                .first()
                                .and_then(|node| node.choices.as_ref())
                                .and_then(|choices| choices.first())
                                .is_some_and(|choice| unescape_literal(&choice.target) == old);
                            if !matches {
                                return branch.to_owned();
                            }
                            let Some(colon) = delimiter_positions(branch, ':').last() else {
                                return branch.to_owned();
                            };
                            format!(
                                "{}{}",
                                &branch[..colon + 1],
                                replace_target(&branch[colon + 1..], old, new)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("|");
                    format!("{branches}{}", &value[end..])
                }
                _ => return line.to_owned(),
            };
            format!("{}{}", &line[..colon + 1], rewritten)
        })
        .collect()
}

fn replace_target(value: &str, old: &str, new: &str) -> String {
    let statement_end = delimiter_positions(value, ';')
        .next()
        .unwrap_or(value.len());
    let content_end = crate::webgal::parser::flag_ranges(&value[..statement_end])
        .first()
        .map_or(statement_end, |range| range.start);
    let target = value[..content_end].trim();
    let leading = value.len() - value.trim_start().len();
    if unescape_literal(target) == old {
        format!(
            "{}{}{}",
            &value[..leading],
            escape_literal(new),
            &value[leading + target.len()..]
        )
    } else {
        value.to_owned()
    }
}

pub(crate) fn escape_literal(value: &str) -> String {
    let mut escaped = String::new();
    let mut token_start = true;
    for character in value.chars() {
        if matches!(character, '\\' | ';' | ':' | '|') || (character == '-' && token_start) {
            escaped.push('\\');
        }
        escaped.push(character);
        token_start = character.is_whitespace();
    }
    escaped
}

pub(crate) fn unescape_literal(value: &str) -> String {
    let mut output = String::new();
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\'
            && chars
                .peek()
                .is_some_and(|next| matches!(next, '\\' | ';' | ':' | '|' | ',' | '.' | '-'))
        {
            output.push(chars.next().unwrap());
            continue;
        }
        output.push(character);
    }
    output
}
