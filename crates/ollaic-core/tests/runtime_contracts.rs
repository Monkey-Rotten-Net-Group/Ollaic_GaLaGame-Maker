use ollaic_core::{asset_operations as operations, assets, editor, project};
use serde_json::{json, Value};
use std::fs;

fn table(root: &std::path::Path) -> Vec<String> {
    serde_json::from_slice(&fs::read(root.join("game/animation/animationTable.json")).unwrap())
        .unwrap()
}

#[test]
fn title_comments_and_url_encoded_names_remain_referenced_after_rename() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Title contract").unwrap();
    let source = "; header\r\nGame_name:Title contract;\r\nTitle_img:old.png; title background\r\nTitle_bgm:theme.ogg; title music\r\nEnable_Appreciation:true;\r\n";
    fs::write(root.join("game/config.txt"), source).unwrap();
    fs::write(root.join("game/background/old.png"), b"image").unwrap();
    fs::write(root.join("game/bgm/theme.ogg"), b"audio").unwrap();
    let revision = project::load_workspace(&root).unwrap().revision;
    assert_eq!(
        operations::asset_usages(&root, "background", "old.png")
            .unwrap()
            .len(),
        1
    );
    assert!(operations::delete_asset(&root, "background", "old.png", &revision).is_err());
    assert!(operations::delete_asset(&root, "bgm", "theme.ogg", &revision).is_err());
    operations::rename_asset(
        &root,
        "background",
        "old.png",
        "part;2| -title#100%.png",
        &revision,
    )
    .unwrap();
    let changed = fs::read_to_string(root.join("game/config.txt")).unwrap();
    assert_eq!(
        changed,
        source.replace("old.png", "part%3B2%7C%20-title%23100%25.png")
    );
    assert_eq!(
        project::open_project(&root).unwrap().config["Title_img"],
        "part%3B2%7C%20-title%23100%25.png"
    );
    assert_eq!(
        operations::asset_usages(&root, "background", "part;2| -title#100%.png")
            .unwrap()
            .len(),
        1
    );
    assert!(
        operations::delete_asset(&root, "background", "part;2| -title#100%.png", &revision)
            .is_err()
    );
}

#[test]
fn resource_commands_use_url_paths_and_keep_physical_names_in_editor_fields() {
    let name = "folder/new -park;|#?100%20.png";
    let encoded = "folder/new%20-park%3B%7C%23%3F100%2520.png";
    assert_eq!(
        assets::asset_command("background", name).unwrap(),
        format!("changeBg:{encoded};\n")
    );
    for kind in [
        editor::EditKind::ChangeBg,
        editor::EditKind::ChangeFigure,
        editor::EditKind::Bgm,
        editor::EditKind::PlayEffect,
        editor::EditKind::PlayVideo,
    ] {
        let mut edit = editor::new_command(kind);
        edit.asset = name.into();
        let rendered = editor::edit_command("", &edit).unwrap();
        assert!(rendered.contains(encoded), "{rendered}");
        assert!(!rendered.contains('\\'), "{rendered}");
        assert_eq!(editor::read_command(&rendered).unwrap(), edit);
        assert_eq!(editor::edit_command(&rendered, &edit).unwrap(), rendered);
        let nodes = ollaic_core::webgal::parser::parse_script(&rendered);
        assert_eq!(nodes[0].asset.as_deref(), Some(name));
        let desktop_saved = ollaic_core::webgal::serializer::serialize_script(&nodes);
        assert_eq!(editor::read_command(&desktop_saved).unwrap().asset, name);
    }
    let mut scene = editor::new_command(editor::EditKind::ChangeScene);
    scene.scene = "part;2| -next.txt".into();
    assert_eq!(
        editor::edit_command("", &scene).unwrap(),
        "changeScene:part%3B2%7C%20-next.txt;\n"
    );
    let mut dialogue = editor::new_command(editor::EditKind::Dialogue);
    dialogue.content = "Hello".into();
    dialogue.voice = "new -voice;100%.ogg".into();
    let rendered = editor::edit_command("", &dialogue).unwrap();
    assert!(rendered.contains("-vocal=./game/vocal/new%20-voice%3B100%25.ogg"));
    assert_eq!(
        editor::read_command(&rendered).unwrap().voice,
        dialogue.voice
    );
}

#[test]
fn external_resource_urls_preserve_reserved_characters_through_editor_and_ast_saves() {
    for url in [
        "https://example.invalid/image;part.png?token=a;b%3Bc&key=value#fragment",
        "http://example.invalid/media%20name;part.ogg?token=%25;keep=1",
    ] {
        for kind in [
            editor::EditKind::ChangeBg,
            editor::EditKind::PlayEffect,
            editor::EditKind::PlayVideo,
        ] {
            let mut edit = editor::new_command(kind);
            edit.asset = url.into();
            let source = editor::edit_command("", &edit).unwrap();
            assert!(source.contains("\\;"), "{source}");
            assert_eq!(editor::read_command(&source).unwrap().asset, url);
            let nodes = ollaic_core::webgal::parser::parse_script(&source);
            let saved = ollaic_core::webgal::serializer::serialize_script(&nodes);
            assert_eq!(editor::read_command(&saved).unwrap().asset, url);
            assert!(saved.contains("\\;"), "{saved}");
        }
        let mut dialogue = editor::new_command(editor::EditKind::Dialogue);
        dialogue.content = "Hello".into();
        dialogue.voice = url.into();
        let source = editor::edit_command("", &dialogue).unwrap();
        assert_eq!(editor::read_command(&source).unwrap().voice, url);
        assert!(source.contains("\\;"), "{source}");
    }
    let original = "changeBg:https://example.invalid/image\\;part.png;\n";
    let saved = ollaic_core::webgal::serializer::serialize_script(
        &ollaic_core::webgal::parser::parse_script(original),
    );
    assert_eq!(saved, original);
}

