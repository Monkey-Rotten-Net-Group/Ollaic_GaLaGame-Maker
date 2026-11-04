use ollaic_core::editor;
use ollaic_core::editor::*;
use ollaic_core::webgal::{parser::parse_script, serializer::serialize_script, types::CommandType};

#[test]
fn media_commands_edit_only_requested_fields_and_voice_markers() {
    for source in ["changeBg:old.png -next; keep\r\n", "changeFigure:old.png -left -id=hero -figureCharacter=Alice -figureEmotion=smile -duration=300; keep\r\n",
        "miniAvatar:old.png;", "bgm:old.ogg -volume=30;", "playEffect:old.ogg;", "playVideo:old.mp4;", "setAnimation:old -target=fig;",
        "unlockCg:old.png -name=Old name;", "unlockBgm:old.ogg -name=Old name;"] {
        let mut edit = editor::read_command(source).unwrap();
        assert_eq!(editor::edit_command(source, &edit).unwrap(), source);
        edit.asset = "new file; -literal.png".into();
        match edit.kind {
            editor::EditKind::ChangeFigure => { edit.figure_position = "right".into(); edit.figure_emotion = "sad".into(); },
            editor::EditKind::Bgm | editor::EditKind::PlayEffect | editor::EditKind::PlayVideo => edit.volume = Some(70),
            editor::EditKind::UnlockCg | editor::EditKind::UnlockBgm => edit.display_name = "New name".into(),
            editor::EditKind::SetAnimation => { edit.target = "fig-left".into(); edit.asset = "new file; -literal.json".into(); }, _ => {},
        }
        let changed = editor::edit_command(source, &edit).unwrap();
        assert_eq!(editor::read_command(&changed).unwrap(), edit, "{changed}");
        if source.contains("keep") { assert!(changed.ends_with("; keep\r\n")); }
        if source.contains("duration") { assert!(changed.contains("-duration=300")); }
    }
    for source in [
        "Alice:Hello -v1.ogg -custom=keep; comment\r\n",
        ":Aside -vocal=old.ogg -next;\n",
    ] {
        let mut edit = editor::read_command(source).unwrap();
        edit.voice = "new voice.opus".into();
        let changed = editor::edit_command(source, &edit).unwrap();
        assert!(changed.contains("-vocal=./game/vocal/new%20voice.opus"));
        assert_eq!(
            editor::read_command(&changed).unwrap().voice,
            "new voice.opus"
        );
        edit.voice.clear();
        assert!(!editor::edit_command(&changed, &edit)
            .unwrap()
            .contains("vocal="));
    }
    let mut edit = editor::new_command(editor::EditKind::Bgm);
    edit.volume = Some(101);
    assert!(editor::edit_command("", &edit).is_err());
    assert_eq!(
        editor::read_command("changeFigure:none -left=false;")
            .unwrap()
            .figure_position,
        "center"
    );
}

