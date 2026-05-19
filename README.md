# gal

Gal editor desktop prototype.

## Current Architecture

This repository is now wired as a Tauri 2 desktop app:

- `src-tauri/` is the active Tauri shell.
- `design/` is the active React/Vite frontend loaded by Tauri.
- Root `package.json` owns the pnpm scripts used from the repository root.
- Root `Cargo.toml` is a Cargo workspace with `src-tauri` as its only member.
- Root `src/*.rs` is legacy GPUI prototype code. It is not built by `cargo check --workspace` or by Tauri unless it is moved into `src-tauri`.

## Tested Local Environment

Checked on this machine:

- Fedora Linux 43 COSMIC
- Node.js `v24.14.0`
- pnpm `10.33.0`
- Tauri CLI `2.10.1`
- Rust stable toolchain installed

If `cargo` says no default toolchain is configured, run:

```bash
rustup default stable
```

## Linux System Dependencies

Tauri on Linux needs WebKitGTK and GTK development files available through `pkg-config`.

On Fedora, install them with:

```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel pkgconf-pkg-config curl wget file
```

If `cargo check` reports missing `.pc` files such as `gio-2.0.pc`, `gdk-3.0.pc`, `cairo.pc`, `pango.pc`, `atk.pc`, or `javascriptcoregtk-4.1.pc`, the system dependencies above are not installed or `PKG_CONFIG_PATH` does not see them.

## Install JavaScript Dependencies

From the repository root:

```bash
pnpm install --frozen-lockfile
```

Do not install from `design/` directly. The repo uses the root `pnpm-workspace.yaml` and root `pnpm-lock.yaml`.

## Install WebGAL Runtime

The preview feature embeds the official WebGAL runtime. Run once after cloning:

```bash
bash scripts/setup-runtime.sh
```

This downloads `WebGAL-<version>-web.zip` from the OpenWebGAL release page and extracts it to `src-tauri/runtime/WebGAL_Template/` (gitignored). Override the version with `WEBGAL_VERSION=x.y.z`. The Tauri bundle picks the directory up as a resource for release builds; for dev builds the same path is read directly from the source tree.

## Run

Start the Tauri desktop app:

```bash
pnpm tauri:dev
```

This starts Vite for `design/` on port `1420` and then opens the Tauri window.

For frontend-only development in a browser:

```bash
pnpm dev
```

Then open `http://localhost:1420`.

## Verify

Use these checks from the repository root:

```bash
pnpm build
cargo +stable check --workspace
pnpm tauri:build
```

`pnpm build` verifies the React/Vite frontend. `cargo +stable check --workspace` verifies the Tauri Rust shell. `pnpm tauri:build` verifies the full desktop bundle path.

## Common Issues

Port `1420` is strict in `design/vite.config.ts`. If startup says the port is in use, stop the existing Vite process or change both `design/vite.config.ts` and `src-tauri/tauri.conf.json`.

If `pnpm tauri:dev` fails before opening a window with WebKitGTK, GTK, GLib, Cairo, Pango, ATK, or JavaScriptCore errors, install the Fedora packages listed above and rerun `cargo +stable check --workspace`.

If you only run `pnpm dev`, you are running the web frontend, not the desktop app.
