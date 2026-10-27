use ollaic_core::{
    archive, document,
    project::{self, SceneSource},
    Error,
};
use std::{
    fs,
    io::{Cursor, Write},
    path::Path,
};
use zip::write::SimpleFileOptions;

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn fixture(destination: &Path) {
    copy_tree(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/desktop-project"),
        destination,
    );
}

fn zip_bytes(files: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, source) in files {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(source.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn desktop_project_edit_export_import_preserves_opaque_files_and_script_text() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("desktop");
    fixture(&root);
    let original = project::load_workspace(&root).unwrap();
    let mut updated = original.document.clone();
    let start = updated
        .scenes
        .iter_mut()
        .find(|scene| scene.file_name == "start.txt")
        .unwrap();
    let lines = document::decode_lines(&start.source);
    let mut sources: Vec<_> = lines.iter().map(|line| line.source.clone()).collect();
    let dialogue = lines
        .iter()
        .position(|line| line.speaker == "Alice")
        .unwrap();
    sources[dialogue] =
        document::edit_line(&sources[dialogue], "Dialogue", "Alice", "Edited on Android").unwrap();
    start.source = document::assemble_lines(&sources);
    updated.notes = "Mobile writing notes".into();
    updated.editor_state = "{\"selectedScene\":\"start.txt\"}".into();
    project::save_workspace(&root, updated.clone(), &original.revision).unwrap();

    let archive_path = temporary.path().join("export.zip");
    let warnings = archive::export_project(&root, &archive_path).unwrap();
    assert!(warnings.iter().any(|warning| warning.contains("runtime")));
    let imported = temporary.path().join("imported");
    let info = archive::import_project(&archive_path, &imported).unwrap();
    assert_eq!(info.config["Game_name"], "Desktop Round Trip");
    assert_eq!(
        project::load_workspace(&imported).unwrap().document,
        updated
    );
    for relative in [
        "game/config.txt",
        "game/scene/chapter2.txt",
        "game/background/park.svg",
        "project-metadata.json",
        "story-plan.json",
        ".ollaic/memory.json",
    ] {
        assert_eq!(
            fs::read(root.join(relative)).unwrap(),
            fs::read(imported.join(relative)).unwrap(),
            "{relative}"
        );
    }
    let start = fs::read_to_string(imported.join("game/scene/start.txt")).unwrap();
    assert!(start.contains("Alice:Edited on Android -when=ready -v1.ogg; inline annotation"));
    assert!(start.contains("futureExtension:payload -custom=value;"));
    assert!(start.contains("choose:Continue:chapter2.txt|Stay:start.txt;"));
    assert!(ollaic_core::webgal::parser::parse_script(&start)
        .iter()
        .any(|node| node.content == "Edited on Android"));
}

#[test]
fn no_op_round_trip_preserves_whitespace_blank_lines_crlf_and_unknown_commands() {
    let source = "\u{feff}; header\r\n\r\n  Alice:  keep   spaces -custom=x; inline\r\nfutureCommand:raw;\nlast line without newline";
    let lines = document::decode_lines(source);
    assert_eq!(
        document::assemble_lines(
            &lines
                .iter()
                .map(|line| line.source.clone())
                .collect::<Vec<_>>()
        ),
        source
    );
    for line in lines {
        assert_eq!(
            document::edit_line(&line.source, &line.kind, &line.speaker, &line.text).unwrap(),
            line.source
        );
    }
    assert_eq!(
        document::assemble_lines(&["first;".into(), "second;\n".into()]),
        "first;\nsecond;\n"
    );
}

#[test]
fn conflicts_and_invalid_scene_names_leave_project_unchanged() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Project").unwrap();
    let original = project::load_workspace(&root).unwrap();
    let mut invalid = original.document.clone();
    invalid.scenes[0].file_name = "../config.txt".into();
    assert!(project::save_workspace(&root, invalid, &original.revision).is_err());
    assert_eq!(
        project::load_workspace(&root).unwrap().document,
        original.document
    );
    fs::write(root.join("game/scene/start.txt"), "External edit;\n").unwrap();
    assert!(matches!(
        project::save_workspace(&root, original.document, &original.revision),
        Err(Error::Conflict)
    ));
    assert_eq!(
        fs::read_to_string(root.join("game/scene/start.txt")).unwrap(),
        "External edit;\n"
    );
    assert!(!root.join(".ollaic/mobile-pending.json").exists());
}

