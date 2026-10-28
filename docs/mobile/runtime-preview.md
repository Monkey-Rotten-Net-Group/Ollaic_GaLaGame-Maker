# Native Runtime Preview

Android runs the pinned WebGAL web engine in a dedicated WebView. This first version
uses its normal entry screen and title menu to play `game/scene/start.txt`. Node jumps,
current-scene launch, and live draft synchronization remain future work. Desktop keeps its existing
preview controls and shares the HTTP/WebSocket host.

## Engine Installation

`crates/ollaic-runtime/webgal-version.txt` is the default engine version for desktop setup,
desktop installation, and the generated native APIs. Android accepts only that version.
Download uses its official GitHub web ZIP; Import accepts a flat archive or a single
wrapper directory containing `index.html`, `assets/`, and `webgal-engine.json`.

Archives are limited to 256 MiB, 2 GiB extracted, and 20,000 entries. Unsafe paths,
duplicate files, symbolic links, missing metadata, and mismatched versions are rejected.
Engine metadata is limited to 64 KiB and `index.html` to 2 MiB.
Extraction occurs beside the destination. A failed replacement preserves the installed
engine; an interrupted rename can restore its previous directory.

The engine lives at `files/runtime/webgal-<version>/`, outside managed projects. Downloads
use bounded temporary files and HTTPS redirects restricted to GitHub release hosts.
The first download requires internet access; an imported or installed engine runs offline.
Project ZIP export retains its existing authoring behavior and does not install this engine
inside the project or turn the archive into a published playable build.

## Playback And Lifecycle

Opening preview waits for the workspace save and library update. Save failure keeps the
editor visible with its error. The preview page distinguishes engine preparation, missing
engine, download, installation, loading, ready, and failure states. Readiness requires both
page completion and the real engine's `SYNCFC` WebSocket heartbeat, with a 30-second limit.
Readiness does not skip or dismiss the entry screen. Its normal user gesture resolves
the engine's initialization before the title menu becomes interactive.

The native WebView fills its host in both dimensions. Wrap-content sizing can force
Chromium's CSS layout height to zero, clipping the game stage even if its DOM exists.

Restart creates a new session and clears that preview origin's browser storage so it
starts from the title again. Fullscreen is optional. Back exits fullscreen first, then
returns to the same editor scene and scroll position. Closing releases WebView, sockets,
and the native server. Going into the background ends the rendering session; returning
to the foreground reloads from the beginning. Preview progress is intentionally temporary.

The host binds only to an ephemeral `127.0.0.1` port. Android sessions require a random
session cookie and matching WebSocket origin. The page can read engine files and the
selected project's `game/` resources, not private project/editor data. Canonical path
checks reject escapes, and only known built-in engine resource directories can fall back
to the engine template. User scripts and configuration never fall back to demo content.
Media use streamed responses with HTTP Range support. WebView allows only the session
origin, has no native JavaScript file-write bridge, and disables file/content URL access.

## Verification

Generated resource URLs encode spaces, script delimiters, fragments, and literal percent
characters. Editor fields and the shared desktop AST retain physical file names; encoding
and decoding happen at the script boundary. Title resource updates preserve inline comments
and configuration formatting.

Animation files use the lowercase `.json` extension and contain an array of frames with
nonnegative numeric durations. Their script identifiers omit that extension. Save, import,
rename, and delete keep `game/animation/animationTable.json` consistent with scripts and
files through the recoverable resource journal. The registry is managed internally and is
not offered as an editable animation asset. Adding the first custom animation preserves
the pinned engine's built-in registry entries.

```sh
cargo test --locked -p ollaic-runtime
WEBGAL_TEST_RUNTIME_ZIP=/path/to/WebGAL-4.6.0-web.zip pnpm test:runtime:contracts
WEBGAL_TEST_RUNTIME_ZIP=/path/to/WebGAL-4.6.0-web.zip ANDROID_SERIAL=emulator-5554 pnpm android:test:preview
```

The contract command runs generated resource, title, and animation cases through the actual
parser and animation lookup functions from the supplied pinned ZIP. It requires no browser,
emulator, or network access. The Rust tests independently cover editor round trips, resource
references, malformed input, path boundaries, and interrupted registry updates.

The Android command validates the local ZIP path before building, supplies the archive
to one selected emulator, and runs the preview repository and interaction tests. The
real-engine test imports that archive into an isolated cache directory, waits for the
production WebView and heartbeat, verifies that entry/title controls can receive input,
plays through a choice into another scene, restarts,
toggles fullscreen, and stops/resumes the Activity. It verifies return position,
unchanged project files, and released ports.
It checks DOM visibility and hit testing before semantic clicks; it never calls hidden
initialization targets directly. It uses no screenshots or coordinate clicks.

Normal instrumentation runs retain deterministic download/error tests and skip the
real-engine case unless `WEBGAL_TEST_RUNTIME_ZIP` is supplied. Set the same variable for
`pnpm android:test` to include it in the integrated regression. Downloads, test ZIPs,
and generated bindings remain outside Git. See [layered validation](validation.md)
for the separation between CLI assertions and user-owned visual/media acceptance.