#[test]
fn animation_files_commands_registry_and_references_follow_one_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Animation contract").unwrap();
    let frames = "[{\"alpha\":0,\"duration\":0},{\"alpha\":1,\"duration\":300}]";
    operations::save_animation(&root, "fade.json", frames, "").unwrap();
    assert!(table(&root).contains(&"fade".into()));
    assert!(table(&root).contains(&"shake".into()));
    assert!(!assets::list_assets(&root)
        .unwrap()
        .iter()
        .any(|asset| asset.name == "animationTable.json"));
    assert_eq!(
        assets::asset_command("animation", "fade.json").unwrap(),
        "setAnimation:fade;\n"
    );
    let mut edit = editor::new_command(editor::EditKind::SetAnimation);
    edit.asset = "fade.json".into();
    edit.target = "fig".into();
    let command = editor::edit_command("", &edit).unwrap();
    assert_eq!(editor::read_command(&command).unwrap(), edit);
    fs::write(root.join("game/scene/start.txt"), &command).unwrap();
    let revision = project::load_workspace(&root).unwrap().revision;
    assert_eq!(
        operations::asset_usages(&root, "animation", "fade.json")
            .unwrap()
            .len(),
        1
    );
    assert!(operations::delete_asset(&root, "animation", "fade.json", &revision).is_err());
    operations::rename_asset(&root, "animation", "fade.json", "new -fade.json", &revision).unwrap();
    assert!(!table(&root).contains(&"fade".into()));
    assert!(table(&root).contains(&"new%20-fade".into()));
    let command = fs::read_to_string(root.join("game/scene/start.txt")).unwrap();
    assert!(command.contains("setAnimation:new%20-fade -target=fig;"));
    assert_eq!(
        editor::read_command(&command).unwrap().asset,
        "new -fade.json"
    );
    assert_eq!(
        operations::asset_usages(&root, "animation", "new -fade.json")
            .unwrap()
            .len(),
        1
    );
    fs::write(root.join("game/scene/start.txt"), "; Unlinked\n").unwrap();
    let revision = project::load_workspace(&root).unwrap().revision;
    operations::delete_asset(&root, "animation", "new -fade.json", &revision).unwrap();
    assert!(!root.join("game/animation/new -fade.json").exists());
    assert!(!table(&root).contains(&"new%20-fade".into()));
    assert!(table(&root).contains(&"shake".into()));
}

#[test]
fn animation_import_registers_frames_and_rejects_registry_or_invalid_payloads() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Animation import").unwrap();
    let source = directory.path().join("source.json");
    fs::write(&source, "[{\"alpha\":1,\"duration\":200}]").unwrap();
    assets::import_asset(&root, &source, "animation", "imported.json").unwrap();
    assert!(table(&root).contains(&"imported".into()));
    assert!(assets::import_asset(&root, &source, "animation", "imported.json").is_err());
    let before = table(&root);
    assert!(assets::import_asset(&root, &source, "animation", "animationTable.json").is_err());
    for invalid in ["{}", "[1]", "[{\"duration\":-1}]", "[{\"alpha\":1}]"] {
        assert!(operations::save_animation(&root, "invalid.json", invalid, "").is_err());
        assert!(!root.join("game/animation/invalid.json").exists());
    }
    assert_eq!(table(&root), before);
}

#[test]
fn interrupted_animation_save_recovers_frames_registry_and_scene_as_one_transaction() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Animation recovery").unwrap();
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    let frames = "[{\"alpha\":1,\"duration\":300}]";
    let source = "setAnimation:fade -target=fig; keep\r\n";
    fs::write(root.join("game/animation/fade.json"), frames).unwrap();
    fs::write(
        root.join(".ollaic/mobile-asset-pending.json"),
        json!({"text_writes":[
            {"name":"game/animation/fade.json", "source":frames},
            {"name":"game/animation/animationTable.json", "source":"[\"fade\"]"},
            {"name":"game/scene/start.txt", "source":source}
        ]})
        .to_string(),
    )
    .unwrap();
    for _ in 0..2 {
        assert_eq!(
            project::load_workspace(&root).unwrap().document.scenes[0].source,
            source
        );
        assert_eq!(table(&root), vec!["fade"]);
        assert_eq!(
            operations::asset_usages(&root, "animation", "fade.json")
                .unwrap()
                .len(),
            1
        );
    }
    assert!(!root.join(".ollaic/mobile-asset-pending.json").exists());
    let parsed: Value = serde_json::from_str(
        &operations::read_animation(&root, "fade.json")
            .unwrap()
            .source,
    )
    .unwrap();
    assert_eq!(parsed[0]["duration"], 300);
}

#[cfg(unix)]
#[test]
fn animation_registry_symlinks_and_unsafe_text_journals_cannot_modify_external_files() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Animation boundaries").unwrap();
    let outside = directory.path().join("outside.txt");
    fs::write(&outside, "Keep").unwrap();
    std::os::unix::fs::symlink(
        &outside,
        root.join("game/animation/animationTable.json.tmp"),
    )
    .unwrap();
    assert!(operations::save_animation(&root, "fade.json", "[{\"duration\":100}]", "").is_err());
    assert!(!root.join("game/animation/fade.json").exists());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "Keep");
    fs::remove_file(root.join("game/animation/animationTable.json.tmp")).unwrap();
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    fs::write(
        root.join(".ollaic/mobile-asset-pending.json"),
        json!({"text_writes":[{"name":"../outside.txt", "source":"Changed"}]}).to_string(),
    )
    .unwrap();
    assert!(project::load_workspace(&root).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "Keep");
}
