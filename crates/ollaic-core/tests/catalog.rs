use ollaic_core::{asset_operations as operations, assets, catalog, project};
use serde_json::json;
use std::fs;

#[test]
fn character_catalog_preserves_extensions_and_rejects_stale_writes() {
    let directory = tempfile::tempdir().unwrap();
    let project_root = directory.path().join("project");
    let root = project_root.as_path();
    project::create_project(root, "Catalog").unwrap();
    fs::create_dir_all(root.join("game/config")).unwrap();
    fs::write(root.join("game/config/characters.json"), json!({"version":1,"futureDocument":{"keep":true},"characters":[{
        "id":"hero","name":"Alice","age":18,"futureCharacter":123,"sprites":[{"emotion":"smile","file":"hero.png","futureSprite":"keep"}],
        "relations":[],"notes":"Notes"}]}).to_string()).unwrap();
    let before = catalog::load_characters(root).unwrap();
    assert_eq!(before.characters[0].age, "18");
    let mut character = before.characters[0].clone();
    character.name = "Alice updated".into();
    character.sprites[0].emotion = "happy".into();
    let saved = catalog::save_character(root, character.clone(), &before.revision).unwrap();
    assert!(catalog::save_character(root, character, &before.revision).is_err());
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("game/config/characters.json")).unwrap())
            .unwrap();
    assert_eq!(value["futureDocument"]["keep"], true);
    assert_eq!(value["characters"][0]["futureCharacter"], 123);
    assert_eq!(value["characters"][0]["sprites"][0]["futureSprite"], "keep");
    assert_eq!(saved.characters[0].name, "Alice updated");
    let fresh = catalog::save_character(
        root,
        catalog::Character {
            name: "Bob".into(),
            ..Default::default()
        },
        &saved.revision,
    )
    .unwrap();
    let deleted = catalog::delete_character(root, "hero", &fresh.revision).unwrap();
    assert_eq!(deleted.characters.len(), 1);
}

#[test]
fn asset_rename_updates_scene_character_and_metadata_references_without_touching_other_content() {
    let directory = tempfile::tempdir().unwrap();
    let project_root = directory.path().join("project");
    let root = project_root.as_path();
    project::create_project(root, "Assets").unwrap();
    fs::write(root.join("game/background/old; file.png"), b"image").unwrap();
    fs::write(root.join("game/scene/start.txt"), "changeBg:old\\; file.png -next; keep\r\nunlockCg:old\\; file.png -name=Park;\r\n:old\\; file.png is dialogue;\r\n").unwrap();
    fs::create_dir_all(root.join("game/config")).unwrap();
    fs::write(root.join("game/config/asset-metadata.json"), json!({"aliases":{"background/old; file.png":"Park"},"cgCards":{"cg":{"imageAsset":"old; file.png","future":true}},"future":{"keep":true}}).to_string()).unwrap();
    let snapshot = project::load_workspace(root).unwrap();
    assert!(
        operations::delete_asset(root, "background", "old; file.png", &snapshot.revision).is_err()
    );
    operations::rename_asset(
        root,
        "background",
        "old; file.png",
        "new.png",
        &snapshot.revision,
    )
    .unwrap();
    assert!(!root.join("game/background/old; file.png").exists());
    assert_eq!(
        fs::read(root.join("game/background/new.png")).unwrap(),
        b"image"
    );
    let source = fs::read_to_string(root.join("game/scene/start.txt")).unwrap();
    assert!(source.contains("changeBg:new.png -next; keep\r\n"));
    assert!(source.contains("unlockCg:new.png -name=Park;\r\n"));
    assert!(source.contains(":old\\; file.png is dialogue;\r\n"));
    let details = catalog::asset_details(root, "background", "new.png").unwrap();
    assert_eq!(details.alias, "Park");
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("game/config/asset-metadata.json")).unwrap())
            .unwrap();
    assert_eq!(metadata["cgCards"]["cg"]["imageAsset"], "new.png");
    assert_eq!(metadata["future"]["keep"], true);
    assert!(operations::rename_asset(
        root,
        "background",
        "new.png",
        "again.png",
        &snapshot.revision
    )
    .is_err());
    fs::write(root.join("game/figure/old.png"), b"figure").unwrap();
    let characters = catalog::load_characters(root).unwrap();
    catalog::save_character(
        root,
        catalog::Character {
            name: "Alice".into(),
            sprites: vec![catalog::CharacterSprite {
                emotion: "happy".into(),
                file: "old.png".into(),
                ..Default::default()
            }],
            ..Default::default()
        },
        &characters.revision,
    )
    .unwrap();
    let revision = project::load_workspace(root).unwrap().revision;
    operations::rename_asset(root, "figure", "old.png", "hero/new.png", &revision).unwrap();
    assert_eq!(
        catalog::load_characters(root).unwrap().characters[0].sprites[0].file,
        "hero/new.png"
    );
    assert!(!operations::asset_usages(root, "figure", "hero/new.png")
        .unwrap()
        .is_empty());
}

