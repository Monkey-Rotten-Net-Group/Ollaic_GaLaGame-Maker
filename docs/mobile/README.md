# Native Mobile Integration

## Ownership

- `crates/ollaic-core`: platform-independent WebGAL scripts, desktop metadata schema, atomic files, projects,
  transaction recovery, safe archives and basic assets.
- `crates/ollaic-ffi`: typed UniFFI project/scene/asset and structured command APIs. Kotlin and Swift are
  generated from the same compiled library metadata and locked dependency version.
- `crates/ollaic-runtime`: shared local HTTP/WebSocket hosting, engine ZIP installation,
  the pinned WebGAL version, and native preview sessions.
- `apps/desktop/src-tauri/`: desktop commands, asset protocol permissions, preview, AI and other
  desktop orchestration. Script and basic project operations delegate to the core.
- `apps/android/`: Compose UI, document-provider streams, native library index and editor history.
- `apps/ios/`: current SwiftUI draft app. Generated Swift bindings have a host smoke test;
  the app's library packaging and storage migration are the next platform integration.

## Feature Matrix

| Desktop capability | Android status | Entry |
| --- | --- | --- |
| Create/open WebGAL projects | Implemented with private managed projects and ZIP import | Home |
| Library search/favorites/Trash | Implemented | Home |
| Scene create/rename/delete | Implemented; entry filename protected; scene links updated | Scenes |
| Script commands | Structured forms for all 23 desktop command kinds; raw entry and full scene editing | Script |
| Command clipboard/search | Pending; duplicate/reorder and native text-field clipboard remain available | Command/project menus |
| Undo/redo and autosave | Implemented; 50 states; save before close/export | Script/header |
| Scene text import/export | Implemented through system document pickers | Project menu |
| Project ZIP import/export | Implemented; metadata, opaque files and existing engine files retained | Home/project menu |
| Asset browsing/import/search | Implemented, including nested assets and reference media; filename and alias search | Assets/pickers |
| Asset insertion | Background, figure, BGM, voice/effect, video and animation references | Asset menu |
| Image/audio/video preview | Android bitmap formats, isolated offline SVG, audio/video playback and seeking | Assets/pickers |
| Asset metadata/usage | Aliases, descriptions, tags, reference media and source locations | Asset menu |
| Asset rename/delete | Revision checked; rename updates scripts, characters and reference directories; deletion rejects known usages | Asset menu |
| Character management | Profiles, aliases, sprites/emotions, reference images, voice defaults and relations | Project tools/figure editor |
| Animation management | JSON create/edit, validation, revision checks and asset operations | Project tools/Assets |
| Project name/synopsis | Implemented | Project |
| Runtime preview | Implemented from the game entry point with a separately installed engine | Script/project tools |
| Playable publishing | Pending; project ZIP export remains available | Project tools |
| Scene graph | Pending | Project tools |
| Chapters/outlines, voice synthesis and matting | Pending | Project tools |
| Snapshots and AI project memory | Pending | Project tools |
| AI assistant, reference uploads and production Flow | Pending | Project tools |
| Advanced game/application settings | Pending | Project tools/home menu |

Pending entries open an explicit availability message; they do not simulate successful actions.

## Compatibility And Persistence

Projects use the desktop `game/config.txt`, `game/scene/*.txt` and asset layout. Existing
project metadata and unfamiliar files are preserved rather than rewritten from a reduced model.
Native visual identities/order are stored separately in `.ollaic/mobile-editor.json`.
The Android writing-notes editor has been removed. Existing notes remain in mobile editor
data and survive saves, legacy draft migration, and exports; they are separate from desktop AI memory.
The shared editor keeps original source for unmodified entries. Engine continuations remain
source entries, and unknown/custom syntax can be edited in the complete scene source view.

Structured editing covers every command kind currently offered by the desktop editor. Choices support
add/remove/reorder, scene or label targets and continuing without a jump. Scene and label menus
retain manually entered targets. Common next/when controls preserve voice and unfamiliar flags.
Only edited fields are rewritten; no-op saves retain original source bytes, comments and line endings.
Script cards show concrete types for all 23 recognized command kinds and parsed parameter previews.
These display fields are derived from source, including for existing editor caches; raw multiline
entries retain their source preview. Preview text is never substituted for editable script source.
The shared `CommandEdit` model validates required fields, volume, figure positions and JSON objects.
Media controls select project assets, preserve manual resource names, clear resources, preview media
and set volume. Figure controls link characters/emotions to sprites; gallery commands select CG/BGM
assets and appreciation names. Dialogue/narration controls select voice files.

Character data uses the desktop `game/config/characters.json` version-1 schema; unknown document,
character, sprite and relation fields survive edits. Implicit desktop sprite variants resolve through
the character directory/emotion filename convention. Asset metadata uses `game/config/asset-metadata.json`.
Reference media retain the desktop character, background and audio directory layouts. A durable
`.ollaic/mobile-asset-pending.json` completes interrupted asset mutations before subsequent reads.
Renames publish copies without overwriting existing files before changing references and removing
old assets; shared audio reference folders are retained for remaining owners. Android forbids hard
links, so the publishing path reuses the same temporary-file operation as asset imports.

Native version-1 drafts migrate when opened. A staging project is initialized, populated,
and activated on the same filesystem after writes succeed. Legacy JSON is not deleted.
Scene writes use a durable pending document; subsequent shared-core reads complete an
interrupted multi-file save. Revision checks reject overwriting an externally modified scene.

ZIP import accepts one project at the archive root or within one wrapper directory. Limits
are 512 MiB for the ZIP, 2 GiB extracted and 20,000 entries; traversal, duplicate files and
symlinks are rejected. Script/editor limits are checked before exposing documents to the UI.
Export warnings report missing referenced assets and a missing runtime/entry scene.
Project archives can resume desktop authoring; a missing engine is not generated by export.

## Validation

See [native runtime preview](runtime-preview.md) for engine installation, offline
playtesting, session lifecycle, and real WebView verification.

See [native validation](validation.md) for canonical commands, acceptance coverage,
and platform boundaries. Platform setup lives in the [Android](../../apps/android/README.md)
and [iOS](../../apps/ios/README.md) guides. Swift host validation does not prove iOS
Simulator or device linking; the SwiftUI application still uses its draft repository.
