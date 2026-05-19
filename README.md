# gal

A desktop editor for [WebGAL](https://docs.openwebgal.com/) visual novels — build scenes node by node, preview with the official WebGAL runtime, and export a runnable game. AI-assisted scripting included.

## Prerequisites

- Node.js 20+ and pnpm 10+
- Rust stable (`rustup default stable`)
- On Linux: WebKitGTK + GTK dev packages (see footnote)

## Setup

```bash
pnpm install --frozen-lockfile
bash scripts/setup-runtime.sh
```

The first command installs JavaScript dependencies (from the repo root — never from `design/` directly).

The second downloads the WebGAL runtime release zip and extracts it into `src-tauri/runtime/WebGAL_Template/` (gitignored). Override the version with `WEBGAL_VERSION=x.y.z`. You can also reinstall at any time from inside the app via **Settings → WebGAL 运行时 → 下载并安装**.

## Run

```bash
pnpm tauri:dev
```

Vite serves the frontend on port `1420`; Tauri opens the desktop window. Click **试玩** in the top bar to launch the embedded WebGAL preview in your default browser.

## Linux dependencies

Tauri on Linux needs WebKitGTK + GTK + a few helpers through `pkg-config`. On Fedora:

```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel pkgconf-pkg-config curl wget file
```

Debian/Ubuntu and Arch ship equivalent `-dev` / `-devel` packages. If `cargo check` complains about a missing `.pc` file (e.g. `gio-2.0.pc`, `javascriptcoregtk-4.1.pc`), install the matching package.
