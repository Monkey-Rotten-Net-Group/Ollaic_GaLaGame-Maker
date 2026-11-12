use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::story_plan::types::StoryPlan;

/// `.ollaic/plan.json` - the StoryPlan IR location for a project (ADR 0050).
pub fn plan_path(project_path: &Path) -> PathBuf {
    project_path.join(".ollaic").join("plan.json")
}

/// Load the project's StoryPlan. Returns `Ok(None)` when no plan exists yet.
pub fn load_plan(project_path: &Path) -> Result<Option<StoryPlan>, PlanError> {
    let path = plan_path(project_path);
    let candidates = crate::json_store::read_candidates(&path)
        .map_err(|e| PlanError::ReadFailed(path.display().to_string(), e.to_string()))?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut last_error = None;
    for text in candidates {
        match serde_json::from_str::<StoryPlan>(&text) {
            Ok(mut plan) => {
                migrate_legacy_plan(&mut plan);
                match validate(&plan) {
                    Ok(()) => return Ok(Some(plan)),
                    Err(error) => last_error = Some(error),
                }
            }
            Err(error) => last_error = Some(PlanError::InvalidJson(error.to_string())),
        }
    }
    Err(last_error.expect("non-empty candidates produce an error"))
}

/// Validate and persist the plan to `.ollaic/plan.json`.
pub fn save_plan(project_path: &Path, plan: &StoryPlan) -> Result<(), PlanError> {
    validate(plan)?;
    let path = plan_path(project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| PlanError::WriteFailed(parent.display().to_string(), e.to_string()))?;
    }
    let text = serde_json::to_string_pretty(plan)
        .map_err(|e| PlanError::SerializeFailed(e.to_string()))?;
    crate::json_store::write_crash_safe(&path, text.as_bytes())
        .map_err(|e| PlanError::WriteFailed(path.display().to_string(), e.to_string()))?;
    Ok(())
}

pub fn remove_plan(project_path: &Path) -> Result<(), PlanError> {
    let path = plan_path(project_path);
    for candidate in [path.clone(), crate::json_store::backup_path(&path)] {
        if candidate.exists() {
            std::fs::remove_file(&candidate).map_err(|e| {
                PlanError::WriteFailed(candidate.display().to_string(), e.to_string())
            })?;
        }
    }
    Ok(())
}

fn migrate_legacy_plan(plan: &mut StoryPlan) {
    for chapter in &mut plan.chapters {
        if chapter.summary.trim().is_empty() {
            chapter.summary = format!(
                "章节“{}”围绕故事主线继续推进：{}",
                chapter.title, plan.synopsis
            );
        }
    }
    for scene in &mut plan.scene_plans {
        if scene.summary.trim().is_empty() {
            scene.summary = format!("围绕“{}”展开，推进主线冲突与人物关系。", scene.title);
        }
    }
    for character in &mut plan.characters {
        character.relations.retain(|relation| {
            !relation.target_id.trim().is_empty() && !relation.relation_type.trim().is_empty()
        });
    }
    for draft in &mut plan.scene_drafts {
        if draft.title.trim().is_empty() {
            if let Some(scene) = plan
                .scene_plans
                .iter()
                .find(|scene| scene.id == draft.scene_id)
            {
                draft.title.clone_from(&scene.title);
            }
        }
    }
    let scene_ids_by_file: std::collections::HashMap<String, String> = plan
        .scene_plans
        .iter()
        .map(|scene| (scene.file.clone(), scene.id.clone()))
        .collect();
    for task in &mut plan.asset_plan {
        if let Some(scene) = task.scene_ref.as_mut() {
            if let Some(id) = scene_ids_by_file.get(scene) {
                scene.clone_from(id);
            }
        }
        if task.kind == "figure" && task.emotion.is_none() {
            task.emotion = Some("default".to_string());
        }
        if task.id.trim().is_empty() {
            task.id = format!("{}_{}", task.kind.trim(), task.target_stem.trim());
        }
    }
}