#[test]
fn list_previews_identify_every_command_without_changing_editable_source() {
    let cases = [
        ("Alice:Hello;", "dialogue", "Hello"),
        (":Narration;", "narrator", "Narration"),
        ("; Note", "comment", "Note"),
        ("intro:First|Second;", "intro", "First\nSecond"),
        (
            "choose:Next:chapter.txt|Stay;",
            "choose",
            "Next -> chapter.txt\nStay",
        ),
        ("changeBg:park.png -next;", "changeBg", "park.png"),
        ("changeFigure:alice.png -left;", "changeFigure", "alice.png"),
        ("miniAvatar:alice.png;", "miniAvatar", "alice.png"),
        ("bgm:theme.ogg -volume=40;", "bgm", "theme.ogg"),
        ("playEffect:click.wav;", "playEffect", "click.wav"),
        ("playVideo:opening.mp4;", "playVideo", "opening.mp4"),
        ("changeScene:chapter.txt;", "changeScene", "chapter.txt"),
        ("callScene:chapter.txt;", "callScene", "chapter.txt"),
        ("label:branch_a;", "label", "branch_a"),
        ("jumpLabel:branch_a;", "jumpLabel", "branch_a"),
        ("setVar:score=score + 1;", "setVar", "score=score + 1"),
        (
            "getUserInput:name -title=Your name;",
            "getUserInput",
            "name",
        ),
        ("setTextbox:hide;", "setTextbox", "hide"),
        (
            "setAnimation:fade -target=fig;",
            "setAnimation",
            "fade.json",
        ),
        (
            "setTransform:{\"alpha\":0.5} -target=fig;",
            "setTransform",
            "{\"alpha\":0.5}",
        ),
        ("unlockCg:park.png -name=Park;", "unlockCg", "park.png"),
        ("unlockBgm:theme.ogg -name=Theme;", "unlockBgm", "theme.ogg"),
        ("end:;", "end", ""),
    ];
    for (source, command, preview) in cases {
        let source = format!("{source}\r\n");
        let lines = ollaic_core::document::decode_lines(&source);
        let line = &lines[0];
        assert_eq!(line.command, command);
        assert_eq!(line.preview, preview);
        assert_eq!(
            ollaic_core::document::edit_line(&line.source, &line.kind, &line.speaker, &line.text)
                .unwrap(),
            source
        );
    }
    let source = "setTransform:{} \\\n  -target=fig;\n";
    let lines = ollaic_core::document::decode_lines(source);
    assert_eq!(lines[0].command, "raw");
    assert_eq!(lines[0].preview, source.trim_end());
}

#[test]
fn all_23_commands_preserve_parameters_through_edit_save_and_reload() {
    use ollaic_core::project;
    let cases = [
        (EditKind::Dialogue, "Alice:Hello -voice=keep.ogg"),
        (EditKind::Narrator, ":Narration -vocal=keep.ogg"),
        (EditKind::Comment, "; Note"),
        (EditKind::Intro, "intro:First|Second"),
        (EditKind::Choose, "choose:One:a.txt|Two:old_label"),
        (EditKind::ChangeScene, "changeScene:a.txt"),
        (EditKind::CallScene, "callScene:a.txt"),
        (EditKind::End, "end:"),
        (EditKind::Label, "label:old_label"),
        (EditKind::JumpLabel, "jumpLabel:old_label"),
        (EditKind::SetVar, "setVar:score=0"),
        (
            EditKind::GetUserInput,
            "getUserInput:name -title=Old -buttonText=OK",
        ),
        (EditKind::SetTextbox, "setTextbox:show"),
        (
            EditKind::SetTransform,
            "setTransform:{\"alpha\":1} -target=fig",
        ),
        (EditKind::ChangeBg, "changeBg:old.png"),
        (
            EditKind::ChangeFigure,
            "changeFigure:old.png -left -id=hero -figureCharacter=Alice -figureEmotion=happy",
        ),
        (EditKind::MiniAvatar, "miniAvatar:old.png"),
        (EditKind::Bgm, "bgm:old.ogg -volume=30"),
        (EditKind::PlayEffect, "playEffect:old.wav -volume=20"),
        (EditKind::PlayVideo, "playVideo:old.mp4 -volume=40"),
        (EditKind::SetAnimation, "setAnimation:old -target=fig"),
        (EditKind::UnlockCg, "unlockCg:old.png -name=Old CG"),
        (EditKind::UnlockBgm, "unlockBgm:old.ogg -name=Old music"),
    ];
    let temporary = tempfile::tempdir().unwrap();
    for (kind, statement) in cases {
        let root = temporary.path().join(format!("{kind:?}"));
        project::create_project(&root, "Command round trip").unwrap();
        let source = if kind == EditKind::Comment {
            format!("{statement}\r\n")
        } else {
            format!("  {statement} -duration=300 -future={{\"a\": 1}} -next=false -when=ready; keep; comment\r\n")
        };
        std::fs::write(root.join("game/scene/start.txt"), &source).unwrap();
        let mut before = project::load_workspace(&root).unwrap();
        let original = before.document.scenes[0].source.clone();
        let mut edit = read_command(&original).unwrap();
        assert_eq!(edit.kind, kind);
        assert_eq!(edit_command(&original, &edit).unwrap(), original);
        match edit.kind {
            EditKind::Dialogue => {
                edit.speaker = "Bob".into();
                edit.content = "Changed".into();
            }
            EditKind::Narrator | EditKind::Comment => edit.content = "Changed".into(),
            EditKind::Intro => {
                edit.intro_lines = vec!["Changed".into(), "Second".into(), "Third".into()]
            }
            EditKind::Choose => {
                edit.choices.reverse();
                edit.choices[0].target = "new_label".into();
                edit.choices[1].target.clear();
            }
            EditKind::ChangeScene | EditKind::CallScene => edit.scene = "chapter 2.txt".into(),
            EditKind::Label | EditKind::JumpLabel => edit.label = "new_label".into(),
            EditKind::SetVar => {
                edit.variable = "result".into();
                edit.value = "score + 2".into();
            }
            EditKind::GetUserInput => {
                edit.variable = "answer".into();
                edit.title = "Your answer".into();
                edit.button = "All done".into();
            }
            EditKind::SetTextbox => edit.content = "hide".into(),
            EditKind::SetTransform => {
                edit.content = "{\"alpha\":0.5}".into();
                edit.target = "fig-left".into();
            }
            EditKind::End => edit.next = true,
            EditKind::ChangeBg
            | EditKind::MiniAvatar
            | EditKind::UnlockCg
            | EditKind::UnlockBgm => edit.asset = "new file.png".into(),
            EditKind::SetAnimation => edit.asset = "new file.json".into(),
            EditKind::ChangeFigure => {
                edit.asset = "alice-sad.png".into();
                edit.figure_position = "right".into();
                edit.figure_emotion = "sad".into();
            }
            EditKind::Bgm | EditKind::PlayEffect | EditKind::PlayVideo => edit.volume = Some(70),
        }
        let changed = edit_command(&original, &edit).unwrap();
        assert_ne!(changed, original, "{kind:?}");
        if kind != EditKind::Comment {
            for parameter in ["-duration=300", "-future={\"a\": 1}", "-when=ready"] {
                assert!(changed.contains(parameter), "{kind:?}: {changed}");
            }
            assert!(changed.starts_with("  "), "{changed}");
            assert!(changed.ends_with("; keep; comment\r\n"), "{changed}");
        }
        before.document.scenes[0].source = changed.clone();
        project::save_workspace(&root, before.document, &before.revision).unwrap();
        let reloaded = project::load_workspace(&root).unwrap();
        let saved = &reloaded.document.scenes[0].source;
        assert_eq!(saved, &changed, "{kind:?}");
        assert_eq!(read_command(saved).unwrap(), edit, "{kind:?}: {saved}");
    }
}

