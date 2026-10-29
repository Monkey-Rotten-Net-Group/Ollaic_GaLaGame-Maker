#!/usr/bin/env bash
set -euo pipefail
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$project_root/apps/ios/.generated"
platform="${PLATFORM_NAME:-iphonesimulator}"
architectures="${ARCHS:-arm64}"
case "$platform" in
  iphoneos|iphonesimulator) ;;
  *) printf 'Unsupported iOS platform: %s\n' "$platform" >&2; exit 2 ;;
esac
cd "$project_root"
export CC=/usr/bin/clang CXX=/usr/bin/clang++
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/clang
export IPHONEOS_DEPLOYMENT_TARGET=17.0
# The host generator must not inherit the simulator SDK from Xcode.
env -u SDKROOT cargo build --locked -p ollaic-ffi --lib
env -u SDKROOT cargo run --locked -p ollaic-ffi --features bindgen --bin ollaic-bindgen -- generate \
  --library "$project_root/target/debug/libollaic_ffi.dylib" --language swift --out-dir "$output" --no-format

libraries=()
for arch in $architectures; do
  case "$platform/$arch" in
    iphoneos/arm64) target=aarch64-apple-ios ;;
    iphonesimulator/arm64) target=aarch64-apple-ios-sim ;;
    iphonesimulator/x86_64) target=x86_64-apple-ios ;;
    *) printf 'Unsupported iOS architecture: %s/%s\n' "$platform" "$arch" >&2; exit 2 ;;
  esac
  if ! rustup target list --installed | grep -qx "$target"; then
    printf 'Install the Rust target first: rustup target add %s\n' "$target" >&2
    exit 1
  fi
  linker_var="CARGO_TARGET_$(printf '%s' "$target" | tr '[:lower:]-' '[:upper:]_')_LINKER"
  env "$linker_var=/usr/bin/clang" SDKROOT="$(xcrun --sdk "$platform" --show-sdk-path)" \
    cargo build --locked --release -p ollaic-ffi --lib --target "$target"
  libraries+=("$project_root/target/$target/release/libollaic_ffi.a")
done
mkdir -p "$output/$platform"
xcrun lipo -create "${libraries[@]}" -output "$output/$platform/libollaic_ffi.a"
