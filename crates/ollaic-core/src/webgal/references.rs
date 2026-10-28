use super::types::{CommandType, WebGalNode};
use super::{animations, parser, resource_paths};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetReference {
    pub line_number: usize,
    pub line_content: String,
    pub command: &'static str,
    pub category: &'static str,
    pub filename: String,
}

/// Extract project asset references through the same parsed scene semantics
/// used by the editor, while preserving source locations for diagnostics.
pub fn find_asset_references(source: &str) -> Vec<AssetReference> {
    references(source, false)
}

pub fn find_asset_references_to(
    source: &str,
    category: &str,
    filename: &str,
) -> Vec<AssetReference> {
    references(source, true)
        .into_iter()
        .filter(|reference| reference.category == category && reference.filename == filename)
        .collect()
}

fn references(source: &str, include_builtin_animations: bool) -> Vec<AssetReference> {
    source
        .lines()
        .enumerate()
        .filter_map(|(line_index, line)| {
            let node = parser::parse_script(line).into_iter().next()?;
            let (command, category, filename) =
                reference_from_node(&node, include_builtin_animations)?;
            Some(AssetReference {
                line_number: line_index + 1,
                line_content: line.trim().to_string(),
                command,
                category,
                filename,
            })
        })
        .collect()
}

/// Rename semantic references to one asset while leaving unrelated source text intact.
pub fn rename_asset_references(
    source: &str,
    category: &str,
    old_filename: &str,
    new_filename: &str,
) -> (String, usize) {
    let mut changed = 0usize;
    let mut rewritten = String::with_capacity(source.len());

    for line in source.split_inclusive('\n') {
        let reference = find_asset_references_to(line, category, old_filename)
            .into_iter()
            .next();
        let Some(reference) = reference else {
            rewritten.push_str(line);
            continue;
        };

        let end = parser::delimiter_positions(line, ';')
            .next()
            .unwrap_or(line.len());
        let statement = &line[..end];
        let span = if reference.command == "voice" {
            parser::flag_ranges(statement)
                .into_iter()
                .find_map(|range| {
                    let token = &statement[range.clone()];
                    let body = token[1..].trim_end();
                    let (key, offset) = body
                        .find('=')
                        .map(|equal| (&body[..equal], equal + 2))
                        .unwrap_or((body, 1));
                    if !parser::is_voice_flag(key) {
                        return None;
                    }
                    let start = range.start + offset;
                    let raw = &statement[start..range.end];
                    let value = raw.trim();
                    (resource_paths::decode_voice(value) == old_filename)
                        .then(|| range.start..range.end - (raw.len() - raw.trim_end().len()))
                })
        } else {
            parser::delimiter_positions(statement, ':')
                .next()
                .map(|colon| {
                    let value = &statement[colon + 1..];
                    let end = parser::flag_ranges(value)
                        .first()
                        .map_or(value.len(), |range| range.start);
                    let content = &value[..end];
                    let start = colon + 1 + content.len() - content.trim_start().len();
                    start..start + content.trim().len()
                })
        };
        let next = if let Some(span) = span {
            format!(
                "{}{}{}",
                &line[..span.start],
                if reference.command == "voice" {
                    format!("-vocal={}", resource_paths::encode_voice(new_filename))
                } else if category == "animation" {
                    animations::name(new_filename)
                } else {
                    resource_paths::encode(new_filename)
                },
                &line[span.end..]
            )
        } else {
            line.to_owned()
        };
        if next != line {
            changed += 1;
        }
        rewritten.push_str(&next);
    }

    (rewritten, changed)
}

fn reference_from_node(
    node: &WebGalNode,
    include_builtin_animations: bool,
) -> Option<(&'static str, &'static str, String)> {
    let (command, category) = match node.cmd_type {
        CommandType::ChangeBg => ("changeBg", "background"),
        CommandType::ChangeFigure => ("changeFigure", "figure"),
        CommandType::MiniAvatar => ("miniAvatar", "figure"),
        CommandType::Bgm => ("bgm", "bgm"),
        CommandType::PlayEffect => ("playEffect", "vocal"),
        CommandType::PlayVideo => ("playVideo", "video"),
        CommandType::UnlockCg => ("unlockCg", "background"),
        CommandType::UnlockBgm => ("unlockBgm", "bgm"),
        CommandType::SetAnimation
            if node.animation_name.as_deref().is_some_and(|name| {
                include_builtin_animations || !animations::DEFAULT_NAMES.contains(&name)
            }) =>
        {
            ("setAnimation", "animation")
        }
        CommandType::Dialogue | CommandType::Narrator if node.voice.is_some() => ("voice", "vocal"),
        _ => return None,
    };
    let filename = if command == "voice" {
        node.voice.as_deref()
    } else {
        node.asset
            .as_deref()
            .or(node.animation_name.as_deref())
            .or(Some(node.content.as_str()))
    }?;
    let filename = filename.trim();
    if filename.is_empty() || filename == "none" {
        return None;
    }
    Some((
        command,
        category,
        if category == "animation" {
            format!("{filename}.json")
        } else {
            filename.to_owned()
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_supported_asset_commands_with_source_locations() {
        let source = concat!(
            "changeBg:park.webp -next;\n",
            "changeFigure:hero.webp -left;\n",
            "playVideo:intro.mp4;\n",
            ":park.webp is only dialogue text;\n",
        );

        let references = find_asset_references(source);

        assert_eq!(references.len(), 3);
        assert_eq!(
            references[0],
            AssetReference {
                line_number: 1,
                line_content: "changeBg:park.webp -next;".to_string(),
                command: "changeBg",
                category: "background",
                filename: "park.webp".to_string(),
            }
        );
        assert_eq!(references[2].category, "video");
        assert_eq!(references[2].filename, "intro.mp4");
    }

    #[test]
    fn skips_none_and_non_asset_commands() {
        let references = find_asset_references("changeFigure:none;\nchangeScene:park.webp;\n");
        assert!(references.is_empty());
    }

    #[test]
    fn renames_only_matching_semantic_references() {
        let source = concat!(
            "changeBg:park.webp -next;\n",
            "changeFigure:park.webp -left;\n",
            ":park.webp is dialogue text;\n",
            "Alice:hello -v1.wav;\n",
        );

        let (background, changed) =
            rename_asset_references(source, "background", "park.webp", "garden.webp");
        assert_eq!(changed, 1);
        assert!(background.contains("changeBg:garden.webp -next;"));
        assert!(background.contains("changeFigure:park.webp -left;"));
        assert!(background.contains(":park.webp is dialogue text;"));

        let (vocal, changed) = rename_asset_references(&background, "vocal", "v1.wav", "intro.wav");
        assert_eq!(changed, 1);
        assert!(vocal.contains("Alice:hello -vocal=./game/vocal/intro.wav;"));
        assert_eq!(find_asset_references(&vocal)[2].filename, "intro.wav");
    }
}
