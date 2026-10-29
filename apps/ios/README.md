# Ollaic iOS

Independent SwiftUI application for iPhone and iPad, targeting iOS 17 or later.
Open `Ollaic.xcodeproj` directly in Xcode; no project generator or third-party
Swift packages are required.

## Requirements

- macOS and Xcode 15 or later, with first-launch setup completed.
- iOS platform support, including the iOS Simulator SDK.
- To run the app: an iOS 17+ Simulator runtime installed in Xcode settings.
- Rust and the locked workspace dependencies. Install the targets used by Xcode:

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

The checked-in project invokes `scripts/build-ios-core.sh` before compiling Swift.
It generates UniFFI sources and links a static library for each requested architecture.
Generated files stay in ignored `.generated/`; Cargo artifacts stay in `target/`.
The build uses Apple Clang and keeps the host binding generator outside the iOS SDK.
Opening Xcode directly and the repository helpers use this build phase.

Install a runtime supporting a regular iPhone in Xcode > Settings > Components.
Under Other Installed Platforms, choose Add Platforms to select a specific OS
version. For Xcode 27 on an Apple Silicon Mac, install iOS 27.0 explicitly:

```sh
xcodebuild -downloadPlatform iOS -buildVersion 27.0 -architectureVariant arm64
```

The iOS 27.1 runtime currently provided for this setup supports only iPhone Duo.
Omitting `-buildVersion` may download it as well as other available versions.

Simulator builds do not require a development team or paid developer membership.
For a physical device, choose your team in the target's Signing & Capabilities
settings and use a bundle identifier available to that team.

## Development

From the repository root:

```sh
pnpm ios:open
pnpm ios:build
pnpm ios:dev
```

`ios:open` opens the checked-in project in Xcode. Select the `Ollaic` scheme and
an iPhone or iPad simulator, then click Run.

`ios:build` produces an unsigned Debug simulator app at
`apps/ios/.build/Build/Products/Debug-iphonesimulator/Ollaic.app`.

`ios:dev` first uses an explicit `IOS_SIMULATOR_UDID`. Otherwise, it discovers and
reuses a booted iPhone or iPad running iOS 17 or later. If several are running, it
prefers the repository-local `ollaic.iosSimulatorUDID` when that device is among
them; otherwise it uses the first device from the newest runtime.

When no compatible device is running, it boots the saved default. Without a saved
default, it selects an available regular iPhone, or creates one using the newest
installed runtime supporting a regular iPhone. Duo-only runtimes are skipped for
this fallback selection. Automatic discovery never changes the saved default.
It then builds, installs, and launches the app, restarting it if it is already
running. Runtime downloads remain a separate setup step.

The helper opens the Simulator app bundled with the selected Xcode, or DeviceHub
on Xcode 27 and later. DeviceHub is focused on the selected simulator.

To select a particular existing simulator, including an iPad or iPhone Duo, set
`IOS_SIMULATOR_UDID`:

```sh
xcrun simctl list devices available
IOS_SIMULATOR_UDID=YOUR_SIMULATOR_UDID pnpm ios:dev
```

To remember a default device for this checkout:

```sh
git config --local ollaic.iosSimulatorUDID YOUR_SIMULATOR_UDID
pnpm ios:dev
```

This preference stays in `.git/config` and acts as a fallback when no compatible
device is running. An explicit `IOS_SIMULATOR_UDID` overrides discovery. Test
commands keep using the saved default before automatic selection. Remove the
saved fallback with:

```sh
git config --local --unset ollaic.iosSimulatorUDID
```

Set `IOS_DERIVED_DATA_PATH` to an absolute path to change the build output directory.
The shell commands can also be run directly without pnpm:

```sh
bash scripts/ios-native.sh build
```

The `dev` helper parses the simulator inventory with macOS's built-in Ruby.

## Runtime Management

A runtime is the shared operating-system image. A simulator device is a particular
model with its own installed apps and data. Several devices can share one runtime.

- Install or remove OS versions in Xcode > Settings > Components. Use Add Platforms
  to install another version, or the information button beside an installed version
  to remove it.
- Create, start, shut down, or delete devices in DeviceHub on Xcode 27. Removing a
  device does not remove its runtime.
- Removing a runtime makes devices using that OS version unavailable until the
  runtime is installed again.