#[test]
fn narration_unlocks_and_animations_are_included_in_usage_and_rename() {
    let source = ":Aside -vocal=old.ogg -when=ready; keep\r\nAlice:Hello -old.ogg;\n";
    let (renamed, count) = ollaic_core::webgal::references::rename_asset_references(
        source,
        "vocal",
        "old.ogg",
        "new voice.opus",
    );
    assert_eq!(count, 2);
    assert!(renamed.contains("-vocal=./game/vocal/new%20voice.opus -when=ready; keep\r\n"));
    assert!(renamed.contains("-vocal=./game/vocal/new%20voice.opus;"));
    let refs = ollaic_core::webgal::references::find_asset_references(
        "unlockCg:cg.png;\nunlockBgm:bg.ogg;\nsetAnimation:fade -target=fig;\n",
    );
    assert_eq!(
        refs.iter()
            .map(|reference| reference.category)
            .collect::<Vec<_>>(),
        vec!["background", "bgm", "animation"]
    );
    let source = "setAnimation:shake -target=fig; keep\r\n";
    assert!(ollaic_core::webgal::references::find_asset_references(source).is_empty());
    assert_eq!(
        ollaic_core::webgal::references::find_asset_references_to(
            source,
            "animation",
            "shake.json"
        )
        .len(),
        1
    );
    assert_eq!(
        ollaic_core::webgal::references::rename_asset_references(
            source,
            "animation",
            "shake.json",
            "fade2.json"
        ),
        ("setAnimation:fade2 -target=fig; keep\r\n".into(), 1)
    );
}

#[test]
fn animations_are_validated_and_revision_checked_and_unused_assets_can_be_deleted() {
    let directory = tempfile::tempdir().unwrap();
    let project_root = directory.path().join("project");
    let root = project_root.as_path();
    project::create_project(root, "Animation").unwrap();
    let animation =
        operations::save_animation(root, "fade.json", "[{\"alpha\":0,\"duration\":100}]", "")
            .unwrap();
    assert_eq!(
        operations::read_animation(root, "fade.json")
            .unwrap()
            .source,
        animation.source
    );
    assert!(operations::save_animation(root, "fade.json", "{}", "").is_err());
    assert!(operations::save_animation(root, "fade.json", "invalid", &animation.revision).is_err());
    operations::save_animation(
        root,
        "fade.json",
        "[{\"alpha\":1,\"duration\":100}]",
        &animation.revision,
    )
    .unwrap();
    fs::write(root.join("game/background/unused.png"), b"unused").unwrap();
    let details = catalog::asset_details(root, "background", "unused.png").unwrap();
    catalog::save_asset_details(
        root,
        "background",
        "unused.png",
        catalog::AssetDetails {
            alias: "Unused".into(),
            ..details
        },
    )
    .unwrap();
    assert_eq!(
        assets::list_assets(root)
            .unwrap()
            .iter()
            .find(|asset| asset.name == "unused.png")
            .unwrap()
            .alias,
        "Unused"
    );
    operations::delete_asset(
        root,
        "background",
        "unused.png",
        &project::load_workspace(root).unwrap().revision,
    )
    .unwrap();
    assert!(!root.join("game/background/unused.png").exists());
    assert!(assets::import_asset(
        root,
        &root.join("game/config.txt"),
        "figure",
        "../escape.png"
    )
    .is_err());
}