/// Structural validation of a StoryPlan. See ADR 0054.
pub fn validate(plan: &StoryPlan) -> Result<(), PlanError> {
    if plan.version != 1 {
        return Err(PlanError::UnsupportedVersion(plan.version));
    }
    if plan.prompt.trim().is_empty() && plan.synopsis.trim().is_empty() {
        return Err(PlanError::EmptyPlan);
    }
    if !plan.memory.worldbook.trim().is_empty() || !plan.memory.glossary.is_empty() {
        required("$.memory.worldbook", &plan.memory.worldbook)?;
        if plan.memory.glossary.len() < 4 {
            return invalid("$.memory.glossary", "must contain at least 4 terms");
        }
        for (term, definition) in &plan.memory.glossary {
            if term.trim().is_empty() || definition.trim().is_empty() {
                let key = serde_json::to_string(term).expect("strings always serialize");
                return invalid(
                    format!("$.memory.glossary[{key}]"),
                    "term and definition must not be empty",
                );
            }
        }
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for (index, chapter) in plan.chapters.iter().enumerate() {
        let path = format!("$.chapters[{index}]");
        required(&format!("{path}.id"), &chapter.id)?;
        required(&format!("{path}.title"), &chapter.title)?;
        required(&format!("{path}.summary"), &chapter.summary)?;
        if !seen.insert(chapter.id.as_str()) {
            return invalid(format!("{path}.id"), "must be unique");
        }
    }
    let chapter_ids: HashSet<&str> = plan
        .chapters
        .iter()
        .map(|chapter| chapter.id.as_str())
        .collect();
    let mut scene_ids: HashSet<&str> = HashSet::new();
    let mut scene_files: HashSet<&str> = HashSet::new();
    for (index, scene) in plan.scene_plans.iter().enumerate() {
        let path = format!("$.scenePlans[{index}]");
        required(&format!("{path}.id"), &scene.id)?;
        required(&format!("{path}.title"), &scene.title)?;
        required(&format!("{path}.summary"), &scene.summary)?;
        if !scene_ids.insert(scene.id.as_str()) {
            return invalid(format!("{path}.id"), "must be unique");
        }
        if !scene_files.insert(scene.file.as_str()) {
            return invalid(format!("{path}.file"), "must be unique");
        }
        if !chapter_ids.contains(scene.chapter_id.as_str()) {
            return invalid(
                format!("{path}.chapterId"),
                format!("references unknown chapter: {}", scene.chapter_id),
            );
        }
        if !is_safe_scene_file(&scene.file) {
            return invalid(format!("{path}.file"), "must be a safe .txt filename");
        }
    }
    if !scene_ids.is_empty() && plan.branches.entry_scene.is_empty() {
        return invalid("$.branches.entryScene", "required when scenes exist");
    }
    if !plan.branches.entry_scene.is_empty()
        && !scene_ids.contains(plan.branches.entry_scene.as_str())
    {
        return invalid(
            "$.branches.entryScene",
            format!("references unknown scene: {}", plan.branches.entry_scene),
        );
    }
    let mut variable_ids: HashSet<&str> = HashSet::new();
    for (index, var) in plan.variables.iter().enumerate() {
        let path = format!("$.variables[{index}]");
        if !is_safe_variable_id(&var.id) {
            return invalid(format!("{path}.id"), "must be a safe variable identifier");
        }
        if !variable_ids.insert(var.id.as_str()) {
            return invalid(format!("{path}.id"), "must be unique");
        }
        match var.kind {
            crate::story_plan::types::VariableKind::Integer => {
                if var.initial_value.trim().parse::<i64>().is_err() {
                    return invalid(
                        format!("{path}.initialValue"),
                        format!("invalid integer initial value: {}", var.initial_value),
                    );
                }
            }
            crate::story_plan::types::VariableKind::Boolean => {
                if !matches!(var.initial_value.trim(), "true" | "false") {
                    return invalid(
                        format!("{path}.initialValue"),
                        format!("invalid boolean initial value: {}", var.initial_value),
                    );
                }
            }
        }
    }
    let mut written_variables: HashSet<String> = HashSet::new();
    let mut read_variables: HashSet<String> = HashSet::new();
    for (index, edge) in plan.branches.edges.iter().enumerate() {
        for (field, id) in [("from", &edge.from), ("to", &edge.to)] {
            if !scene_ids.contains(id.as_str()) {
                return invalid(
                    format!("$.branches.edges[{index}].{field}"),
                    format!("references unknown scene: {id}"),
                );
            }
        }
        if let Some(condition) = &edge.condition {
            if !is_safe_branch_expression(condition) {
                return invalid(
                    format!("$.branches.edges[{index}].condition"),
                    "must not be empty",
                );
            }
            let condition_vars = extract_condition_variables(condition);
            for var in condition_vars {
                if !variable_ids.contains(var.as_str()) {
                    return invalid(
                        format!("$.branches.edges[{index}].condition"),
                        format!("references undefined variable: {var}"),
                    );
                }
                read_variables.insert(var);
            }
        }
        for (effect_index, effect) in edge.effects.iter().enumerate() {
            let effect_path = format!("$.branches.edges[{index}].effects[{effect_index}]");
            if effect.trim().is_empty() {
                return invalid(effect_path, "must not be empty");
            }
            let Some(target_var) = extract_effect_variable(effect) else {
                return invalid(
                    effect_path,
                    "must be an assignment to a valid variable (e.g. var=expr)",
                );
            };
            if !variable_ids.contains(target_var.as_str()) {
                return invalid(
                    effect_path,
                    format!("writes to undefined variable: {target_var}"),
                );
            }
            written_variables.insert(target_var);
        }
    }
    for var in &read_variables {
        if !written_variables.contains(var) {
            return invalid(
                "$.branches",
                format!("variable '{var}' is read in a condition but never written in any branch effect"),
            );
        }
    }
    // In-progress and legacy plans may contain disconnected or unnamed terminal scenes.
    // Complete graph lint belongs to the Outline output contract.
    let mut character_ids: HashSet<&str> = HashSet::new();
    for (index, character) in plan.characters.iter().enumerate() {
        let path = format!("$.characters[{index}]");
        if !is_safe_token(&character.id) {
            return invalid(format!("{path}.id"), "must be a safe id");
        }
        required(&format!("{path}.name"), &character.name)?;
        if !character_ids.insert(character.id.as_str()) {
            return invalid(format!("{path}.id"), "must be unique");
        }
    }
    if !character_ids.is_empty() {
        for (scene_index, scene) in plan.scene_plans.iter().enumerate() {
            for (character_index, character) in scene.character_ids.iter().enumerate() {
                if !character_ids.contains(character.as_str()) {
                    return invalid(
                        format!("$.scenePlans[{scene_index}].characterIds[{character_index}]"),
                        format!("references unknown character: {character}"),
                    );
                }
            }
        }
    }
    for (character_index, character) in plan.characters.iter().enumerate() {
        for (relation_index, relation) in character.relations.iter().enumerate() {
            if !character_ids.contains(relation.target_id.as_str()) {
                return invalid(
                    format!("$.characters[{character_index}].relations[{relation_index}].targetId"),
                    format!("references unknown character: {}", relation.target_id),
                );
            }
        }
    }
    let character_names: HashSet<&str> = plan
        .characters
        .iter()
        .flat_map(|character| {
            std::iter::once(character.name.as_str())
                .chain(character.aliases.iter().map(String::as_str))
        })
        .collect();
    let mut draft_ids: HashSet<&str> = HashSet::new();
    for (draft_index, draft) in plan.scene_drafts.iter().enumerate() {
        let path = format!("$.sceneDrafts[{draft_index}]");
        if !scene_ids.contains(draft.scene_id.as_str()) {
            return invalid(
                format!("{path}.sceneId"),
                format!("references unknown scene: {}", draft.scene_id),
            );
        }
        if !draft_ids.insert(draft.scene_id.as_str()) {
            return invalid(format!("{path}.sceneId"), "must be unique");
        }
        required(&format!("{path}.title"), &draft.title)?;
        if draft.beats.is_empty() {
            return invalid(format!("{path}.beats"), "must not be empty");
        }
        let scene_cast: HashSet<&str> = plan
            .scene_plans
            .iter()
            .find(|scene| scene.id == draft.scene_id)
            .map(|scene| scene.character_ids.iter().map(String::as_str).collect())
            .unwrap_or_default();
        for (beat_index, beat) in draft.beats.iter().enumerate() {
            let beat_path = format!("{path}.beats[{beat_index}]");
            required(&format!("{beat_path}.text"), &beat.text)?;
            if let Some(speaker) = beat.speaker.as_deref() {
                if !character_names.contains(speaker) {
                    return invalid(
                        format!("{beat_path}.speaker"),
                        format!("references unknown character name or alias: {speaker}"),
                    );
                }
            }
            for (cue_index, cue) in beat.figure_cues.iter().enumerate() {
                let cue_path = format!("{beat_path}.figureCues[{cue_index}]");
                if !character_ids.contains(cue.character_id.as_str())
                    || !scene_cast.contains(cue.character_id.as_str())
                    || !crate::story_plan::types::is_webgal_flag_value(&cue.character_id)
                {
                    return invalid(
                        format!("{cue_path}.characterId"),
                        format!(
                            "references character outside this scene: {}",
                            cue.character_id
                        ),
                    );
                }
                if cue.action == crate::story_plan::FigureCueAction::Show {
                    if cue.position.is_none() {
                        return invalid(format!("{cue_path}.position"), "required for show cues");
                    }
                    if !crate::story_plan::types::is_webgal_flag_value(&cue.emotion) {
                        return invalid(format!("{cue_path}.emotion"), "must be a safe label");
                    }
                }
            }
        }
    }
    let mut asset_ids: HashSet<&str> = HashSet::new();
    for (index, asset) in plan.asset_plan.iter().enumerate() {
        let path = format!("$.assetPlan[{index}]");
        if !is_safe_token(&asset.id) || !asset_ids.insert(asset.id.as_str()) {
            return invalid(format!("{path}.id"), "must be a unique safe id");
        }
        if !matches!(asset.kind.as_str(), "background" | "figure" | "bgm" | "sfx") {
            return invalid(
                format!("{path}.kind"),
                "must be background, figure, bgm, or sfx",
            );
        }
        if asset.status != "pending" {
            return invalid(format!("{path}.status"), "must be pending");
        }
        if !is_safe_token(&asset.target_stem) {
            return invalid(format!("{path}.targetStem"), "must be a safe filename stem");
        }
        required(&format!("{path}.prompt"), &asset.prompt)?;
        if asset.kind == "figure" {
            if asset.character_ref.as_deref().is_none_or(str::is_empty) {
                return invalid(format!("{path}.characterRef"), "required for figure tasks");
            }
            if asset
                .emotion
                .as_deref()
                .is_some_and(|value| !is_safe_token(value))
            {
                return invalid(format!("{path}.emotion"), "must be a safe label");
            }
        } else if asset.emotion.is_some() {
            return invalid(format!("{path}.emotion"), "only allowed for figure tasks");
        }
        if let Some(scene) = &asset.scene_ref {
            if !scene_ids.contains(scene.as_str()) {
                return invalid(
                    format!("{path}.sceneRef"),
                    format!("references unknown scene: {scene}"),
                );
            }
        }
        if let Some(character) = &asset.character_ref {
            if !character_ids.contains(character.as_str()) {
                return invalid(
                    format!("{path}.characterRef"),
                    format!("references unknown character: {character}"),
                );
            }
        }
    }
    for (index, file) in plan.scenes.iter().enumerate() {
        if !is_safe_scene_file(file) {
            return invalid(format!("$.scenes[{index}]"), "must be a safe .txt filename");
        }
        if !scene_files.is_empty() && !scene_files.contains(file.as_str()) {
            return invalid(
                format!("$.scenes[{index}]"),
                format!("has no matching scene plan: {file}"),
            );
        }
    }
    for (index, scene) in plan.scene_plans.iter().enumerate() {
        if scene.approval_status == crate::story_plan::types::SceneApprovalStatus::Approved
            && (!plan.scenes.contains(&scene.file) || !draft_ids.contains(scene.id.as_str()))
        {
            return invalid(
                format!("$.scenePlans[{index}].approvalStatus"),
                "approved scenes require a compiled scene and dialogue draft",
            );
        }
    }
    Ok(())
}

fn required(path: &str, value: &str) -> Result<(), PlanError> {
    if value.trim().is_empty() {
        invalid(path, "must not be empty")
    } else {
        Ok(())
    }
}

fn invalid(path: impl AsRef<str>, message: impl AsRef<str>) -> Result<(), PlanError> {
    Err(PlanError::InvalidReference(format!(
        "{}: {}",
        path.as_ref(),
        message.as_ref()
    )))
}

fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn is_safe_scene_file(file: &str) -> bool {
    let stem = file.strip_suffix(".txt").unwrap_or("");
    !stem.is_empty()
        && stem
            .chars()
            .all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-')
        && std::path::Path::new(file)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(file)
}

pub(crate) fn is_safe_variable_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {
            chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        }
        _ => false,
    }
}

