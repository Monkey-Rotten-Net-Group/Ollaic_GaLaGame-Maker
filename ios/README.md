# Ollaic iOS

Independent SwiftUI application for iPhone and iPad, targeting iOS 17 or later.
Open `Ollaic.xcodeproj` directly in Xcode; no project generator or third-party
Swift packages are required.

## Requirements

- macOS and Xcode 15 or later, with first-launch setup completed.
- iOS platform support, including the iOS Simulator SDK.
- To run the app: an iOS 17+ Simulator runtime installed in Xcode settings.

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
`ios/.build/Build/Products/Debug-iphonesimulator/Ollaic.app`.

`ios:dev` reuses a booted regular iPhone or selects and boots an available regular
iPhone. If none exists, it creates one using the newest installed runtime that
supports a regular iPhone. Duo-only runtimes are skipped for default selection.
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

- Create and edit local drafts, their synopsis, cover color, and favorite status.
- Browse all projects, five recent projects, favorites, or Trash; search by name
  and synopsis and sort by activity, name, or creation date.
- Move drafts to Trash, restore them, delete them permanently, or empty Trash.
- Open the native editor and keep the project library across application launches.

Draft metadata is stored in a versioned JSON document at
`Library/Application Support/ProjectLibrary/projects.json` inside the app sandbox.
Writes run on a repository actor and replace the document atomically; failed
loads do not overwrite existing data, and failed saves do not update the UI state.

## Initial Native Editor

Opening a project enters the editor. iPhone uses native Script, Scenes, Assets,
and Project tabs; iPad expands the scene list alongside the script. The homepage
sidebar collapses while editing so the workspace has the available width.

- Create, select, rename, and delete scenes, keeping at least one scene.
- Add or edit dialogue, narration, and notes using native forms.
- Duplicate, reorder, or delete entries through their context menus.
- Undo and redo up to 50 changes per project during the current app session,
  with one shared history across editor windows.
- Save project writing notes and edit project metadata.

Each confirmed form edit and workspace action is written atomically before it
appears as saved. Script content lives with the project in `projects.json`.
Opening an existing version-1 project initializes one empty scene and upgrades
the library to version 2. This prevents older builds from saving the library
without the new editor content. Both library versions can be read by this build.

These are native drafts, not initialized WebGAL projects. Assets have an empty
library view; import, runtime preview, AI, and export remain disabled. ZIP import
and shared Rust bindings remain future integration work. The app icon catalog
is a placeholder for the final product artwork. This target does not build React,
Tauri, Rust, or the matting model.

## UI Verification

The `OllaicTests` target verifies shared project undo/redo, persistence, project
isolation, history bounds, and write-failure recovery against the real repository.

The shared scheme includes a native simulator UI workflow covering creation, editing,
favorites, search, list/grid presentation, Trash/restore/permanent deletion, and
relaunch persistence. Tests exercise the production repository using an isolated
draft directory and preferences, and retain screenshots as test attachments.
The editor workflow additionally covers script entry editing, scenes, undo/redo,
writing notes, and restoring the workspace after restarting the app.

```sh
xcodebuild test -project ios/Ollaic.xcodeproj -scheme Ollaic \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UDID' \
  -collect-test-diagnostics never -parallel-testing-enabled NO \
  -derivedDataPath ios/.build CODE_SIGNING_ALLOWED=NO
```