#[test]
fn edited_fields_preserve_opaque_parameters_comments_and_line_endings() {
    let source = "  getUserInput:old  -title=Old title -buttonText=OK -custom={\"a\": 1} -next=false; keep; comments\r\n";
    let mut edit = read_command(source).unwrap();
    edit.variable = "name".into();
    edit.title = "New title; with delimiter".into();
    edit.next = true;
    let changed = edit_command(source, &edit).unwrap();
    assert!(changed.starts_with("  getUserInput:name"));
    assert!(changed.contains("-custom={\"a\": 1}"));
    assert!(changed.contains("-buttonText=OK"));
    assert!(changed.ends_with("; keep; comments\r\n"));
    assert_eq!(read_command(&changed).unwrap(), edit);
    let mut dialogue = read_command("Alice:Hi -v1 -future=some value; note\n").unwrap();
    dialogue.content = "Text; | : -literal \\ end;".into();
    let changed = edit_command("Alice:Hi -v1 -future=some value; note\n", &dialogue).unwrap();
    assert!(changed.contains("-v1 -future=some value; note"));
    assert_eq!(read_command(&changed).unwrap().content, dialogue.content);
    let source = "Alice:Hi   -v1  -future=some value \t ; note\r\n";
    let mut edit = read_command(source).unwrap();
    edit.content = "Changed".into();
    assert_eq!(
        edit_command(source, &edit).unwrap(),
        "Alice:Changed   -v1  -future=some value \t ; note\r\n"
    );
}

