# T11 Recoverable Provider Configuration

- **Status:** Ready
- **Severity:** Medium
- **Invariant:** INV-11 Secret and Trace Safety

## Evidence

`src-tauri/src/ai/config.rs:117-135` loads parse failures as defaults and writes Chat config with direct `fs::write`. Lines 162-183 do the same for media Provider configs. API keys are serialized into these plaintext JSON files, and restrictive file permissions are not explicitly set.

## Dependencies

None.

## Scope

Use crash-safe atomic replacement for every Provider config, report corrupt configuration explicitly, preserve recoverable backups, and enforce owner-only permissions where supported. Decide and document whether first-wave secret storage is protected file storage or OS keychain.

## Out of Scope

Provider capability routing; credential rotation; cloud secret management; mandatory keychain migration unless separately approved.

## Acceptance Criteria

- Interrupted writes recover the previous valid config.
- Invalid JSON produces a visible recovery error and never silently becomes defaults.
- Config files containing credentials are owner-readable only on supported platforms.
- Logs and errors never include key values.

## Test Plan

Test truncated current file with valid backup, invalid current and backup, permission creation, migration from existing plaintext files, and write failure before rename.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml ai::config
cargo test --manifest-path src-tauri/Cargo.toml config_recovery
```

## Remaining Risks

Owner-only files do not protect against malware running as the same user. OS keychain adoption remains a product/platform decision.