#[test]
fn interrupted_multi_scene_save_is_completed_before_the_project_is_opened() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Project").unwrap();
    let mut updated = project::load_workspace(&root).unwrap().document;
    updated.scenes[0].source = "Alice:Committed edit;\n".into();
    updated.scenes.push(SceneSource {
        file_name: "next.txt".into(),
        source: "end:;\n".into(),
    });
    updated.notes = "Committed notes".into();
    updated.scenes.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    fs::write(
        root.join(".ollaic/mobile-pending.json"),
        serde_json::to_vec(&serde_json::json!({"previous_files":["start.txt"],"document":updated}))
            .unwrap(),
    )
    .unwrap();
    fs::write(root.join("game/scene/start.txt"), "Alice:Committed edit;\n").unwrap();
    let info = project::open_project(&root).unwrap();
    assert_eq!(info.scenes, vec!["next.txt", "start.txt"]);
    assert_eq!(project::load_workspace(&root).unwrap().document, updated);
    assert!(!root.join(".ollaic/mobile-pending.json").exists());
}

#[test]
fn case_only_scene_rename_preserves_source_and_saved_revision() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Case rename").unwrap();
    fs::write(root.join("game/scene/chapter.txt"), "Alice:Original;\n").unwrap();
    let snapshot = project::load_workspace(&root).unwrap();
    let mut updated = snapshot.document;
    let scene = updated
        .scenes
        .iter_mut()
        .find(|scene| scene.file_name == "chapter.txt")
        .unwrap();
    scene.file_name = "Chapter.txt".into();
    scene.source = "Alice:Renamed;\n".into();
    updated.scenes.sort_by(|a, b| a.file_name.cmp(&b.file_name));

    let revision = project::save_workspace(&root, updated.clone(), &snapshot.revision).unwrap();
    let restored = project::load_workspace(&root).unwrap();
    assert_eq!(restored.document, updated);
    assert_eq!(restored.revision, revision);
    assert!(fs::read_dir(root.join("game/scene"))
        .unwrap()
        .any(|entry| entry.unwrap().file_name() == "Chapter.txt"));
    assert_eq!(
        project::save_workspace(&root, updated, &revision).unwrap(),
        revision
    );
}

#[test]
fn interrupted_case_only_rename_recovers_a_published_replacement() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Case recovery").unwrap();
    fs::write(root.join("game/scene/chapter.txt"), "Alice:Original;\n").unwrap();
    let mut updated = project::load_workspace(&root).unwrap().document;
    let scene = updated
        .scenes
        .iter_mut()
        .find(|scene| scene.file_name == "chapter.txt")
        .unwrap();
    scene.file_name = "Chapter.txt".into();
    scene.source = "Alice:Recovered;\n".into();
    updated.scenes.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    fs::write(
        root.join(".ollaic/mobile-pending.json"),
        serde_json::to_vec(&serde_json::json!({
            "previous_files": ["chapter.txt", "start.txt"], "document": updated,
        }))
        .unwrap(),
    )
    .unwrap();
    fs::rename(
        root.join("game/scene/chapter.txt"),
        root.join("game/scene/Chapter.txt"),
    )
    .unwrap();
    fs::write(root.join("game/scene/Chapter.txt"), "Alice:Recovered;\n").unwrap();

    assert_eq!(project::load_workspace(&root).unwrap().document, updated);
    assert_eq!(project::load_workspace(&root).unwrap().document, updated);
    assert!(!root.join(".ollaic/mobile-pending.json").exists());
}

#[test]
fn archive_import_rejects_unsafe_ambiguous_and_duplicate_files_without_partial_projects() {
    let temporary = tempfile::tempdir().unwrap();
    for (index, files) in [
        vec![("../outside", "bad")],
        vec![("/absolute", "bad")],
        vec![("game\\escape", "bad")],
        vec![("C:/escape", "bad")],
        vec![
            ("game/config.txt", "Game_name:Invalid;"),
            ("game/scene/start.txt", "Hello;"),
            ("project-metadata.json", "{"),
        ],
        vec![
            ("one/game/config.txt", ""),
            ("one/game/scene/start.txt", ""),
            ("two/game/config.txt", ""),
            ("two/game/scene/start.txt", ""),
        ],
    ]
    .iter()
    .enumerate()
    {
        let archive_path = temporary.path().join(format!("invalid-{index}.zip"));
        fs::write(&archive_path, zip_bytes(files)).unwrap();
        let target = temporary.path().join(format!("project-{index}"));
        assert!(archive::import_project(&archive_path, &target).is_err());
        assert!(!target.exists());
    }
    let mut duplicate = zip_bytes(&[("entry-a", "first"), ("entry-b", "second")]);
    for index in 0..duplicate.len().saturating_sub(6) {
        if &duplicate[index..index + 7] == b"entry-b" {
            duplicate[index + 6] = b'a';
        }
    }
    let duplicate_path = temporary.path().join("duplicate.zip");
    fs::write(&duplicate_path, duplicate).unwrap();
    assert!(archive::import_project(&duplicate_path, &temporary.path().join("duplicate")).is_err());
    assert!(!temporary.path().join("duplicate").exists());
    assert!(!temporary.path().join("outside").exists());
    assert!(!fs::read_dir(temporary.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".import-")));
}

