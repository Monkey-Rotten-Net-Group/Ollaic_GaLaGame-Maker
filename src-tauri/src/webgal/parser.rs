use super::types::*;

/// Known WebGAL commands (not character names).
const KNOWN_COMMANDS: &[&str] = &[
    "changeBg",
    "changeFigure",
    "miniAvatar",
    "changeScene",
    "callScene",
    "end",
    "bgm",
    "playEffect",
    "playVideo",
    "label",
    "jumpLabel",
    "setVar",
    "setTextbox",
    "getUserInput",
    "intro",
    "setAnimation",
    "setTransform",
    "unlockCg",
    "unlockBgm",
    "choose",
];

fn is_known_command(s: &str) -> bool {
    KNOWN_COMMANDS.contains(&s)
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

struct ParsedContent {
    content: String,
    flags: Vec<Flag>,
}

fn parse_flags(raw: &str) -> ParsedContent {
    let mut flags = Vec::new();
    let mut content_parts = Vec::new();
    let mut in_content = true;

    for token in raw.split_whitespace() {
        // A flag starts with '-' followed by a letter
        if token.len() >= 2 && token.starts_with('-') && token.as_bytes()[1].is_ascii_alphabetic() {
            in_content = false;
        }

        if !in_content
            && token.len() >= 2
            && token.starts_with('-')
            && token.as_bytes()[1].is_ascii_alphabetic()
        {
            let body = &token[1..];
            if let Some(eq_pos) = body.find('=') {
                flags.push(Flag {
                    key: body[..eq_pos].to_string(),
                    value: FlagValue::Str(body[eq_pos + 1..].to_string()),
                });
            } else {
                flags.push(Flag {
                    key: body.to_string(),
                    value: FlagValue::Bool(true),
                });
            }
        } else {
            content_parts.push(token);
        }
    }

    ParsedContent {
        content: content_parts.join(" "),
        flags,
    }
}

// ---------------------------------------------------------------------------
// Choice parsing
// ---------------------------------------------------------------------------

fn parse_choices(raw: &str) -> Vec<ChoiceBranch> {
    raw.split('|')
        .map(|part| {
            let part = part.trim();
            // Find the last colon — text:target
            if let Some(pos) = part.rfind(':') {
                if pos > 0 {
                    return ChoiceBranch {
                        text: part[..pos].trim().to_string(),
                        target: part[pos + 1..].trim().to_string(),
                    };
                }
            }
            ChoiceBranch {
                text: part.to_string(),
                target: String::new(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Helpers for extracting flag values
// ---------------------------------------------------------------------------

fn flag_str<'a>(flags: &'a [Flag], key: &str) -> Option<&'a str> {
    flags.iter().find_map(|f| {
        if f.key == key {
            match &f.value {
                FlagValue::Str(s) => Some(s.as_str()),
                _ => None,
            }
        } else {
            None
        }
    })
}

fn has_flag(flags: &[Flag], key: &str) -> bool {
    flags.iter().any(|f| f.key == key)
}

fn is_voice_file_flag(key: &str) -> bool {
    let lower = key.to_lowercase();
    [".mp3", ".ogg", ".wav", ".flac", ".aac"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn voice_from_flags(flags: &[Flag]) -> Option<String> {
    for f in flags {
        let k = &f.key;
        if ((k.starts_with('v') || k.starts_with('V'))
            && k.len() > 1
            && k.as_bytes()[1].is_ascii_digit())
            || is_voice_file_flag(k)
        {
            return Some(match &f.value {
                FlagValue::Str(s) => s.clone(),
                FlagValue::Bool(_) => k.clone(),
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Single-line parser
// ---------------------------------------------------------------------------

fn parse_line(line: &str, index: usize) -> Option<WebGalNode> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Comment line
    if trimmed.starts_with(';') {
        let comment = trimmed[1..].trim().to_string();
        return Some(WebGalNode::new(
            (index + 1).to_string(),
            CommandType::Comment,
            comment,
        ));
    }

    // Strip trailing semicolons and inline comments
    let body = match trimmed.find(';') {
        Some(pos) => trimmed[..pos].trim(),
        None => trimmed,
    };
    if body.is_empty() {
        return None;
    }

    // Split on first colon
    let colon_idx = body.find(':');

    // No colon → continuation dialogue
    if colon_idx.is_none() {
        let parsed = parse_flags(body);
        let mut node = WebGalNode::new(
            (index + 1).to_string(),
            CommandType::Dialogue,
            parsed.content,
        );
        node.flags = parsed.flags.clone();
        node.voice = voice_from_flags(&parsed.flags);
        apply_common_flags(&mut node);
        return Some(node);
    }

    let colon_idx = colon_idx.unwrap();
    let prefix = body[..colon_idx].trim();
    let rest = body[colon_idx + 1..].trim();

    // Empty prefix → narrator
    if prefix.is_empty() {
        let parsed = parse_flags(rest);
        let mut node = WebGalNode::new(
            (index + 1).to_string(),
            CommandType::Narrator,
            parsed.content,
        );
        node.flags = parsed.flags.clone();
        node.voice = voice_from_flags(&parsed.flags);
        apply_common_flags(&mut node);
        return Some(node);
    }

    // Known command
    if is_known_command(prefix) {
        let cmd_type = command_type_from_str(prefix);
        let parsed = parse_flags(rest);
        let mut node = build_command_node(index, cmd_type, &parsed.content, &parsed.flags);
        node.flags = parsed.flags;
        apply_common_flags(&mut node);
        return Some(node);
    }

    // Otherwise: character dialogue
    let parsed = parse_flags(rest);
    let mut node = WebGalNode::new(
        (index + 1).to_string(),
        CommandType::Dialogue,
        parsed.content,
    );
    node.character = Some(prefix.to_string());
    node.flags = parsed.flags.clone();

    node.voice = voice_from_flags(&parsed.flags);

    apply_common_flags(&mut node);
    Some(node)
}

fn apply_common_flags(node: &mut WebGalNode) {
    if has_flag(&node.flags, "next") {
        node.next = Some(true);
    }
    if let Some(w) = flag_str(&node.flags, "when") {
        node.when = Some(w.to_string());
    }
}

fn command_type_from_str(s: &str) -> CommandType {
    match s {
        "changeBg" => CommandType::ChangeBg,
        "changeFigure" => CommandType::ChangeFigure,
        "miniAvatar" => CommandType::MiniAvatar,
        "changeScene" => CommandType::ChangeScene,
        "callScene" => CommandType::CallScene,
        "end" => CommandType::End,
        "bgm" => CommandType::Bgm,
        "playEffect" => CommandType::PlayEffect,
        "playVideo" => CommandType::PlayVideo,
        "label" => CommandType::Label,
        "jumpLabel" => CommandType::JumpLabel,
        "setVar" => CommandType::SetVar,
        "setTextbox" => CommandType::SetTextbox,
        "getUserInput" => CommandType::GetUserInput,
        "intro" => CommandType::Intro,
        "setAnimation" => CommandType::SetAnimation,
        "setTransform" => CommandType::SetTransform,
        "unlockCg" => CommandType::UnlockCg,
        "unlockBgm" => CommandType::UnlockBgm,
        "choose" => CommandType::Choose,
        _ => CommandType::Comment,
    }
}

fn build_command_node(
    index: usize,
    cmd_type: CommandType,
    content: &str,
    flags: &[Flag],
) -> WebGalNode {
    let mut node = WebGalNode::new(
        (index + 1).to_string(),
        cmd_type.clone(),
        content.to_string(),
    );

    match cmd_type {
        CommandType::ChangeBg | CommandType::MiniAvatar => {
            node.asset = Some(content.to_string());
        }

        CommandType::ChangeFigure => {
            node.asset = Some(content.to_string());
            node.figure_position = Some(if has_flag(flags, "left") {
                FigurePosition::Left
            } else if has_flag(flags, "right") {
                FigurePosition::Right
            } else {
                FigurePosition::Center
            });
            if let Some(id) = flag_str(flags, "id") {
                node.figure_id = Some(id.to_string());
            }
            if let Some(ch) = flag_str(flags, "figureCharacter") {
                node.figure_character = Some(ch.to_string());
            }
            if let Some(em) = flag_str(flags, "figureEmotion") {
                node.figure_emotion = Some(em.to_string());
            }
        }

        CommandType::ChangeScene | CommandType::CallScene => {
            node.target_scene = Some(content.to_string());
        }

        CommandType::Choose => {
            node.choices = Some(parse_choices(content));
        }

        CommandType::Label | CommandType::JumpLabel => {
            node.label_name = Some(content.to_string());
        }

        CommandType::SetVar => {
            if let Some(eq_pos) = content.find('=') {
                node.var_name = Some(content[..eq_pos].to_string());
                node.var_value = Some(content[eq_pos + 1..].to_string());
            }
        }

        CommandType::GetUserInput => {
            node.var_name = Some(content.to_string());
            if let Some(t) = flag_str(flags, "title") {
                node.input_title = Some(t.to_string());
            }
            if let Some(b) = flag_str(flags, "buttonText") {
                node.input_button = Some(b.to_string());
            }
        }

        CommandType::Intro => {
            node.intro_lines = Some(content.split('|').map(|s| s.trim().to_string()).collect());
        }

        CommandType::Bgm | CommandType::PlayEffect | CommandType::PlayVideo => {
            node.asset = Some(content.to_string());
            if let Some(v) = flag_str(flags, "volume") {
                node.volume = v.parse().ok();
            }
        }

        CommandType::SetAnimation => {
            node.animation_name = Some(content.to_string());
            if let Some(t) = flag_str(flags, "target") {
                node.animation_target = Some(t.to_string());
            }
        }

        CommandType::UnlockCg | CommandType::UnlockBgm => {
            node.asset = Some(content.to_string());
            if let Some(n) = flag_str(flags, "name") {
                node.display_name = Some(n.to_string());
            }
        }

        _ => {}
    }

    node
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a full WebGAL `.txt` scene file into a list of nodes.
pub fn parse_script(source: &str) -> Vec<WebGalNode> {
    let mut nodes = Vec::new();

    for line in source.lines() {
        if let Some(node) = parse_line(line, nodes.len()) {
            nodes.push(node);
        }
    }

    // Terminal types don't auto-connect to next node
    let terminal: &[CommandType] = &[
        CommandType::Choose,
        CommandType::ChangeScene,
        CommandType::End,
        CommandType::JumpLabel,
    ];

    // Build sequential connections
    for i in 0..nodes.len().saturating_sub(1) {
        if !terminal.contains(&nodes[i].cmd_type) {
            let next_id = nodes[i + 1].id.clone();
            nodes[i].connections.push(next_id);
        }
    }

    // Layout: vertical flow
    for (i, node) in nodes.iter_mut().enumerate() {
        node.position = Position {
            x: 100.0,
            y: 60.0 + (i as f64) * 110.0,
        };
    }

    nodes
}
