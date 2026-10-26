# Ollaic Android

Independent Kotlin/Jetpack Compose application using Material 3 and the Ollaic brand palette.
The Gradle project does not include `design/`, `src-tauri/`, WebView, React, a Node build,
Rust libraries, the matting model, or a Tauri runtime.

## Build

Requires JDK 21, Android SDK 36, and access to Google Maven/Maven Central on the first build.
An NDK and Rust toolchain are not required for this UI prototype.

```sh
./gradlew :app:assembleDebug
```

From the repository root:

```sh
pnpm android:build
pnpm android:dev
pnpm android:open
```

`android:dev` builds, installs, and launches on an existing emulator. It does not start Vite
or provide web hot reload. A device is selected explicitly with `ANDROID_SERIAL`; otherwise
only an emulator is selected. `android:open` opens this independent project in Android Studio.
The APK is `app/build/outputs/apk/debug/app-debug.apk`.

## Prototype Scope

- Native home, search, filters, list/grid presentation, menus, dialogs, and system dark mode.
- Local UI drafts with name, description, favorites, trash, and an atomic private metadata file
  at `files/native-home-drafts.json`. These are not initialized WebGAL projects.
- Selecting a project opens a native workspace. New projects open it immediately with one empty scene.
- The workspace has script, scene, asset, and project views. Phones use bottom navigation;
  wide screens use a navigation rail and a scene sidebar.
- Local script drafts support dialogue, narration, notes, duplicate/reorder/delete actions,
  and up to 50 undo states. Scene creation, rename, deletion, and project notes stay native.
- Workspace drafts are saved atomically at `files/workspaces/<project-id>/workspace.json`,
  with a 600 ms autosave debounce, explicit save, and save-before-return navigation.
  Editor state survives configuration changes; saved documents survive process restarts.
- Workspace JSON is an Android draft format, not a WebGAL script. Asset import, runtime preview,
  ZIP import/export, and AI/Agent execution await the shared Rust core.
- No example projects are inserted into a fresh install.
- This build uses the existing Android application ID. Installing over the previous Tauri APK
  retains its private files, but the prototype does not read the legacy Web project library.

The future integration boundary is a shared Rust core exposed through native bindings such as
UniFFI. Desktop presentation stays in React/Tauri, and Android presentation stays in this project.
The existing Tauri Android test harness remains under `src-tauri/gen/android/` and is available
through the root `android:tauri:*` scripts; it is not a dependency of this application.

## Focused Tests

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebugAndroidTest
```

The JVM tests cover undo/redo and history bounds. Instrumented tests cover workspace persistence,
project isolation, invalid writes/paths, and compatibility with the original home draft index.
Install and run the instrumentation APK on a specifically selected emulator with `adb -s SERIAL`;
avoid running connected-device tasks against every attached device.
