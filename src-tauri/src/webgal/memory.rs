use super::project::{read_project_memory_locked, save_project_memory_locked, ProjectMemory};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MemoryCategory {
    World,
    Character,
    Plot,
    Style,
    Preference,
    Constraint,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MemorySource {
    User,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub category: MemoryCategory,
    pub content: String,
    pub enabled: bool,
    pub source: MemorySource,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryPatch {
    pub category: Option<MemoryCategory>,
    pub content: Option<String>,
    pub enabled: Option<bool>,
}

fn migrate(memory: &mut ProjectMemory) {
    if memory.entries.is_some() {
        return;
    }
    memory.entries = Some(
        [
            ("worldSetting", MemoryCategory::World, &memory.world_setting),
            ("writingStyle", MemoryCategory::Style, &memory.writing_style),
            (
                "userPreferences",
                MemoryCategory::Preference,
                &memory.user_preferences,
            ),
        ]
        .into_iter()
        .filter(|(_, _, content)| !content.trim().is_empty())
        .map(|(field, category, content)| MemoryEntry {
            id: format!("legacy-{field}"),
            category,
            content: content.clone(),
            enabled: true,
            source: MemorySource::User,
            created_at: memory.updated_at.clone(),
            updated_at: memory.updated_at.clone(),
        })
        .collect(),
    );
}

fn content(value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() || value.chars().count() > 4000 {
        return Err("记忆内容须为 1 到 4000 个字符。".into());
    }
    Ok(value)
}

fn check_revision(entry: &MemoryEntry, expected: Option<&str>) -> Result<(), String> {
    if expected.is_some_and(|revision| revision != entry.updated_at) {
        return Err("这条记忆已被修改，请刷新后重试。".into());
    }
    Ok(())
}

fn mutate(
    project_path: &str,
    operation: impl FnOnce(&mut Vec<MemoryEntry>, &str) -> Result<(), String>,
) -> Result<ProjectMemory, String> {
    crate::project_lock::with_project_lock(Path::new(project_path), || {
        let mut memory = read_project_memory_locked(project_path)?.unwrap_or(ProjectMemory {
            world_setting: String::new(),
            writing_style: String::new(),
            user_preferences: String::new(),
            updated_at: String::new(),
            entries: None,
        });
        migrate(&mut memory);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let revision = now
            .max(memory.updated_at.parse::<u128>().unwrap_or(0) + 1)
            .to_string();
        let entries = memory.entries.as_mut().unwrap();
        operation(entries, &revision)?;
        // Keep legacy readers working without resurrecting deleted/disabled entries.
        let summary = |category| {
            entries
                .iter()
                .filter(|entry| entry.enabled && entry.category == category)
                .map(|entry| entry.content.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        };
        memory.world_setting = summary(MemoryCategory::World);
        memory.writing_style = summary(MemoryCategory::Style);
        memory.user_preferences = summary(MemoryCategory::Preference);
        memory.updated_at = revision;
        save_project_memory_locked(project_path, memory.clone())?;
        Ok(memory)
    })
}

#[tauri::command]
pub fn add_project_memory_entry(
    project_path: String,
    category: MemoryCategory,
    content: String,
    source: MemorySource,
) -> Result<ProjectMemory, String> {
    let content = self::content(content)?;
    mutate(&project_path, |entries, revision| {
        if entries
            .iter()
            .any(|entry| entry.category == category && entry.content == content)
        {
            return Ok(());
        }
        entries.push(MemoryEntry {
            id: format!("memory-{revision}"),
            category,
            content,
            enabled: true,
            source,
            created_at: revision.into(),
            updated_at: revision.into(),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn update_project_memory_entry(
    project_path: String,
    id: String,
    patch: MemoryPatch,
    source: MemorySource,
    expected_updated_at: Option<String>,
) -> Result<ProjectMemory, String> {
    let content = patch.content.map(self::content).transpose()?;
    if content.is_none() && patch.category.is_none() && patch.enabled.is_none() {
        return Err("没有提供要更新的记忆字段。".into());
    }
    mutate(&project_path, |entries, revision| {
        let entry = entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or("这条记忆已不存在，请刷新后重试。")?;
        check_revision(entry, expected_updated_at.as_deref())?;
        if let Some(content) = content {
            entry.content = content;
        }
        if let Some(category) = patch.category {
            entry.category = category;
        }
        if let Some(enabled) = patch.enabled {
            entry.enabled = enabled;
        }
        entry.source = source;
        entry.updated_at = revision.into();
        Ok(())
    })
}

#[tauri::command]
pub fn delete_project_memory_entry(
    project_path: String,
    id: String,
    expected_updated_at: Option<String>,
) -> Result<ProjectMemory, String> {
    mutate(&project_path, |entries, _| {
        let entry = entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or("这条记忆已不存在，请刷新后重试。")?;
        check_revision(entry, expected_updated_at.as_deref())?;
        entries.retain(|entry| entry.id != id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::super::project::{read_project_memory, save_project_memory};
    use super::*;

    fn project() -> String {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("ollaic_memory_{}_{nonce}", std::process::id()));
        std::fs::create_dir_all(root.join("game")).unwrap();
        root.to_string_lossy().into_owned()
    }

    fn patch(content: Option<&str>, enabled: Option<bool>) -> MemoryPatch {
        MemoryPatch {
            category: None,
            content: content.map(str::to_string),
            enabled,
        }
    }

    #[test]
    fn migrates_legacy_without_losing_fields_and_keeps_deletions_after_reload() {
        let root = project();
        let old: ProjectMemory = serde_json::from_value(serde_json::json!({
            "worldSetting": "校园", "writingStyle": "简洁", "userPreferences": "",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();
        save_project_memory(root.clone(), old).unwrap();
        assert!(read_project_memory(root.clone())
            .unwrap()
            .unwrap()
            .entries
            .is_none());
        let memory = add_project_memory_entry(
            root.clone(),
            MemoryCategory::Plot,
            "主角刚转学".into(),
            MemorySource::Agent,
        )
        .unwrap();
        let entries = memory.entries.unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].id, "legacy-worldSetting");
        assert_eq!(memory.world_setting, "校园");
        assert_eq!(memory.writing_style, "简洁");
        for entry in entries {
            delete_project_memory_entry(root.clone(), entry.id, Some(entry.updated_at)).unwrap();
        }
        let memory = read_project_memory(root).unwrap().unwrap();
        assert!(memory.entries.unwrap().is_empty());
        assert!(memory.world_setting.is_empty());
        assert!(memory.writing_style.is_empty());
    }

    #[test]
    fn updating_one_entry_preserves_other_entries_and_rejects_stale_writes() {
        let root = project();
        let memory = add_project_memory_entry(
            root.clone(),
            MemoryCategory::World,
            "校园".into(),
            MemorySource::User,
        )
        .unwrap();
        let original = memory.entries.unwrap().remove(0);
        add_project_memory_entry(
            root.clone(),
            MemoryCategory::Preference,
            "慢节奏".into(),
            MemorySource::User,
        )
        .unwrap();
        let next = update_project_memory_entry(
            root.clone(),
            original.id.clone(),
            patch(Some("海边校园"), None),
            MemorySource::Agent,
            Some(original.updated_at.clone()),
        )
        .unwrap();
        assert_eq!(next.entries.as_ref().unwrap().len(), 2);
        assert_eq!(next.user_preferences, "慢节奏");
        assert_eq!(next.world_setting, "海边校园");
        assert_eq!(
            next.entries.as_ref().unwrap()[0].source,
            MemorySource::Agent
        );
        assert!(update_project_memory_entry(
            root.clone(),
            original.id.clone(),
            patch(Some("过期修改"), None),
            MemorySource::User,
            Some(original.updated_at.clone())
        )
        .is_err());
        assert!(
            delete_project_memory_entry(root.clone(), original.id, Some(original.updated_at))
                .is_err()
        );
        let stored = read_project_memory(root).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(stored).unwrap(),
            serde_json::to_value(next).unwrap()
        );
    }

    #[test]
    fn duplicate_add_does_not_reenable_disabled_memory() {
        let root = project();
        let memory = add_project_memory_entry(
            root.clone(),
            MemoryCategory::Style,
            "简洁".into(),
            MemorySource::User,
        )
        .unwrap();
        let entry = memory.entries.unwrap().remove(0);
        update_project_memory_entry(
            root.clone(),
            entry.id,
            patch(None, Some(false)),
            MemorySource::User,
            Some(entry.updated_at),
        )
        .unwrap();
        let memory = add_project_memory_entry(
            root,
            MemoryCategory::Style,
            " 简洁 ".into(),
            MemorySource::Agent,
        )
        .unwrap();
        assert!(memory.writing_style.is_empty());
        let entries = memory.entries.unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].enabled);
        assert_eq!(entries[0].source, MemorySource::User);
    }

    #[test]
    fn concurrent_adds_are_merged_under_project_lock() {
        let root = project();
        let threads = (0..8)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || {
                    add_project_memory_entry(
                        root,
                        MemoryCategory::Plot,
                        format!("事实 {index}"),
                        MemorySource::Agent,
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        let memory = read_project_memory(root).unwrap().unwrap();
        let entries = memory.entries.unwrap();
        assert_eq!(entries.len(), 8);
        let ids = entries
            .iter()
            .map(|entry| &entry.id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 8);
    }

    #[test]
    fn invalid_operations_leave_storage_unchanged() {
        let root = project();
        assert!(add_project_memory_entry(
            root.clone(),
            MemoryCategory::World,
            " ".into(),
            MemorySource::Agent
        )
        .is_err());
        assert!(add_project_memory_entry(
            root.clone(),
            MemoryCategory::World,
            "a".repeat(4001),
            MemorySource::Agent
        )
        .is_err());
        assert!(update_project_memory_entry(
            root.clone(),
            "missing".into(),
            patch(Some("内容"), None),
            MemorySource::Agent,
            None
        )
        .is_err());
        assert!(delete_project_memory_entry(root.clone(), "missing".into(), None).is_err());
        assert!(read_project_memory(root).unwrap().is_none());
    }
}