#[test]
fn interrupted_asset_rename_recovers_before_the_next_project_read() {
    use sha2::Digest;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Recovery").unwrap();
    fs::write(root.join("game/background/old.png"), b"image").unwrap();
    fs::copy(
        root.join("game/background/old.png"),
        root.join("game/background/new.png"),
    )
    .unwrap();
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    let pending = json!({"category":"background","old_name":"old.png","new_name":"new.png",
        "asset_digest":format!("{:x}", sha2::Sha256::digest(b"image")),
        "writes":[{"name":"game/scene/start.txt","source":"changeBg:new.png -next; keep\r\n"}]});
    fs::write(
        root.join(".ollaic/mobile-asset-pending.json"),
        pending.to_string(),
    )
    .unwrap();
    let restored = project::load_workspace(&root).unwrap();
    assert_eq!(
        restored.document.scenes[0].source,
        "changeBg:new.png -next; keep\r\n"
    );
    assert!(!root.join("game/background/old.png").exists());
    assert_eq!(
        fs::read(root.join("game/background/new.png")).unwrap(),
        b"image"
    );
    assert!(!root.join(".ollaic/mobile-asset-pending.json").exists());
    project::load_workspace(&root).unwrap();
}

#[test]
fn title_assets_cannot_be_deleted_and_renames_preserve_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Title resources").unwrap();
    let config = "; Keep this header\r\nGame_name:Title resources;\r\n  Title_img: title.png;\r\nTitle_bgm:theme.ogg;\r\nCustom_setting:keep;\r\nEnable_Appreciation:true;\r\n";
    fs::write(root.join("game/config.txt"), config).unwrap();
    fs::write(root.join("game/background/title.png"), b"image").unwrap();
    fs::write(root.join("game/bgm/theme.ogg"), b"audio").unwrap();
    let revision = project::load_workspace(&root).unwrap().revision;

    for (category, name, field, line) in [
        ("background", "title.png", "Title_img", 3),
        ("bgm", "theme.ogg", "Title_bgm", 4),
    ] {
        let usages = operations::asset_usages(&root, category, name).unwrap();
        assert_eq!(usages.len(), 1);
        assert_eq!(usages[0].file_name, "game/config.txt");
        assert_eq!(usages[0].command, field);
        assert_eq!(usages[0].line_number, line);
        assert!(operations::delete_asset(&root, category, name, &revision).is_err());
        assert!(root.join("game").join(category).join(name).exists());
    }
    assert_eq!(
        fs::read_to_string(root.join("game/config.txt")).unwrap(),
        config
    );
    operations::rename_asset(&root, "background", "title.png", "new title.png", &revision).unwrap();
    operations::rename_asset(&root, "bgm", "theme.ogg", "new theme.ogg", &revision).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("game/config.txt")).unwrap(),
        config
            .replace("title.png", "new%20title.png")
            .replace("theme.ogg", "new%20theme.ogg")
    );
    assert!(!root.join("game/background/title.png").exists());
    assert!(!root.join("game/bgm/theme.ogg").exists());
    assert_eq!(
        operations::asset_usages(&root, "background", "new title.png")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        operations::asset_usages(&root, "bgm", "new theme.ogg")
            .unwrap()
            .len(),
        1
    );
    assert!(!root.join(".ollaic/mobile-asset-pending.json").exists());
}

#[test]
fn interrupted_title_asset_rename_recovers_its_configuration_write() {
    use sha2::Digest;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Title recovery").unwrap();
    fs::write(root.join("game/background/old.png"), b"image").unwrap();
    fs::copy(
        root.join("game/background/old.png"),
        root.join("game/background/new.png"),
    )
    .unwrap();
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    let config = "Game_name:Title recovery;\nTitle_img:new.png;\nEnable_Appreciation:true;\n";
    fs::write(
        root.join(".ollaic/mobile-asset-pending.json"),
        json!({
            "category":"background", "old_name":"old.png", "new_name":"new.png",
            "asset_digest":format!("{:x}", sha2::Sha256::digest(b"image")),
            "writes":[{"name":"game/config.txt", "source":config}],
        })
        .to_string(),
    )
    .unwrap();

    project::load_workspace(&root).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("game/config.txt")).unwrap(),
        config
    );
    assert!(!root.join("game/background/old.png").exists());
    assert_eq!(
        operations::asset_usages(&root, "background", "new.png")
            .unwrap()
            .len(),
        1
    );
    assert!(!root.join(".ollaic/mobile-asset-pending.json").exists());
}

