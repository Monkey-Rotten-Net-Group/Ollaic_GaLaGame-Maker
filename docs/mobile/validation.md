# Native mobile validation

See [native mobile integration](README.md) for implemented behavior and pending features.

Before changing a feature, state its observable acceptance conditions and assign
each condition to the lowest layer that can verify it reliably. Use production
parsers, repositories and components with isolated temporary projects.

| Layer | Responsibility | Focused command |
| --- | --- | --- |
| Rust core | All 23 command kinds, lossless editing, file persistence, catalog extensions, reference updates and recovery | `pnpm test:core` |
| Kotlin model | Undo/redo and bounded history | `pnpm android:test:unit` |
| UniFFI and Android repository | Representative record/enum/optional/list mappings, errors, real Android file IO and archive interoperability | `pnpm android:test:bindings` |
| Compose | Representative controls, source/form switching, save state, unsaved navigation and keyboard Back | `pnpm android:test:ui` |
| Runtime preview | Engine installation, actual WebView/engine handshake, entry playback, restart and session cleanup | `WEBGAL_TEST_RUNTIME_ZIP=/path/to/WebGAL-4.6.0-web.zip pnpm android:test:preview` |
| Visual acceptance (user) | Layout, animation, displayed media and complete system-picker workflows | User checks these together after integration |

## Acceptance coverage

- `crates/ollaic-core/tests/editor.rs` exercises every command kind through
  read, modification, actual workspace save and reload. Assert the complete
  edited record and preservation of other parameters, extension flags, inline
  comments and line endings. Parser and literal edge cases stay here.
- `crates/ollaic-core/tests/catalog.rs` verifies character/asset metadata,
  rename propagation across scripts and catalogs, owned/shared reference media,
  stale revisions and interrupted mutations. Verify all known reference owners
  with core assertions rather than opening each command in the emulator.
- `CoreBindingsTest` and `WorkspaceDraftStoreTest` call the packaged Rust library
  and write real files in unique cache directories. Cover cross-language and
  platform contracts without duplicating the complete Rust command matrix.
- `EditorInteractionTest` mounts production Compose components. Text, choice,
  numeric, asset and character-linked fields represent shared control shapes;
  each command using those controls does not need a duplicate UI scenario.
  Save/dirty/error states and navigation belong at this layer.
- `RuntimePreviewRepositoryTest` injects HTTP responses for deterministic download,
  cancellation, version rejection, and replacement recovery. `RuntimePreviewTest`
  checks save failure and uses the actual engine ZIP for playback and lifecycle
  assertions. See [runtime preview](runtime-preview.md) for fixture setup and coverage.

For a feature commit, record which acceptance conditions passed, the focused
command and any untested platform boundary. An APK build is not a device test.

## Development cycle

1. Define acceptance conditions, implement one complete feature, and run the
   relevant focused checks. A Rust data regression should be reproduced on the
   host before rebuilding Android.
2. Commit that feature with its validation results. Keep implementation fixes
   with their feature and avoid accumulating unrelated changes for a large final
   emulator session.
3. At integration completion, run `pnpm test:rust`,
   `pnpm bindings:test:swift` when shared interfaces changed, and
   `ANDROID_SERIAL=emulator-5554 pnpm android:test` once. The Android command
   runs JVM and all instrumented tests on the selected device.
4. Hand the user a concise list of affected visual/boundary checks: for example,
   phone/wide layouts, animation, media playback/seek and system document pickers.
   The user handles screen-based acceptance together; the agent does not manually
   click through the emulator or capture screenshots. CLI checks can inspect an
   exported ZIP with
   `cargo run --locked -p ollaic-core --example inspect-project -- /path/to/export.zip`.
   Assert data in core/integration tests and report visual acceptance separately.
5. After a fix, rerun affected checks. Repeat the broad regression only if the
   fix changes shared behavior or leaves an unresolved integration concern.

## Test selection and synchronization

`android:test:unit` needs no device. Instrumented commands honor
`ANDROID_SERIAL` and otherwise choose one running emulator, never every attached
device. A single class or method can be selected without editing a script:

```sh
ANDROID_TEST_CLASS=com.ollaic.galagame_maker.ui.EditorInteractionTest#keyboardBackPreservesBottomSheetDraft pnpm android:test:ui
```

UI and integrated commands temporarily enable the on-screen keyboard while a hardware
keyboard is attached, then restore the device's original setting on exit. This keeps
IME/Back assertions meaningful on headless emulators without changing user preferences.
Instrumentation also collapses system panels before launch so the notification shade
cannot retain input focus from an earlier interaction.

Compose uses semantic actions and stable `testTag` values such as
`command-mode-source`, `command-save`, `field-character_name` and
`asset-pick-bgm`. Field tags use resource entry names, not translated text or
numeric resource IDs. Repeated controls are scoped to their item ancestor.
Use `waitUntil` for a save callback, saved state or actual IME visibility;
use Compose idle synchronization for ordinary actions. Tests clean up their
temporary projects and do not alter the user's library.

The agent runs CLI checks, including automated semantic Compose assertions; the
user owns tests requiring visual inspection. Do not extend temporary coordinate
scripts, manually navigate the emulator, or capture screenshots for acceptance.
If system UI automation is explicitly requested later, reserve it for system
boundaries and wait for a selected document result, completed save, exported file
or media state with a bounded timeout. Do not use fixed sleeps to guess completion.

Gradle tracks native source, manifests and UniFFI configuration as native build
inputs. Editing only Rust test cases/fixtures or Compose tests does not regenerate
bindings or rebuild the native library.
