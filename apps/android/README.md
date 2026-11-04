# Ollaic Android

Independent Kotlin/Jetpack Compose application using Material 3 and the Ollaic brand palette.
The Gradle project calls the shared Rust core through generated UniFFI Kotlin bindings.
It does not include `apps/desktop/`, React, a Node build, the matting model,
or a Tauri runtime. WebView hosts local WebGAL playtesting and isolated SVG previews.

## Build

Requires JDK 21, Android SDK 36, an Android NDK, Rust stable, and access to
Google Maven/Maven Central and crates.io on the first build. The default ABI is ARM64:

```sh
rustup target add aarch64-linux-android
```

Install the NDK in Android Studio's SDK Tools panel. `ANDROID_NDK_HOME` or
`ANDROID_NDK_ROOT` can select an installation explicitly; otherwise the helper locates
an installed NDK under the SDK. Gradle supplies its configured SDK path to the helper.
The native build helper currently supports macOS and Linux hosts.

From `apps/android/`:

```sh
./gradlew :app:assembleDebug
```

From the repository root:

```sh
pnpm android:build
pnpm android:dev
pnpm android:open
pnpm android:test
```

`android:dev` builds, installs, and launches on an existing emulator. It does not start Vite
or provide web hot reload. A device is selected explicitly with `ANDROID_SERIAL`; otherwise
only an emulator is selected. `android:open` opens this independent project in Android Studio.
The APK is `app/build/outputs/apk/debug/app-debug.apk`.

Gradle's `buildNativeCore` task runs `scripts/build-native-core.sh`, builds only
`ollaic-ffi`, `ollaic-core`, and `ollaic-runtime`, generates Kotlin bindings, and packages
`libollaic_ffi.so` with JNA. Generated sources and libraries stay under `app/build/`.
Android Studio invokes the same task automatically; no generated source is checked in.
The Rust crate and bindgen CLI use the same pinned UniFFI version in `Cargo.lock`.

For an x86-64 emulator, install `x86_64-linux-android` and build with
`./gradlew :app:assembleDebug -PollaicAbis=x86_64`. Multiple ABIs can be supplied as a
comma-separated Gradle property, for example `-PollaicAbis=arm64-v8a,x86_64`.

## Project Workflow

Android shares WebGAL parsing, project storage, structured editing, character/asset catalogs,
and archive handling with the desktop through UniFFI. Native code owns Compose presentation,
document-provider streams, library metadata, and editor history. See the
[feature matrix and compatibility contract](../../docs/mobile/README.md) for behavior,
file formats, recovery, and pending capabilities.

The private library index is `files/native-home-drafts.json`; projects live under
`files/projects/<project-id>/`. Version-1 drafts migrate when opened and retain their
original JSON. A fresh install has no example projects. The application ID is unchanged
from the former Tauri APK, so in-place upgrades retain private files, but this app does
not read its legacy Web project library. Uninstalling removes private data.

## Focused Tests

```sh
pnpm test:core
pnpm android:test:unit
ANDROID_SERIAL=emulator-5554 pnpm android:test:bindings
ANDROID_SERIAL=emulator-5554 pnpm android:test:ui
WEBGAL_TEST_RUNTIME_ZIP=/path/to/WebGAL-4.6.0-web.zip ANDROID_SERIAL=emulator-5554 pnpm android:test:preview
```

Rust owns the complete 23-command edit/save/reload matrix and reference/metadata correctness.
JVM tests cover undo/redo and history bounds. The focused bindings suite uses the actual Rust
library and Android repositories for representative type mappings, file IO, errors and archives.
Compose tests use production components, semantic actions and stable tags for representative
controls, mode changes, save state, unsaved navigation and keyboard Back.

Run `pnpm android:test` for the integrated Android regression once features are integrated.
It builds and installs both APKs on one selected emulator, runs instrumentation,
and checks the test summary because `am instrument` can return a zero exit status on failures.
It never runs connected-device tests against every attached device. `ANDROID_TEST_CLASS`
selects a class or `Class#method` for a focused rerun. The unit command needs no device.
See [the layered validation workflow](../../docs/mobile/validation.md) for acceptance
criteria, synchronization, commit cadence and the small set of system-picker/media checks.

## Playtesting

The script toolbar and project tools open a separate preview after saving succeeds.
Install the pinned WebGAL version with Download or import its official web ZIP.
The engine stays in private application storage and works offline after installation.
Enter through the engine's normal entry screen and title menu. Restart begins a fresh
session, Fullscreen hides
the native toolbar, and Back returns to the same scene and scroll position.
See [native runtime preview](../../docs/mobile/runtime-preview.md) for installation,
lifecycle behavior, isolation, and the real-engine test workflow.

To inspect a ZIP exported by the Android UI with the desktop's shared project/parser code:

```sh
cargo run --locked -p ollaic-core --example inspect-project -- /path/to/project.zip
```

The optional second argument is text expected in a scene; the command fails if it is absent.
The shared core tests also cover unsafe ZIP paths/symlinks, size bounds, conflict handling,
interrupted-save recovery, special-character text, scene links and opaque project files.
