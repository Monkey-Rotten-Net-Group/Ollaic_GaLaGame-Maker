#!/usr/bin/env bash
# Download and install the WebGAL runtime template into apps/desktop/src-tauri/runtime/WebGAL_Template/.
#
# Run once after cloning the repo:
#     bash scripts/setup-runtime.sh
#
# Override the version with WEBGAL_VERSION=x.y.z. Re-run after deleting the
# target directory to upgrade.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${WEBGAL_VERSION:-$(tr -d '\r\n' < "$REPO_ROOT/crates/ollaic-runtime/webgal-version.txt")}"
TARGET="$REPO_ROOT/apps/desktop/src-tauri/runtime/WebGAL_Template"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -f "$TARGET/index.html" ]]; then
    echo "[setup-runtime] already installed at $TARGET"
    echo "[setup-runtime] remove that directory and re-run to reinstall"
    exit 0
fi

URL="https://github.com/OpenWebGAL/WebGAL/releases/download/${VERSION}/WebGAL-${VERSION}-web.zip"
echo "[setup-runtime] downloading WebGAL ${VERSION}"
echo "[setup-runtime]   $URL"
curl -fL --progress-bar -o "$TMP/web.zip" "$URL"

echo "[setup-runtime] extracting to $TARGET"
mkdir -p "$TARGET"
unzip -q "$TMP/web.zip" -d "$TARGET"

if [[ ! -f "$TARGET/index.html" ]]; then
    echo "[setup-runtime] error: extraction did not produce index.html" >&2
    exit 1
fi

echo "[setup-runtime] done"