#[test]
fn metadata_updates_preserve_desktop_extensions_and_config_comments() {
    let temporary = tempfile::tempdir().unwrap();
    fixture(temporary.path());
    project::update_metadata(temporary.path(), "Renamed", "Updated synopsis").unwrap();
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(temporary.path().join("project-metadata.json")).unwrap())
            .unwrap();
    assert_eq!(metadata["unknownField"]["keep"], true);
    assert_eq!(metadata["synopsis"], "Updated synopsis");
    serde_json::from_value::<project::ProjectMetadata>(metadata).unwrap();
    let config = fs::read_to_string(temporary.path().join("game/config.txt")).unwrap();
    assert!(config.contains("; Desktop project fixture\n"));
    assert!(config.contains("Custom_setting:preserve-me;"));
    assert_eq!(
        project::open_project(temporary.path()).unwrap().config["Game_name"],
        "Renamed"
    );
}

#[test]
fn native_project_metadata_uses_the_complete_desktop_schema() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Native project").unwrap();
    project::update_metadata(&root, "Native project", "Synopsis").unwrap();
    let metadata: project::ProjectMetadata =
        serde_json::from_slice(&fs::read(root.join("project-metadata.json")).unwrap()).unwrap();
    assert_eq!(metadata.synopsis, "Synopsis");
    assert_eq!(metadata.description, "");
    assert_eq!(metadata.cover_path, "");
    assert!(metadata.tags.is_empty());
    assert_eq!(metadata.last_export_dir, "");
}

#[test]
fn scene_reference_rename_preserves_unrelated_text_and_flags() {
    let source =
        "changeScene:next.txt -next; comment\r\ncallScene:next.txt;\nAlice:next.txt;\n; next.txt\n";
    assert_eq!(document::rename_scene_references(source, "next.txt", "chapter.txt"), "changeScene:chapter.txt -next; comment\r\ncallScene:chapter.txt;\nAlice:next.txt;\n; next.txt\n");
}

#[test]
fn scene_rename_updates_choice_targets_with_spaces_without_editing_choice_labels() {
    let source = "choose:next scene.txt:next scene.txt|Stay:start.txt -next; comment\n";
    assert_eq!(
        document::rename_scene_references(source, "next scene.txt", "chapter.txt"),
        "choose:next scene.txt:chapter.txt|Stay:start.txt -next; comment\n"
    );
}

#[test]
fn scene_reference_rename_escapes_new_targets_and_matches_escaped_old_targets() {
    let source = "  changeScene: old.txt -next; keep\r\ncallScene:old.txt;\nchoose:Go:old.txt|Stay:start.txt -when=ready; comment\nAlice:old.txt;\n";
    let escaped = document::rename_scene_references(source, "old.txt", "part;2| -next.txt");
    assert_eq!(escaped, "  changeScene: part\\;2\\| \\-next.txt -next; keep\r\ncallScene:part\\;2\\| \\-next.txt;\nchoose:Go:part\\;2\\| \\-next.txt|Stay:start.txt -when=ready; comment\nAlice:old.txt;\n");
    let restored = document::rename_scene_references(&escaped, "part;2| -next.txt", "old.txt");
    assert_eq!(restored, source);
    assert_eq!(
        document::rename_scene_references(&escaped, "part;2| -next.txt", "part;2| -next.txt"),
        escaped
    );
}

#[test]
fn legacy_multiline_text_and_literal_delimiters_are_encoded_as_webgal_dialogue() {
    let rendered = document::edit_line(
        "",
        "Dialogue",
        "Dr:Alice",
        "Hello; world\nA -next token and C:\\folder",
    )
    .unwrap();
    let lines = document::decode_lines(&rendered);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].speaker, "Dr:Alice");
    assert_eq!(lines[0].text, "Hello; world");
    assert_eq!(lines[1].text, "A -next token and C:\\folder");
    let nodes = ollaic_core::webgal::parser::parse_script(&rendered);
    assert!(nodes[0].content.contains("world"));
    assert_eq!(nodes[1].next, None);
}

