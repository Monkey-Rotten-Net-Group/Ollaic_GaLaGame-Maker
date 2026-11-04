use ollaic_runtime::engine::{self, MAX_ENGINE_ARCHIVE_BYTES};
use std::fs;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;

fn archive(path: &Path, prefix: &str, version: &str, extra: Option<&str>) {
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, contents) in [
        (
            "index.html",
            "<html><head></head><body>Engine</body></html>".to_owned(),
        ),
        ("assets/engine.js", "console.log('engine');".to_owned()),
        (
            "webgal-engine.json",
            serde_json::json!({"webgalVersion": version}).to_string(),
        ),
    ] {
        zip.start_file(format!("{prefix}{name}"), SimpleFileOptions::default())
            .unwrap();
        zip.write_all(contents.as_bytes()).unwrap();
    }
    if let Some(name) = extra {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(b"unsafe").unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn installs_flat_and_wrapped_archives_with_one_pinned_version() {
    for prefix in ["", "WebGAL/"] {
        let temp = tempfile::tempdir().unwrap();
        let zip = temp.path().join("engine.zip");
        let target = temp.path().join("runtime/engine");
        archive(&zip, prefix, ollaic_runtime::engine_version(), None);
        let info = engine::install_archive(&zip, &target).unwrap();
        assert!(info.installed);
        assert_eq!(
            info.version.as_deref(),
            Some(ollaic_runtime::engine_version())
        );
        assert!(target.join("assets/engine.js").is_file());
        engine::install_archive(&zip, &target).unwrap();
        assert!(!target.with_file_name(".engine.previous").exists());
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
    }
}

#[test]
fn invalid_archives_preserve_the_installed_engine_and_leave_no_staging_data() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("engine.zip");
    let target = temp.path().join("runtime/engine");
    archive(&zip, "", ollaic_runtime::engine_version(), None);
    engine::install_archive(&zip, &target).unwrap();
    let original = fs::read(target.join("index.html")).unwrap();
    for (version, extra) in [
        ("0.0.0", None),
        (ollaic_runtime::engine_version(), Some("../outside")),
    ] {
        archive(&zip, "", version, extra);
        assert!(engine::install_archive(&zip, &target).is_err());
        assert_eq!(fs::read(target.join("index.html")).unwrap(), original);
        assert!(engine::installed_info(&target).unwrap().installed);
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
        assert!(!temp.path().join("outside").exists());
    }
}

#[test]
fn rejects_symlinks_missing_runtime_metadata_and_oversized_archives() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("engine.zip");
    let target = temp.path().join("runtime/engine");
    let mut writer = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
    writer
        .add_symlink("index.html", "../../outside", SimpleFileOptions::default())
        .unwrap();
    writer.finish().unwrap();
    assert!(engine::install_archive(&zip, &target).is_err());
    let mut writer = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
    writer
        .start_file("index.html", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"not an engine").unwrap();
    writer.finish().unwrap();
    assert!(engine::install_archive(&zip, &target).is_err());
    fs::File::create(&zip)
        .unwrap()
        .set_len(MAX_ENGINE_ARCHIVE_BYTES + 1)
        .unwrap();
    assert!(engine::install_archive(&zip, &target)
        .unwrap_err()
        .contains("256 MiB"));
    assert!(!target.exists());
}

#[test]
fn recovers_the_previous_installation_after_an_interrupted_swap() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("engine.zip");
    let target = temp.path().join("runtime/engine");
    archive(&zip, "", ollaic_runtime::engine_version(), None);
    engine::install_archive(&zip, &target).unwrap();
    let backup = target.with_file_name(".engine.previous");
    fs::rename(&target, &backup).unwrap();
    assert!(engine::installed_info(&target).unwrap().installed);
    assert!(target.join("index.html").is_file());
    assert!(!backup.exists());
}

#[test]
fn rejects_oversized_engine_metadata_and_index_files() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("engine.zip");
    let target = temp.path().join("runtime/engine");
    archive(&zip, "", ollaic_runtime::engine_version(), None);
    engine::install_archive(&zip, &target).unwrap();
    let metadata = target.join("webgal-engine.json");
    fs::OpenOptions::new()
        .write(true)
        .open(&metadata)
        .unwrap()
        .set_len(64 * 1024 + 1)
        .unwrap();
    assert!(!engine::installed_info(&target).unwrap().installed);
    fs::write(
        metadata,
        serde_json::json!({"webgalVersion": ollaic_runtime::engine_version()}).to_string(),
    )
    .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(target.join("index.html"))
        .unwrap()
        .set_len(2 * 1024 * 1024 + 1)
        .unwrap();
    assert!(engine::validate(&target).unwrap_err().contains("2 MiB"));
}