#[cfg(unix)]
#[test]
fn title_asset_rename_rejects_a_symlinked_configuration_temporary_file() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Title symlink").unwrap();
    let config = "Game_name:Title symlink;\nTitle_img:old.png;\nEnable_Appreciation:true;\n";
    fs::write(root.join("game/config.txt"), config).unwrap();
    fs::write(root.join("game/background/old.png"), b"image").unwrap();
    let outside = directory.path().join("outside.txt");
    fs::write(&outside, "Keep this file").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("game/config.txt.tmp")).unwrap();
    let revision = project::load_workspace(&root).unwrap().revision;

    assert!(
        operations::rename_asset(&root, "background", "old.png", "new.png", &revision).is_err()
    );
    assert_eq!(fs::read_to_string(&outside).unwrap(), "Keep this file");
    assert_eq!(
        fs::read_to_string(root.join("game/config.txt")).unwrap(),
        config
    );
    assert!(root.join("game/background/old.png").exists());
    assert!(!root.join("game/background/new.png").exists());
    assert!(!root.join(".ollaic/mobile-asset-pending.json").exists());
}

#[test]
fn implicit_desktop_sprite_variants_resolve_and_survive_renaming() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Variants").unwrap();
    fs::create_dir_all(root.join("game/figure/hero")).unwrap();
    fs::write(root.join("game/figure/hero/Alice_happy_123.png"), b"sprite").unwrap();
    fs::create_dir_all(root.join("game/config")).unwrap();
    fs::write(root.join("game/config/characters.json"), json!({"version":1,"characters":[{"id":"hero","name":"Alice","sprites":[{"emotion":"happy","file":"","future":true}]}]}).to_string()).unwrap();
    let before = catalog::load_characters(&root).unwrap();
    let character = &before.characters[0];
    assert_eq!(
        catalog::resolve_sprite(
            character,
            &character.sprites[0],
            &assets::list_assets(&root).unwrap()
        ),
        "hero/Alice_happy_123.png"
    );
    assert_eq!(
        operations::asset_usages(&root, "figure", "hero/Alice_happy_123.png")
            .unwrap()
            .len(),
        1
    );
    operations::rename_asset(
        &root,
        "figure",
        "hero/Alice_happy_123.png",
        "hero/new.png",
        &project::load_workspace(&root).unwrap().revision,
    )
    .unwrap();
    let after = catalog::load_characters(&root).unwrap();
    assert_eq!(after.characters[0].sprites[0].file, "hero/new.png");
    assert_eq!(after.characters[0].sprites[0].extra["future"], true);
    let mut bad = catalog::Character {
        name: "Visible name".into(),
        ..Default::default()
    };
    bad.extra.insert("name".into(), "Hidden name".into());
    assert!(catalog::save_character(&root, bad, &after.revision).is_err());
}