#[test]
fn unchanged_paragraphs_keep_each_lines_flags_comments_and_whitespace() {
    let source =
        "Alice:First -when=ready; first comment\r\n\r\nAlice:Second -v2.ogg; second comment\r\n";
    assert_eq!(
        document::edit_line(source, "Dialogue", "Alice", "First\n\nSecond").unwrap(),
        source
    );
    assert!(!document::edit_line(source, "Dialogue", "Alice", "First")
        .unwrap()
        .contains("Second"));
}

#[test]
fn multiline_engine_statements_remain_one_raw_editable_entry() {
    let source = "changeFigure:hero.webp\n  -left\n  -id=hero;\nAlice:Hello;\n";
    let lines = document::decode_lines(source);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].kind, "Command");
    assert_eq!(
        document::assemble_lines(
            &lines
                .into_iter()
                .map(|line| line.source)
                .collect::<Vec<_>>()
        ),
        source
    );
}

#[test]
fn assets_import_without_overwriting_existing_files_or_escaping_the_project() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Project").unwrap();
    let source = temporary.path().join("picture.png");
    fs::write(&source, b"asset fixture").unwrap();
    let asset =
        ollaic_core::assets::import_asset(&root, &source, "background", "picture.png").unwrap();
    assert_eq!(asset.size, 13);
    assert_eq!(ollaic_core::assets::list_assets(&root).unwrap().len(), 1);
    fs::write(&source, b"replacement").unwrap();
    assert!(
        ollaic_core::assets::import_asset(&root, &source, "background", "picture.png").is_err()
    );
    assert!(
        ollaic_core::assets::import_asset(&root, &source, "../outside", "picture.png").is_err()
    );
    assert!(ollaic_core::assets::import_asset(&root, &source, "background", "../outside").is_err());
    assert_eq!(
        fs::read(root.join("game/background/picture.png")).unwrap(),
        b"asset fixture"
    );
}

#[test]
fn asset_commands_escape_literal_names_and_export_reports_missing_references() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Assets").unwrap();
    let source = temporary.path().join("asset");
    fs::write(&source, b"asset bytes").unwrap();
    ollaic_core::assets::import_asset(&root, &source, "background", "park;next.png").unwrap();
    let command = ollaic_core::assets::asset_command("background", "park;next.png").unwrap();
    assert!(command.contains("park\\;next.png"));
    fs::write(
        root.join("game/scene/start.txt"),
        format!("{command}bgm:missing.ogg;\n"),
    )
    .unwrap();
    let warnings = archive::export_project(&root, &temporary.path().join("assets.zip")).unwrap();
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("missing bgm/missing.ogg")));
    assert!(!warnings
        .iter()
        .any(|warning| warning.contains("missing background")));
}

#[test]
fn oversized_imported_metadata_scripts_and_pending_state_are_rejected_before_reading() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Bounded project").unwrap();
    let config = root.join("game/config.txt");
    fs::OpenOptions::new()
        .write(true)
        .open(&config)
        .unwrap()
        .set_len(4 * 1024 * 1024 + 1)
        .unwrap();
    assert!(project::open_project(&root).is_err());
    fs::write(
        config,
        "Game_name:Bounded project;\nEnable_Appreciation:true;\n",
    )
    .unwrap();
    let scene = root.join("game/scene/start.txt");
    fs::OpenOptions::new()
        .write(true)
        .open(&scene)
        .unwrap()
        .set_len(project::MAX_SCRIPT_BYTES + 1)
        .unwrap();
    assert!(project::load_workspace(&root).is_err());
    fs::write(&scene, "Retained source;\n").unwrap();
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    fs::File::create(root.join(".ollaic/mobile-pending.json"))
        .unwrap()
        .set_len(project::MAX_SCRIPT_BYTES + 1)
        .unwrap();
    assert!(project::open_project(&root).is_err());
    assert_eq!(fs::read_to_string(scene).unwrap(), "Retained source;\n");
}

#[cfg(unix)]
#[test]
fn archive_import_and_export_reject_symbolic_links() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    project::create_project(&root, "Project").unwrap();
    std::os::unix::fs::symlink("/etc/passwd", root.join("game/background/link")).unwrap();
    assert!(archive::export_project(&root, &temporary.path().join("export.zip")).is_err());
    assert!(!temporary.path().join("export.zip").exists());
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink("game/link", "../../outside", SimpleFileOptions::default())
        .unwrap();
    let archive_path = temporary.path().join("symlink.zip");
    fs::write(&archive_path, writer.finish().unwrap().into_inner()).unwrap();
    assert!(archive::import_project(&archive_path, &temporary.path().join("imported")).is_err());
}