pub(crate) fn extract_condition_variables(condition: &str) -> Vec<String> {
    let mut vars = Vec::new();
    let mut current = String::new();
    for ch in condition.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            if !current.chars().next().unwrap().is_ascii_digit()
                && current != "true"
                && current != "false"
            {
                vars.push(current.clone());
            }
            current.clear();
        }
    }
    if !current.is_empty()
        && !current.chars().next().unwrap().is_ascii_digit()
        && current != "true"
        && current != "false"
    {
        vars.push(current);
    }
    vars.sort();
    vars.dedup();
    vars
}

pub(crate) fn is_safe_branch_expression(expression: &str) -> bool {
    if expression.trim().is_empty()
        || expression.contains([';', '\r', '\n'])
        || expression.split(" -").skip(1).any(|rest| {
            rest.chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        })
    {
        return false;
    }
    let mut quote = None;
    let mut escaped = false;
    for ch in expression.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if let Some(delimiter) = quote {
            if ch == '\\' {
                escaped = true;
            } else if ch == delimiter {
                quote = None;
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if !ch.is_ascii()
            || !(ch.is_ascii_alphanumeric()
                || ch.is_ascii_whitespace()
                || "_+-*/%().<>=!&|".contains(ch))
        {
            return false;
        }
    }
    quote.is_none() && !escaped
}

pub(crate) fn extract_effect_variable(effect: &str) -> Option<String> {
    if !is_safe_branch_expression(effect) {
        return None;
    }
    let (lhs, rhs) = effect.split_once('=')?;
    if rhs.trim().is_empty() || rhs.trim_start().starts_with('=') {
        return None;
    }
    let lhs = lhs.trim();
    let var = lhs.strip_suffix(['+', '-', '*', '/']).unwrap_or(lhs).trim();
    is_safe_variable_id(var).then(|| var.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlanError {
    UnsupportedVersion(u32),
    EmptyPlan,
    InvalidReference(String),
    InvalidJson(String),
    ReadFailed(String, String),
    WriteFailed(String, String),
    SerializeFailed(String),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::UnsupportedVersion(v) => {
                write!(
                    f,
                    "$.version: unsupported StoryPlan version {v} (expected 1)"
                )
            }
            PlanError::EmptyPlan => {
                write!(f, "$.prompt: prompt and synopsis cannot both be empty")
            }
            PlanError::InvalidReference(message) => {
                write!(f, "invalid StoryPlan reference: {}", message)
            }
            PlanError::InvalidJson(e) => write!(f, "plan.json is not valid JSON: {}", e),
            PlanError::ReadFailed(p, e) => write!(f, "failed to read {}: {}", p, e),
            PlanError::WriteFailed(p, e) => write!(f, "failed to write {}: {}", p, e),
            PlanError::SerializeFailed(e) => {
                write!(f, "failed to serialize StoryPlan: {}", e)
            }
        }
    }
}

impl std::error::Error for PlanError {}
