use super::parser;
use super::types::{CommandType, WebGalNode};

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
    source
        .lines()
        .enumerate()
        .filter_map(|(line_index, line)| {
            let node = parser::parse_script(line).into_iter().next()?;
            let (command, category, filename) = reference_from_node(&node)?;
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
        let reference = find_asset_references(line)
            .into_iter()
            .find(|reference| reference.category == category && reference.filename == old_filename);
        let Some(reference) = reference else {
            rewritten.push_str(line);
            continue;
        };

        let next = if reference.command == "voice" {
            line.replacen(&format!("-{old_filename}"), &format!("-{new_filename}"), 1)
        } else if let Some(colon) = line.find(':') {
            let (prefix, value) = line.split_at(colon + 1);
            format!("{prefix}{}", value.replacen(old_filename, new_filename, 1))
        } else {
            line.to_string()
        };
        if next != line {
            changed += 1;
        }
        rewritten.push_str(&next);
    }

    (rewritten, changed)
}

/// Remove semantic references to one asset while preserving unrelated source.
/// Command-only references are removed with their line; dialogue voice flags
/// are removed without deleting the dialogue itself.
pub fn remove_asset_references(source: &str, category: &str, filename: &str) -> (String, usize) {
    let mut changed = 0usize;
    let mut rewritten = String::with_capacity(source.len());

    for line in source.split_inclusive('\n') {
        let reference = find_asset_references(line)
            .into_iter()
            .find(|reference| reference.category == category && reference.filename == filename);
        let Some(reference) = reference else {
            rewritten.push_str(line);
            continue;
        };

        changed += 1;
        if reference.command == "voice" {
            rewritten.push_str(&remove_voice_flag(line, filename));
        }
    }

    (rewritten, changed)
}

fn remove_voice_flag(line: &str, filename: &str) -> String {
    let needle = format!("-{filename}");
    let Some(flag_start) = line.find(&needle) else {
        return line.to_string();
    };
    let mut remove_start = flag_start;
    while remove_start > 0 {
        let previous = line[..remove_start].chars().next_back().unwrap();
        if !previous.is_whitespace() || previous == '\n' || previous == '\r' {
            break;
        }
        remove_start -= previous.len_utf8();
    }
    format!(
        "{}{}",
        &line[..remove_start],
        &line[flag_start + needle.len()..]
    )
}

fn reference_from_node(node: &WebGalNode) -> Option<(&'static str, &'static str, String)> {
    let (command, category) = match node.cmd_type {
        CommandType::ChangeBg => ("changeBg", "background"),
        CommandType::ChangeFigure => ("changeFigure", "figure"),
        CommandType::MiniAvatar => ("miniAvatar", "figure"),
        CommandType::Bgm => ("bgm", "bgm"),
        CommandType::PlayEffect => ("playEffect", "vocal"),
        CommandType::PlayVideo => ("playVideo", "video"),
        CommandType::Dialogue if node.voice.is_some() => ("voice", "vocal"),
        _ => return None,
    };
    let filename = if command == "voice" {
        node.voice.as_deref()
    } else {
        node.asset.as_deref().or(Some(node.content.as_str()))
    }?;
    let filename = filename.trim();
    if filename.is_empty() || filename == "none" {
        return None;
    }
    Some((command, category, filename.to_string()))
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
        assert!(vocal.contains("Alice:hello -intro.wav;"));
        assert_eq!(find_asset_references(&vocal)[2].filename, "intro.wav");
    }

    #[test]
    fn removes_only_matching_semantic_references_and_preserves_dialogue() {
        let source = concat!(
            "changeBg:park.webp -next;\n",
            "changeFigure:park.webp -left;\n",
            ":park.webp is dialogue text;\n",
            "Alice:hello -v1.wav;\n",
        );

        let (without_background, changed) =
            remove_asset_references(source, "background", "park.webp");
        assert_eq!(changed, 1);
        assert!(!without_background.contains("changeBg:park.webp"));
        assert!(without_background.contains("changeFigure:park.webp -left;"));
        assert!(without_background.contains(":park.webp is dialogue text;"));

        let (without_voice, changed) =
            remove_asset_references(&without_background, "vocal", "v1.wav");
        assert_eq!(changed, 1);
        assert!(without_voice.contains("Alice:hello;"));
        let references = find_asset_references(&without_voice);
        assert!(!references
            .iter()
            .any(|reference| reference.category == "background"));
        assert!(!references
            .iter()
            .any(|reference| reference.category == "vocal"));
    }
}
