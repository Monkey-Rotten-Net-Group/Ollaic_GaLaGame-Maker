use ollaic_core::{
    asset_operations,
    editor::{self, EditChoice, EditKind},
    project,
};
use serde_json::json;
use std::{
    fs,
    io::{self, Read},
};

fn zip_text(
    archive: &mut zip::ZipArchive<fs::File>,
    name: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut entry = archive.by_name(name)?;
    if entry.size() > 4 * 1024 * 1024 {
        return Err(io::Error::other("Engine source exceeds the fixture size limit").into());
    }
    let mut source = String::new();
    entry.read_to_string(&mut source)?;
    Ok(source)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or_else(|| io::Error::other("Expected the pinned WebGAL web ZIP"))?;
    let mut archive = zip::ZipArchive::new(fs::File::open(path)?)?;
    let metadata: serde_json::Value =
        serde_json::from_str(&zip_text(&mut archive, "webgal-engine.json")?)?;
    let builtins: Vec<String> = serde_json::from_str(&zip_text(
        &mut archive,
        "game/animation/animationTable.json",
    )?)?;
    let scripts: Vec<_> = archive
        .file_names()
        .filter(|name| name.starts_with("assets/index-") && name.ends_with(".js"))
        .map(str::to_owned)
        .collect();
    let mut engine = None;
    for script in scripts {
        let source = zip_text(&mut archive, &script)?;
        if source.contains("function Tte(") && source.contains("const WR=") {
            engine = Some(source);
            break;
        }
    }
    let engine = engine.ok_or_else(|| io::Error::other("Pinned engine parser was not found"))?;
    let mut cases = Vec::new();
    for (kind, command, category, extension) in [
        (EditKind::ChangeBg, "changeBg", "background", "png"),
        (EditKind::ChangeFigure, "changeFigure", "figure", "png"),
        (EditKind::MiniAvatar, "miniAvatar", "figure", "png"),
        (EditKind::Bgm, "bgm", "bgm", "ogg"),
        (EditKind::PlayEffect, "playEffect", "vocal", "ogg"),
        (EditKind::PlayVideo, "playVideo", "video", "mp4"),
        (EditKind::UnlockCg, "unlockCg", "background", "png"),
        (EditKind::UnlockBgm, "unlockBgm", "bgm", "ogg"),
        (EditKind::ChangeScene, "changeScene", "scene", "txt"),
        (EditKind::CallScene, "callScene", "scene", "txt"),
        (EditKind::Dialogue, "say", "vocal", "ogg"),
        (EditKind::Choose, "choose", "scene", "txt"),
    ] {
        let file_name = format!("folder/new -resource;|#?100%20.{extension}");
        let mut edit = editor::new_command(kind);
        match kind {
            EditKind::ChangeScene | EditKind::CallScene => edit.scene = file_name.clone(),
            EditKind::Dialogue => {
                edit.content = "Hello".into();
                edit.voice = file_name.clone();
            }
            EditKind::Choose => {
                edit.choices = vec![EditChoice {
                    text: "Next".into(),
                    target: file_name.clone(),
                }]
            }
            _ => edit.asset = file_name.clone(),
        }
        cases.push(json!({"source":editor::edit_command("", &edit)?, "command":command, "category":category, "fileName":file_name}));
    }
    let mut external_cases = Vec::new();
    for url in [
        "https://example.invalid/image;part.png?token=a;b%3Bc&key=value#fragment",
        "http://example.invalid/media%20name;part.ogg?token=%25;keep=1",
    ] {
        for (kind, command) in [
            (EditKind::ChangeBg, "changeBg"),
            (EditKind::PlayEffect, "playEffect"),
            (EditKind::Dialogue, "say"),
        ] {
            let mut edit = editor::new_command(kind);
            if kind == EditKind::Dialogue {
                edit.content = "Hello".into();
                edit.voice = url.into();
            } else {
                edit.asset = url.into();
            }
            let source = editor::edit_command("", &edit)?;
            let saved = ollaic_core::webgal::serializer::serialize_script(
                &ollaic_core::webgal::parser::parse_script(&source),
            );
            external_cases
                .push(json!({"source":source, "saved":saved, "command":command, "url":url}));
        }
    }
    let temporary = tempfile::tempdir()?;
    let root = temporary.path().join("project");
    project::create_project(&root, "Engine contract")?;
    fs::write(
        root.join("game/config.txt"),
        "Game_name:Engine contract;\nTitle_img:old.png; title comment\nEnable_Appreciation:true;\n",
    )?;
    fs::write(root.join("game/background/old.png"), b"image")?;
    let title_name = "part;2| -title#100%.png";
    let revision = project::load_workspace(&root)?.revision;
    asset_operations::rename_asset(&root, "background", "old.png", title_name, &revision)?;
    let frames = "[{\"alpha\":0,\"duration\":0},{\"alpha\":1,\"duration\":300}]";
    asset_operations::save_animation(&root, "new -fade.json", frames, "")?;
    let mut animation = editor::new_command(EditKind::SetAnimation);
    animation.asset = "new -fade.json".into();
    animation.target = "fig".into();
    let table: Vec<String> =
        serde_json::from_slice(&fs::read(root.join("game/animation/animationTable.json"))?)?;
    let config = fs::read_to_string(root.join("game/config.txt"))?;
    let result = json!({
        "version":metadata["webgalVersion"], "engine":engine, "builtins":builtins, "cases":cases,
        "externalCases":external_cases,
        "config":config, "titleName":title_name,
        "animation": {"source":editor::edit_command("", &animation)?, "table":table, "frames":serde_json::from_str::<serde_json::Value>(frames)?}
    });
    println!("{result}");
    Ok(())
}