#[test]
fn branches_intro_and_variables_retain_literal_delimiters() {
    let mut choose = new_command(EditKind::Choose);
    choose.choices = vec![
        EditChoice {
            text: "A: B | C; -literal".into(),
            target: "chapter 2.txt".into(),
        },
        EditChoice {
            text: "Stay".into(),
            target: "label_a".into(),
        },
    ];
    let changed = edit_command("", &choose).unwrap();
    let parsed = read_command(&changed).unwrap();
    assert_eq!(parsed.choices, choose.choices);
    let mut intro = new_command(EditKind::Intro);
    intro.intro_lines = vec!["A|B".into(), "C;D".into(), "Last".into()];
    assert_eq!(
        read_command(&edit_command("", &intro).unwrap())
            .unwrap()
            .intro_lines,
        intro.intro_lines
    );
    let mut variable = new_command(EditKind::SetVar);
    variable.variable = "score".into();
    variable.value = "score == 1 ? 2 : 3".into();
    assert_eq!(
        read_command(&edit_command("", &variable).unwrap())
            .unwrap()
            .value,
        variable.value
    );
}

#[test]
fn rejects_incomplete_or_multistatement_structured_edits() {
    for kind in [
        EditKind::Choose,
        EditKind::ChangeScene,
        EditKind::CallScene,
        EditKind::Label,
        EditKind::JumpLabel,
        EditKind::SetVar,
        EditKind::GetUserInput,
        EditKind::Intro,
    ] {
        assert!(edit_command("", &new_command(kind)).is_err(), "{kind:?}");
    }
    assert!(read_command("label:a;\njumpLabel:a;\n").is_err());
    assert_eq!(
        read_command("changeBg:park.webp;\n").unwrap().kind,
        EditKind::ChangeBg
    );
    let mut edit = new_command(EditKind::SetTransform);
    edit.content = "[1,2]".into();
    assert!(edit_command("", &edit).is_err());
    edit = new_command(EditKind::SetVar);
    edit.variable = "a=b".into();
    edit.value = "0".into();
    assert!(edit_command("", &edit).is_err());
    edit = new_command(EditKind::ChangeScene);
    edit.scene = "a.txt\nend:;".into();
    assert!(edit_command("", &edit).is_err());
}

#[test]
fn end_and_spaced_parameters_match_the_shared_desktop_ast() {
    let nodes = parse_script("end -when=score > 1;\n");
    assert_eq!(nodes[0].cmd_type, CommandType::End);
    assert_eq!(nodes[0].when.as_deref(), Some("score > 1"));
    let restored = parse_script(&serialize_script(&nodes));
    assert_eq!(restored[0].cmd_type, CommandType::End);
    assert_eq!(restored[0].when, nodes[0].when);
    let input = parse_script("getUserInput:name -title=Your name -buttonText=All done;\n");
    assert_eq!(input[0].input_title.as_deref(), Some("Your name"));
    assert_eq!(input[0].input_button.as_deref(), Some("All done"));
}

#[test]
fn transforms_and_multiline_text_round_trip_without_damaging_json() {
    let mut edit = new_command(EditKind::SetTransform);
    edit.content = r#"{"alpha":0.5,"custom":"C:\\path;value"}"#.into();
    edit.target = "fig-left".into();
    let changed = edit_command("", &edit).unwrap();
    let restored = read_command(&changed).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&restored.content).unwrap(),
        serde_json::from_str::<serde_json::Value>(&edit.content).unwrap()
    );
    let mut edit = new_command(EditKind::Narrator);
    edit.content = "First\n\nSecond".into();
    assert_eq!(edit_command("", &edit).unwrap(), ":First;\n\n:Second;\n");
    let changed = edit_command(":Old -custom=keep; inline comment\r\n", &edit).unwrap();
    assert_eq!(changed.matches("inline comment").count(), 1);
    assert!(
        changed.contains(":First -custom=keep;\r\n\r\n:Second -custom=keep; inline comment\r\n")
    );
}