Inspect installed versions, runtime image identifiers, and available devices:

```sh
xcrun simctl list runtimes
xcrun simctl runtime list
xcrun simctl list devices available
```

See Apple's [Xcode component management documentation](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

## Native Project Library

The homepage follows the desktop project library with native SwiftUI navigation,
search, menus, forms, context menus, and list swipe actions. iPhone uses a compact
filter picker; iPad uses a sidebar. The grid and list layouts, sorting, system
light/dark appearance, Dynamic Type, English, and Simplified Chinese are supported.
The app supports one independent window scene on iPhone and iPad. Multiple app
windows are disabled explicitly in both Debug and Release configurations.

- Create and edit projects, their synopsis, cover color, and favorite status.
- Browse all projects, five recent projects, favorites, or Trash; search by name
  and synopsis and sort by activity, name, or creation date.
- Move drafts to Trash, restore them, delete them permanently, or empty Trash.
- Import WebGAL project ZIPs through Files and keep the library across launches.

Draft metadata is stored in a versioned JSON document at
`Library/Application Support/ProjectLibrary/projects.json` inside the app sandbox.
Writes run on a repository actor and replace the document atomically; failed
loads do not overwrite existing data, and failed saves do not update the UI state.

## Shared WebGAL Editor

Opening a project pushes a full-width editor above the project library. iPhone uses
native Script, Scenes, Assets, and Project tabs; iPad expands the scene list alongside
the script. The library retains its sidebar layout throughout push/pop transitions;
the editor's scene list is independent of that sidebar.

- Create, select, rename, and delete scenes. The `start.txt` entry filename is protected;
  renaming another scene updates script references. Creating a scene preserves the current
  tab and selection until the new scene is selected explicitly.
- Add or edit all 23 structured command kinds, including choices, variables, media,
  transforms, character-linked figures, animations and gallery unlocks. Fields retain manual
  targets; pickers provide scene, label, character and asset choices.
- Figure resources, characters and sprite variants use object pickers. The optional WebGAL
  figure instance ID stays under Advanced; ordinary figure selection does not require typing it.
- Change an existing command's type from its form. Text-to-text conversions retain content
  and speaker; execution conditions remain shared. Other fields use the new type's defaults,
  and scene commands initially target the first scene. Changes are written only on Save.
- Edit raw commands or complete scene source. Import scene text as a new scene through Files,
  reject duplicate filenames and preserve the current scenes; export the selected scene as text.
- Keep open command drafts synchronized with shared workspace changes. Merge independent form/source
  edits, preserve incoming resource references and require an explicit choice for conflicting changes.
  Source-only parameters and inline comments survive mode changes and subsequent synchronization.
  Whole-scene source editing also rejects overlapping project changes.
- Duplicate, reorder, or delete entries through their context menus. Moving an entry skips hidden
  blank lines while retaining their bytes and the shared undo history.
- Undo and redo up to 50 changes per project during the current app session,
  with history retained when returning from the library to the editor.
- Browse/search/import assets by category, inspect native image/audio/video previews,
  insert commands, edit aliases/descriptions/tags/reference links, inspect usages and
  rename/delete with shared revision and reference checks.
- Search assets by filename or alias and import/preview them directly inside command and character
  fields without closing the parent draft. Reference pickers stay within their owner's directory;
  reference metadata stores owner-relative names and normalizes earlier prefixed iOS values on save.
- Manage characters, profiles, sprites, relations, reference images and voice defaults.
  New characters must be saved before importing references into their assigned directory.
- Search characters by name, aliases, description, personality or keywords. Reorder sprites in the
  character form; their saved order also determines the first available sprite selected by default.
- Resolve character names, IDs and aliases in figure forms; selected figures write canonical names
  for Android compatibility. Sprite/emotion and asset selection update each other. Dialogue speaker
  suggestions include aliases and fill an empty voice field from the character's default.
  Character forms protect unsaved changes and confirm cancellation before discarding them.
- Create/edit validated animation JSON. The shared core maintains the animation registry.
- Export project ZIPs through the system share sheet, including Save to Files. Export
  warnings appear before sharing; archives retain opaque files and desktop metadata.
- Run WebGAL from the game beginning in WKWebView, with engine download/ZIP installation,
  restart, fullscreen, and background/close cleanup.

