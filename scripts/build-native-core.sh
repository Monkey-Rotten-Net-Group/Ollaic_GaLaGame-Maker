#!/usr/bin/env bash
set -euo pipefail
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:?Expected generated output directory}"
abis="${2:-arm64-v8a}"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [[ -z "$ndk" ]]; then
  for candidate in "$sdk"/ndk/*; do
    if [[ -d "$candidate/toolchains/llvm/prebuilt" ]]; then ndk="$candidate"; fi
  done
fi
llvm=""
for candidate in "$ndk"/toolchains/llvm/prebuilt/*; do
  if [[ -x "$candidate/bin/clang" ]]; then llvm="$candidate"; fi
done
if [[ -z "$llvm" ]]; then
  printf 'Install an Android NDK in Android Studio, or set ANDROID_NDK_HOME.\n' >&2
  exit 1
fi

cd "$project_root"
cargo build --locked -p ollaic-ffi --lib
case "$(uname -s)" in
  Darwin) library="$project_root/target/debug/libollaic_ffi.dylib" ;;
  Linux) library="$project_root/target/debug/libollaic_ffi.so" ;;
  *) printf 'Unsupported native build host\n' >&2; exit 1 ;;
esac
cargo run --locked -p ollaic-ffi --features bindgen --bin ollaic-bindgen -- generate \
  --library "$library" --language kotlin --out-dir "$output/kotlin" --no-format

IFS=',' read -r -a requested_abis <<< "$abis"
for abi in "${requested_abis[@]}"; do
  case "$abi" in
    arm64-v8a) target="aarch64-linux-android"; clang_target="aarch64-linux-android" ;;
    x86_64) target="x86_64-linux-android"; clang_target="x86_64-linux-android" ;;
    *) printf 'Unsupported Android ABI: %s\n' "$abi" >&2; exit 1 ;;
  esac
  if ! rustup target list --installed | grep -qx "$target"; then
    printf 'Install the Rust target first: rustup target add %s\n' "$target" >&2
    exit 1
  fi
  linker_var="CARGO_TARGET_$(printf '%s' "$target" | tr '[:lower:]-' '[:upper:]_')_LINKER"
  env "$linker_var=$llvm/bin/${clang_target}24-clang" \
    cargo build --locked --release -p ollaic-ffi --lib --target "$target"
  mkdir -p "$output/jniLibs/$abi"
  cp "$project_root/target/$target/release/libollaic_ffi.so" "$output/jniLibs/$abi/"
done
