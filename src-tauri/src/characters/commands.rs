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
    fs::write(&path, json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
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
    let doc = load_doc(&project_path)?;
    let mut seen = std::collections::HashSet::new();
    let mut deduped: Vec<Character> = Vec::new();
    for ch in doc.characters.into_iter().rev() {
        if seen.insert(ch.id.clone()) {
            deduped.push(ch);
        }
    }
    deduped.reverse();
    Ok(deduped)
}

/// Get a single character by id.
#[tauri::command]
pub fn get_character(project_path: String, id: String) -> Result<Character, String> {
    let doc = load_doc(&project_path)?;
    doc.characters
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("Character not found: {id}"))
}

/// Create a new character and persist.
#[tauri::command]
pub fn create_character(project_path: String, character: Character) -> Result<Character, String> {
    let mut doc = load_doc(&project_path)?;
    let mut new_char = character;
    // Always assign a server-generated id so temp frontend ids never leak into storage.
    new_char.id = make_id();
    doc.characters.push(new_char.clone());
    save_doc(&project_path, &doc)?;
    Ok(new_char)
}

/// Update an existing character by id.
#[tauri::command]
pub fn update_character(project_path: String, character: Character) -> Result<Character, String> {
    let mut doc = load_doc(&project_path)?;
    let idx = doc
        .characters
        .iter()
        .position(|c| c.id == character.id)
        .ok_or_else(|| format!("Character not found: {}", character.id))?;
    doc.characters[idx] = character.clone();
    save_doc(&project_path, &doc)?;
    Ok(character)
}

/// Delete a character by id.
#[tauri::command]
pub fn delete_character(project_path: String, id: String) -> Result<(), String> {
    let mut doc = load_doc(&project_path)?;
    doc.characters.retain(|c| c.id != id);
    save_doc(&project_path, &doc)?;
    Ok(())
}

/// Return a lightweight list of {id, name} pairs for dropdowns.
#[tauri::command]
pub fn list_character_names(project_path: String) -> Result<Vec<CharacterRef>, String> {
    let doc = load_doc(&project_path)?;
    Ok(doc
        .characters
        .into_iter()
        .map(|c| CharacterRef {
            id: c.id,
            name: c.name,
        })
        .collect())
}

/// Bulk-save the entire character list (used after re-ordering or batch edits).
#[tauri::command]
pub fn save_characters(project_path: String, characters: Vec<Character>) -> Result<(), String> {
    let doc = CharactersDocument {
        version: 1,
        characters,
    };
    save_doc(&project_path, &doc)
}
