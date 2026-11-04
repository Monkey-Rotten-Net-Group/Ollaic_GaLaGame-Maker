use ollaic_core::{archive, project, webgal::parser};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let source = args
        .next()
        .ok_or("usage: inspect-project PROJECT_OR_ZIP [EXPECTED_TEXT]")?;
    let expected = args.next();
    let temporary = tempfile::tempdir()?;
    let root = if Path::new(&source).is_dir() {
        Path::new(&source).to_path_buf()
    } else {
        let root = temporary.path().join("project");
        archive::import_project(Path::new(&source), &root)?;
        root
    };
    let info = project::open_project(&root)?;
    let workspace = project::load_workspace(&root)?;
    let metadata = root.join("project-metadata.json");
    if metadata.exists() {
        serde_json::from_slice::<project::ProjectMetadata>(&std::fs::read(metadata)?)?;
        println!("Desktop metadata schema PASS");
    }
    println!(
        "Project: {}",
        info.config
            .get("Game_name")
            .map(String::as_str)
            .unwrap_or_default()
    );
    for scene in &workspace.document.scenes {
        println!(
            "{}: {} desktop parser nodes",
            scene.file_name,
            parser::parse_script(&scene.source).len()
        );
    }
    if let Some(expected) = expected {
        if !workspace
            .document
            .scenes
            .iter()
            .any(|scene| scene.source.contains(&expected))
        {
            return Err(format!("Expected text was not found: {expected}").into());
        }
        println!("Expected edit found: {expected}");
    }
    println!("WebGAL project compatibility PASS");
    Ok(())
}
