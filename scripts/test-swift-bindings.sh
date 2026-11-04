#!/usr/bin/env bash
set -euo pipefail
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
output="$project_root/target/bindings/swift"
cargo build --locked -p ollaic-ffi --lib
cargo run --locked -p ollaic-ffi --features bindgen --bin ollaic-bindgen -- generate \
  --library "$project_root/target/debug/libollaic_ffi.dylib" --language swift --out-dir "$output" --no-format
xcrun swiftc "$output/OllaicCore.swift" "$project_root/bindings/swift/main.swift" \
  -I "$output" -Xcc "-fmodule-map-file=$output/OllaicCoreFFI.modulemap" \
  -L "$project_root/target/debug" -lollaic_ffi \
  -Xlinker -rpath -Xlinker "$project_root/target/debug" -o "$output/smoke"
"$output/smoke"