#[test]
fn reference_assets_follow_owner_renames_without_breaking_shared_audio_references() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "References").unwrap();
    fs::create_dir_all(root.join("game/config")).unwrap();
    fs::write(root.join("game/background/park.png"), b"image").unwrap();
    fs::write(root.join("game/bgm/theme.wav"), b"audio").unwrap();
    fs::write(root.join("game/vocal/theme.wav"), b"audio").unwrap();
    assets::import_asset(
        &root,
        &root.join("game/background/park.png"),
        "reference",
        "backgrounds/park.png/ref.png",
    )
    .unwrap();
    assets::import_asset(
        &root,
        &root.join("game/bgm/theme.wav"),
        "reference",
        "audio/theme.wav/tone.wav",
    )
    .unwrap();
    fs::write(
        root.join("game/scene/start.txt"),
        "changeBg:park.png -next; keep\r\n",
    )
    .unwrap();
    fs::write(root.join("game/config/asset-metadata.json"), json!({
        "aliases":{"reference/backgrounds/park.png/ref.png":"Reference","theme.wav":"Legacy shared"},
        "references":{"background/park.png":["ref.png"],"bgm/theme.wav":["tone.wav"],"vocal/theme.wav":["tone.wav"]},
        "sceneCards":{"park":{"imageAsset":"park.png","targetStem":"park","future":true}}
    }).to_string()).unwrap();
    assert_eq!(
        operations::asset_usages(&root, "reference", "backgrounds/park.png/ref.png")
            .unwrap()
            .len(),
        1
    );
    operations::rename_asset(
        &root,
        "background",
        "park.png",
        "evening.png",
        &project::load_workspace(&root).unwrap().revision,
    )
    .unwrap();
    assert!(!root
        .join("game/reference/backgrounds/park.png/ref.png")
        .exists());
    assert_eq!(
        fs::read(root.join("game/reference/backgrounds/evening.png/ref.png")).unwrap(),
        b"image"
    );
    assert_eq!(
        catalog::asset_details(&root, "reference", "backgrounds/evening.png/ref.png")
            .unwrap()
            .alias,
        "Reference"
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("game/config/asset-metadata.json")).unwrap())
            .unwrap();
    assert_eq!(metadata["sceneCards"]["park"]["targetStem"], "evening");
    assert_eq!(metadata["sceneCards"]["park"]["future"], true);
    operations::rename_asset(
        &root,
        "reference",
        "backgrounds/evening.png/ref.png",
        "backgrounds/evening.png/new.png",
        &project::load_workspace(&root).unwrap().revision,
    )
    .unwrap();
    assert_eq!(
        catalog::asset_details(&root, "background", "evening.png")
            .unwrap()
            .references,
        vec!["new.png"]
    );
    assert!(operations::delete_asset(
        &root,
        "reference",
        "backgrounds/evening.png/new.png",
        &project::load_workspace(&root).unwrap().revision
    )
    .is_err());
    operations::rename_asset(
        &root,
        "bgm",
        "theme.wav",
        "theme2.wav",
        &project::load_workspace(&root).unwrap().revision,
    )
    .unwrap();
    assert!(root
        .join("game/reference/audio/theme.wav/tone.wav")
        .exists());
    assert!(root
        .join("game/reference/audio/theme2.wav/tone.wav")
        .exists());
    assert_eq!(
        catalog::asset_details(&root, "vocal", "theme.wav")
            .unwrap()
            .alias,
        "Legacy shared"
    );
    assert_eq!(
        catalog::asset_details(&root, "bgm", "theme2.wav")
            .unwrap()
            .alias,
        "Legacy shared"
    );
    assert_eq!(
        operations::asset_usages(&root, "reference", "audio/theme.wav/tone.wav")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        operations::asset_usages(&root, "reference", "audio/theme2.wav/tone.wav")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn imported_asset_journals_cannot_write_outside_project_resources() {
    use sha2::Digest;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    project::create_project(&root, "Invalid journal").unwrap();
    fs::write(root.join("game/background/old.png"), b"image").unwrap();
    fs::write(directory.path().join("outside.txt"), "safe").unwrap();
    fs::create_dir_all(root.join(".ollaic")).unwrap();
    fs::write(root.join(".ollaic/mobile-asset-pending.json"), json!({"category":"background","old_name":"old.png","new_name":"new.png",
        "asset_digest":format!("{:x}", sha2::Sha256::digest(b"image")),"writes":[{"name":"../outside.txt","source":"changed"}]}).to_string()).unwrap();
    assert!(project::load_workspace(&root).is_err());
    assert_eq!(
        fs::read_to_string(directory.path().join("outside.txt")).unwrap(),
        "safe"
    );
    assert!(root.join("game/background/old.png").exists());
    assert!(!root.join("game/background/new.png").exists());
}
