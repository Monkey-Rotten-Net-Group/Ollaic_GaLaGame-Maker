use crate::project::{self, ProjectInfo};
use crate::{Error, Result};
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::SimpleFileOptions;

pub const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_ARCHIVE_ENTRIES: usize = 20_000;

pub fn extract_archive(reader: impl Read + Seek, destination: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(reader)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(Error::Invalid(
            "Project archive contains too many files".into(),
        ));
    }
    fs::create_dir_all(destination)?;
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| Error::Invalid("Project archive contains an unsafe path".into()))?;
        if entry.name().contains(['\\', ':'])
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(Error::Invalid(
                "Project archive contains an unsupported path or symbolic link".into(),
            ));
        }
        if entry.size() > MAX_EXTRACTED_BYTES.saturating_sub(total) {
            return Err(Error::Invalid(
                "Extracted project exceeds the 2 GiB limit".into(),
            ));
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(output)?;
        } else {
            fs::create_dir_all(output.parent().unwrap())?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)?;
            total += std::io::copy(&mut entry.take(MAX_EXTRACTED_BYTES - total + 1), &mut file)?;
            if total > MAX_EXTRACTED_BYTES {
                return Err(Error::Invalid(
                    "Extracted project exceeds the 2 GiB limit".into(),
                ));
            }
        }
    }
    Ok(())
}

pub fn find_project_root(extracted: &Path) -> Result<PathBuf> {
    fn is_project(path: &Path) -> bool {
        path.join("game/config.txt").is_file() && path.join("game/scene").is_dir()
    }
    if is_project(extracted) {
        return Ok(extracted.to_owned());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(extracted)? {
        let path = entry?.path();
        if is_project(&path) {
            candidates.push(path);
        }
    }
    if candidates.len() != 1 {
        return Err(Error::Invalid(
            "ZIP must contain one WebGAL project with game/config.txt and game/scene/".into(),
        ));
    }
    Ok(candidates.remove(0))
}

pub fn import_project(archive: &Path, target: &Path) -> Result<ProjectInfo> {
    if target.exists() {
        return Err(Error::Invalid("Import destination already exists".into()));
    }
    if fs::metadata(archive)?.len() > MAX_ARCHIVE_BYTES {
        return Err(Error::Invalid(
            "Project archive exceeds the 512 MiB limit".into(),
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| Error::Invalid("Missing project library".into()))?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".import-")
        .tempdir_in(parent)?;
    let contents = staging.path().join("contents");
    extract_archive(fs::File::open(archive)?, &contents)?;
    let source = find_project_root(&contents)?;
    project::open_project(&source)?;
    project::project_description(&source)?;
    if project::load_workspace(&source)?.document.scenes.is_empty() {
        return Err(Error::Invalid("Project contains no scenes".into()));
    }
    fs::rename(source, target)?;
    project::open_project(target)
}

pub fn export_project(root: &Path, archive: &Path) -> Result<Vec<String>> {
    project::with_project(root, |root| {
        let archive_parent = archive
            .parent()
            .ok_or_else(|| Error::Invalid("Missing export destination".into()))?;
        fs::create_dir_all(archive_parent)?;
        if archive_parent.canonicalize()?.starts_with(root) {
            return Err(Error::Invalid(
                "Export destination must be outside the project".into(),
            ));
        }
        project::checked_file(root, "game/config.txt")?;
        let snapshot = project::load_workspace_unlocked(root)?;
        if snapshot.document.scenes.is_empty() {
            return Err(Error::Invalid("Project contains no scenes".into()));
        }
        let mut warnings = Vec::new();
        for scene in &snapshot.document.scenes {
            for reference in crate::webgal::references::find_asset_references(&scene.source) {
                let name = crate::document::unescape_literal(&reference.filename);
                if !root
                    .join("game")
                    .join(reference.category)
                    .join(&name)
                    .is_file()
                {
                    warnings.push(format!(
                        "{}:{}: missing {}/{}",
                        scene.file_name, reference.line_number, reference.category, name
                    ));
                }
            }
        }
        let temporary = tempfile::NamedTempFile::new_in(archive_parent)?;
        let mut writer = zip::ZipWriter::new(temporary.reopen()?);
        let mut count = 0usize;
        let mut bytes = 0u64;
        write_directory(&mut writer, root, Path::new(""), &mut count, &mut bytes)?;
        writer.finish()?.sync_all()?;
        if temporary.as_file().metadata()?.len() > MAX_ARCHIVE_BYTES {
            return Err(Error::Invalid(
                "Project archive exceeds the 512 MiB limit".into(),
            ));
        }
        temporary.persist(archive).map_err(|error| error.error)?;
        if !root.join("game/scene/start.txt").is_file() {
            warnings.push("Project has no start.txt entry scene".into());
        }
        if !root.join("index.html").is_file() {
            warnings.push(
                "Project archive contains authoring files; a WebGAL runtime is needed to play it"
                    .into(),
            );
        }
        Ok(warnings)
    })
}

fn write_directory(
    writer: &mut zip::ZipWriter<fs::File>,
    root: &Path,
    relative: &Path,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(root.join(relative))?.collect::<std::io::Result<_>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for entry in entries {
        let name = entry.file_name();
        if (relative.as_os_str().is_empty() && name == ".git")
            || (relative == Path::new(".ollaic")
                && matches!(
                    name.to_str(),
                    Some("mobile-pending.json" | "mobile-pending.json.tmp")
                ))
        {
            continue;
        }
        let path = entry.path();
        project::reject_symlink(&path)?;
        let relative = relative.join(&name);
        let zip_name = relative
            .to_str()
            .ok_or_else(|| Error::Invalid("Project path is not UTF-8".into()))?
            .replace('\\', "/");
        *count += 1;
        if *count > MAX_ARCHIVE_ENTRIES {
            return Err(Error::Invalid("Project contains too many files".into()));
        }
        if path.is_dir() {
            writer.add_directory(format!("{zip_name}/"), options)?;
            write_directory(writer, root, &relative, count, bytes)?;
        } else {
            let length = fs::metadata(&path)?.len();
            *bytes = bytes.saturating_add(length);
            if *bytes > MAX_EXTRACTED_BYTES {
                return Err(Error::Invalid("Project exceeds the 2 GiB limit".into()));
            }
            writer.start_file(zip_name, options)?;
            std::io::copy(&mut fs::File::open(path)?, writer)?;
        }
    }
    writer.flush()?;
    Ok(())
}
