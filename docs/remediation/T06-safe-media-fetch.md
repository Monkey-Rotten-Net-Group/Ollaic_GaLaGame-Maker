# T06 Safe Bounded Media Fetch

- **Status:** Blocked
- **Severity:** High
- **Invariant:** INV-10 Bounded External I/O

## Evidence

`src-tauri/src/ai/commands.rs:2019-2048` validates only the supplied URL before a reqwest GET and reads the complete body with `bytes()`. `validate_media_download_url` at lines 2050-2063 checks scheme and literal host but does not validate redirect targets or resolved addresses.

## Dependencies

T10 Provider Capability Model.

## Scope

Create one media-fetch Module used by every Provider Adapter. Disable automatic redirects or validate every hop, resolve and reject non-public addresses immediately before connection, prevent DNS rebinding, enforce content type and byte limits while streaming, and apply a deadline.

## Out of Scope

Provider generation request schemas, local file imports, image decoding limits after download, and UI upload limits.

## Acceptance Criteria

- Redirects to loopback, private, link-local, multicast, and `.local` targets are rejected.
- Hostnames resolving to forbidden addresses are rejected.
- Oversized, unknown-length, and slow bodies stop at configured limits.
- All current generated-media URL call sites use the Module.

## Test Plan

Use local HTTP fixtures for public-like initial URL, redirect chains, redirect loops, chunked oversized bodies, slow responses, content-type mismatch, and permitted bounded content. Inject DNS resolution for deterministic private/public cases.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml media_fetch
cargo test --manifest-path src-tauri/Cargo.toml ai::commands_tests
```

## Remaining Risks

Proxy configuration can alter destination routing. The Module must document whether proxies are disabled or included in the trust model.