Confirmed edits are saved before the UI advances. Filesystem work runs on actors outside
the main actor. Revision conflicts preserve the editor state and report an error; Reload
reads external changes and clears obsolete undo history. Asset and catalog mutations also
reload scripts and clear history because references may have changed.
Resource rewrites retain scene display names and ordering, and repair the version-2 editor cache
before export. Cached sources follow Android's lossless reconstruction rules for multiline blocks.
Successful native edits, undo/redo and resource changes update the library's activity time;
opening a cached editor still records a new open time. If the library index cannot be written
after content commits, the saved content and history remain valid and the index error is reported.
Selecting an asset usage opens the exact command, including statements grouped across physical
lines, or the referenced character. Non-editable configuration usages remain visible and disabled.

Preview keeps its session during brief inactive interruptions, such as opening Control Center.
Entering the background stops the session; returning starts a new preview from the beginning.

Managed projects live beside the index in `ManagedProjects/<UUID>/`, using the same `game/`
layout as desktop and Android. Sandbox-relative IDs survive app updates. Opening a version-1/2
draft stages a WebGAL project, converts scenes, retains notes and activates it after successful
writes. The version-3 index retains the legacy draft; older builds reject it instead of
overwriting shared content. Failed index writes remove newly staged imports/migrations.
Metadata is reconciled from WebGAL on load. Trash retains managed files; permanent deletion
removes only that project's managed directory.

The writing-notes editor is removed to match Android; existing notes survive migration,
saves and export. AI, scene graphs, playable publishing and the other pending Android
features remain pending. The app icon catalog is still placeholder artwork. This target
builds SwiftUI and Rust, without React, Tauri or the matting model.

See [mobile integration](../../docs/mobile/README.md) for shared formats and scope,
and [runtime preview](../../docs/mobile/runtime-preview.md) for engine and session behavior.

## Validation

The `OllaicTests` target verifies legacy history, shared-core migration and ZIP round trips,
workspace reuse, scene references, revision failures and WKWebView readiness,
restart and port cleanup using isolated directories. Default tests are offline. The real
pinned-engine test is skipped unless its ZIP is supplied.
`NativeEditorRegressionTests` covers multiline serialization, persisted activity times,
concurrent/index-failure boundaries, asset-usage routing and background-only preview restart.
`NativeParityTests` covers additive scene imports, draft synchronization/conflicts, resource refresh
identity, reference ZIP compatibility, character/voice linkage, picker filtering, exact usage targets
and unsaved character changes. These tests use temporary projects and the production Swift/Rust APIs.

The default `Ollaic` scheme and `ios:test` command run only these non-interactive native
tests. A simulator may host the app and WKWebView, but the tests do not tap or type through
SwiftUI or click WebGAL controls. Runtime checks inspect loading, heartbeat, storage,
project files and session cleanup. Entry/title/choice interaction belongs to user acceptance.
`AppConfigurationTests` checks the built scene manifest and UIKit's runtime capability
to prevent independent multi-window support from being enabled accidentally.

```sh
pnpm ios:test:unit
pnpm ios:test
pnpm ios:test:script
WEBGAL_TEST_RUNTIME_ZIP=/path/to/WebGAL-4.6.0-web.zip pnpm ios:test:preview
IOS_SIMULATOR_UDID=YOUR_IPAD_UDID pnpm ios:test
```

Test helpers use the same simulator selection as `ios:dev`, without opening the simulator
host window. Follow [validation ownership](../../docs/mobile/validation.md#ownership):
the agent runs focused non-interactive regressions while iterating, then the applicable full
native suite at handoff. The user performs UI clicking and complete phone/iPad acceptance.

Existing XCUITest journeys are kept in the separate `OllaicUI` scheme for optional,
explicitly requested diagnostics. They cover the library and editor with isolated projects
and preferences. They are not a default check or an agent handoff requirement:

```sh
pnpm ios:test:ui
```

Only this optional command opens the simulator host for XCTest accessibility.
The engine ZIP is copied only into the unsigned test app product for `test-without-building`
and removed afterward. It is never a production resource. `pnpm bindings:test:swift` remains
a separate macOS ABI smoke test, not evidence of iOS linking. Physical-device signing,
Files/iCloud providers, media output and phone/iPad visual acceptance require user validation.
