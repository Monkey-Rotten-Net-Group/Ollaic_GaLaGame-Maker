use super::types::*;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn characters_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join("game")
        .join("config")
        .join("characters.json")
}

fn load_doc(project_path: &str) -> Result<CharactersDocument, String> {
    let path = characters_path(project_path);
    if !path.exists() {
        return Ok(CharactersDocument::default());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse characters.json: {}", e))
}

fn save_doc(project_path: &str, doc: &CharactersDocument) -> Result<(), String> {
    let path = characters_path(project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    crate::json_store::write_crash_safe(&path, json.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn deduplicate_characters(characters: Vec<Character>) -> Vec<Character> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::new();
    for character in characters.into_iter().rev() {
        if seen.insert(character.id.clone()) {
            deduped.push(character);
        }
    }
    deduped.reverse();
    deduped
}

fn load_canonical_doc(project_path: &str) -> Result<CharactersDocument, String> {
    let mut doc = load_doc(project_path)?;
    doc.characters = deduplicate_characters(doc.characters);
    Ok(doc)
}

fn make_id() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("char_{:x}", d.as_nanos())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// List all characters in the project, deduplicated by id (keeps the last,
/// most complete entry).
#[tauri::command]
pub fn list_characters(project_path: String) -> Result<Vec<Character>, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || list_characters_locked(&project_path))
}

pub(crate) fn list_characters_locked(project_path: &str) -> Result<Vec<Character>, String> {
    Ok(load_canonical_doc(project_path)?.characters)
}

/// Get a single character by id.
#[tauri::command]
pub fn get_character(project_path: String, id: String) -> Result<Character, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        list_characters_locked(&project_path)?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("Character not found: {id}"))
    })
}

/// Create a new character and persist.
#[tauri::command]
pub fn create_character(project_path: String, character: Character) -> Result<Character, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        crate::flow_edit_lock::ensure_editable(
            &root,
            crate::flow_edit_lock::FlowResource::Characters,
        )?;
        create_character_locked(&project_path, character)
    })
}

pub(crate) fn create_character_locked(
    project_path: &str,
    character: Character,
) -> Result<Character, String> {
    let mut doc = load_canonical_doc(project_path)?;
    let mut new_char = character;
    // Always assign a server-generated id so temp frontend ids never leak into storage.
    new_char.id = make_id();
    doc.characters.push(new_char.clone());
    save_doc(project_path, &doc)?;
    Ok(new_char)
}

/// Update an existing character by id.
#[tauri::command]
pub fn update_character(project_path: String, character: Character) -> Result<Character, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        crate::flow_edit_lock::ensure_editable(
            &root,
            crate::flow_edit_lock::FlowResource::Characters,
        )?;
        update_character_locked(&project_path, character)
    })
}

pub(crate) fn update_character_locked(
    project_path: &str,
    character: Character,
) -> Result<Character, String> {
    let mut doc = load_canonical_doc(project_path)?;
    let idx = doc
        .characters
        .iter()
        .position(|c| c.id == character.id)
        .ok_or_else(|| format!("Character not found: {}", character.id))?;
    doc.characters[idx] = character.clone();
    save_doc(project_path, &doc)?;
    Ok(character)
}

/// Delete a character by id.
#[tauri::command]
pub fn delete_character(project_path: String, id: String) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        crate::flow_edit_lock::ensure_editable(
            &root,
            crate::flow_edit_lock::FlowResource::Characters,
        )?;
        delete_character_locked(&project_path, &id)
    })
}

pub(crate) fn delete_character_locked(project_path: &str, id: &str) -> Result<(), String> {
    let mut doc = load_canonical_doc(project_path)?;
    doc.characters.retain(|c| c.id != id);
    save_doc(project_path, &doc)?;
    Ok(())
}

/// Return a lightweight list of {id, name} pairs for dropdowns.
#[tauri::command]
pub fn list_character_names(project_path: String) -> Result<Vec<CharacterRef>, String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        Ok(list_characters_locked(&project_path)?
            .into_iter()
            .map(|c| CharacterRef {
                id: c.id,
                name: c.name,
            })
            .collect())
    })
}

/// Bulk-save the entire character list (used after re-ordering or batch edits).
#[tauri::command]
pub fn save_characters(project_path: String, characters: Vec<Character>) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    crate::project_lock::with_project_lock(&root, || {
        crate::flow_edit_lock::ensure_editable(
            &root,
            crate::flow_edit_lock::FlowResource::Characters,
        )?;
        save_characters_locked(&project_path, characters)
    })
}

pub(crate) fn save_characters_locked(
    project_path: &str,
    characters: Vec<Character>,
) -> Result<(), String> {
    let doc = CharactersDocument {
        version: 1,
        characters: deduplicate_characters(characters),
    };
    save_doc(project_path, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn character(id: &str, name: &str) -> Character {
        Character {
            id: id.to_string(),
            name: name.to_string(),
            aliases: Vec::new(),
            description: String::new(),
            personality: String::new(),
            reference_images: Vec::new(),
            stance: String::new(),
            keywords: Vec::new(),
            dialogue_style: String::new(),
            gender: String::new(),
            age: String::new(),
            sprites: Vec::new(),
            default_voice: None,
            voice_timbre: None,
            relations: Vec::new(),
            color_theme: None,
            notes: String::new(),
        }
    }

    #[test]
    fn all_character_reads_use_the_same_canonical_entries() {
        let tmp = std::env::temp_dir().join("webgal_test_characters_canonical");
        let _ = fs::remove_dir_all(&tmp);
        save_doc(
            tmp.to_str().unwrap(),
            &CharactersDocument {
                version: 1,
                characters: vec![character("hero", "Old"), character("hero", "Current")],
            },
        )
        .unwrap();

        let project = tmp.to_string_lossy().to_string();
        let listed = list_characters(project.clone()).unwrap();
        let single = get_character(project.clone(), "hero".to_string()).unwrap();
        let names = list_character_names(project).unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Current");
        assert_eq!(single.name, "Current");
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].name, "Current");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn active_flow_character_scope_rejects_user_mutation_until_released() {
        let tmp = std::env::temp_dir().join("ollaic_character_flow_lock_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("game/config")).unwrap();
        let project = tmp.to_string_lossy().to_string();
        save_characters(project.clone(), vec![character("hero", "Old Hero")]).unwrap();

        let guard = crate::flow_edit_lock::FlowEditGuard::acquire(
            &tmp,
            &[crate::flow_edit_lock::FlowResource::Characters],
        )
        .unwrap();
        let error = update_character(project.clone(), character("hero", "New Hero")).unwrap_err();
        assert!(error.contains("Agent Flow 正在使用角色资料"));
        assert_eq!(
            list_characters(project.clone()).unwrap()[0].name,
            "Old Hero"
        );

        drop(guard);
        update_character(project.clone(), character("hero", "New Hero")).unwrap();
        assert_eq!(list_characters(project).unwrap()[0].name, "New Hero");
        let _ = std::fs::remove_dir_all(tmp);
    }
}
