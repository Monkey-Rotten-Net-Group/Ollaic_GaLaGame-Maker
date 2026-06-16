use super::types::*;

fn is_voice_file_flag(key: &str) -> bool {
    let lower = key.to_lowercase();
    [".mp3", ".ogg", ".wav", ".flac", ".aac"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn is_managed_voice_flag(key: &str) -> bool {
    ((key.starts_with('v') || key.starts_with('V'))
        && key.len() > 1
        && key.as_bytes()[1].is_ascii_digit())
        || is_voice_file_flag(key)
}

fn serialize_flags(node: &WebGalNode) -> String {
    let mut parts = Vec::new();

    // Pass through custom flags (skip ones we reconstruct below)
    let managed_keys = [
        "left",
        "right",
        "id",
        "next",
        "when",
        "volume",
        "title",
        "buttonText",
        "target",
        "name",
    ];
    for flag in &node.flags {
        if managed_keys.contains(&flag.key.as_str()) || is_managed_voice_flag(&flag.key) {
            continue;
        }
        match &flag.value {
            FlagValue::Bool(true) => parts.push(format!("-{}", flag.key)),
            FlagValue::Str(v) => parts.push(format!("-{}={}", flag.key, v)),
            _ => {}
        }
    }

    // Reconstruct type-specific flags from structured fields
    if let Some(FigurePosition::Left) = &node.figure_position {
        parts.push("-left".into());
    }
    if let Some(FigurePosition::Right) = &node.figure_position {
        parts.push("-right".into());
    }
    if let Some(id) = &node.figure_id {
        if !id.is_empty() {
            parts.push(format!("-id={}", id));
        }
    }
    if let Some(ch) = &node.figure_character {
        if !ch.is_empty() {
            parts.push(format!("-figureCharacter={}", ch));
        }
    }
    if let Some(em) = &node.figure_emotion {
        if !em.is_empty() {
            parts.push(format!("-figureEmotion={}", em));
        }
    }
    if node.next == Some(true) {
        parts.push("-next".into());
    }
    if let Some(w) = &node.when {
        if !w.is_empty() {
            parts.push(format!("-when={}", w));
        }
    }
    if let Some(v) = node.volume {
        parts.push(format!("-volume={}", v));
    }
    if let Some(t) = &node.animation_target {
        if !t.is_empty() {
            parts.push(format!("-target={}", t));
        }
    }
    if let Some(n) = &node.display_name {
        if !n.is_empty() {
            parts.push(format!("-name={}", n));
        }
    }
    if let Some(t) = &node.input_title {
        if !t.is_empty() {
            parts.push(format!("-title={}", t));
        }
    }
    if let Some(b) = &node.input_button {
        if !b.is_empty() {
            parts.push(format!("-buttonText={}", b));
        }
    }
    if let Some(v) = &node.voice {
        if !v.is_empty() {
            parts.push(format!("-{}", v));
        }
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    }
}

fn serialize_node(node: &WebGalNode) -> String {
    let flags = serialize_flags(node);

    match node.cmd_type {
        CommandType::Comment => format!("; {}", node.content),

        CommandType::Dialogue => {
            if let Some(ch) = &node.character {
                if !ch.is_empty() {
                    return format!("{}:{}{};", ch, node.content, flags);
                }
            }
            format!("{}{};", node.content, flags)
        }

        CommandType::Narrator => format!(":{}{};", node.content, flags),

        CommandType::Intro => {
            let lines = node.intro_lines.as_deref().unwrap_or(&[]).join("|");
            let text = if lines.is_empty() {
                &node.content
            } else {
                &lines
            };
            format!("intro:{}{};", text, flags)
        }

        CommandType::Choose => {
            if let Some(choices) = &node.choices {
                if !choices.is_empty() {
                    let opts: Vec<String> = choices
                        .iter()
                        .map(|c| {
                            if c.target.is_empty() {
                                c.text.clone()
                            } else {
                                format!("{}:{}", c.text, c.target)
                            }
                        })
                        .collect();
                    return format!("choose:{}{};", opts.join("|"), flags);
                }
            }
            format!("choose:{}{};", node.content, flags)
        }

        CommandType::ChangeBg => {
            let asset = node.asset.as_deref().unwrap_or(&node.content);
            format!("changeBg:{}{};", asset, flags)
        }

        CommandType::ChangeFigure => {
            let asset = node.asset.as_deref().unwrap_or(&node.content);
            format!("changeFigure:{}{};", asset, flags)
        }

        CommandType::MiniAvatar => {
            let asset = node.asset.as_deref().unwrap_or(&node.content);
            format!("miniAvatar:{}{};", asset, flags)
        }

        CommandType::ChangeScene => {
            let target = node.target_scene.as_deref().unwrap_or(&node.content);
            format!("changeScene:{}{};", target, flags)
        }

        CommandType::CallScene => {
            let target = node.target_scene.as_deref().unwrap_or(&node.content);
            format!("callScene:{}{};", target, flags)
        }

        CommandType::End => "end;".to_string(),

        CommandType::Label => {
            let name = node.label_name.as_deref().unwrap_or(&node.content);
            format!("label:{}{};", name, flags)
        }

        CommandType::JumpLabel => {
            let name = node.label_name.as_deref().unwrap_or(&node.content);
            format!("jumpLabel:{}{};", name, flags)
        }

        CommandType::SetVar => {
            if let (Some(name), Some(val)) = (&node.var_name, &node.var_value) {
                format!("setVar:{}={}{};", name, val, flags)
            } else {
                format!("setVar:{}{};", node.content, flags)
            }
        }

        CommandType::GetUserInput => {
            let var = node.var_name.as_deref().unwrap_or(&node.content);
            format!("getUserInput:{}{};", var, flags)
        }

        CommandType::SetTextbox => format!("setTextbox:{}{};", node.content, flags),

        CommandType::Bgm | CommandType::PlayEffect | CommandType::PlayVideo => {
            let cmd = match node.cmd_type {
                CommandType::Bgm => "bgm",
                CommandType::PlayEffect => "playEffect",
                CommandType::PlayVideo => "playVideo",
                _ => unreachable!(),
            };
            let asset = node.asset.as_deref().unwrap_or(&node.content);
            format!("{}:{}{};", cmd, asset, flags)
        }

        CommandType::SetAnimation => {
            let name = node.animation_name.as_deref().unwrap_or(&node.content);
            format!("setAnimation:{}{};", name, flags)
        }

        CommandType::SetTransform => {
            format!("setTransform:{}{};", node.content, flags)
        }

        CommandType::UnlockCg => {
            let asset = node.asset.as_deref().unwrap_or(&node.content);
            format!("unlockCg:{}{};", asset, flags)
        }

        CommandType::UnlockBgm => {
            let asset = node.asset.as_deref().unwrap_or(&node.content);
            format!("unlockBgm:{}{};", asset, flags)
        }
    }
}

/// Serialize a list of nodes back to WebGAL `.txt` scene format.
pub fn serialize_script(nodes: &[WebGalNode]) -> String {
    let mut lines: Vec<String> = nodes.iter().map(serialize_node).collect();
    lines.push(String::new()); // trailing newline
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::serialize_script;
    use crate::webgal::parser::parse_script;

    #[test]
    fn serializing_parsed_voice_flag_does_not_duplicate_it() {
        let nodes = parse_script("Alice:hello -v1.wav;\n:aside -narrator_01.mp3;\n");
        let serialized_once = serialize_script(&nodes);
        assert!(serialized_once.contains("Alice:hello -v1.wav;"));
        assert!(serialized_once.contains(":aside -narrator_01.mp3;"));
        assert_eq!(serialized_once.matches("-v1.wav").count(), 1);
        assert_eq!(serialized_once.matches("-narrator_01.mp3").count(), 1);

        let serialized_twice = serialize_script(&parse_script(&serialized_once));
        assert_eq!(serialized_twice.matches("-v1.wav").count(), 1);
        assert_eq!(serialized_twice.matches("-narrator_01.mp3").count(), 1);
    }
}
