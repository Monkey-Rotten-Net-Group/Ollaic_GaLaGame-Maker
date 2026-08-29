# T13 Batch TTS Transaction and Project Lock

- **Status:** Blocked
- **Severity:** Medium
- **Invariant:** INV-09 Recoverable Flow Output

## Evidence

`src-tauri/src/ai/commands.rs:2403-2560` generates each voice asset and then performs repeated Asset Metadata read-modify-write operations. `save_generated_asset` writes the target path directly, so a same-name generation can replace prior content. This command does not share the Flow `asset_binding_gate`.

## Dependencies

T05 AssetQueue Output Transaction.

## Scope

Reuse the asset output transaction and Project-scoped write guard established by T05. Stage generated files under unique temporary names, atomically publish the batch plus one merged metadata update, preserve prior same-name files, and expose a structured partial-generation error before publish.

## Out of Scope

Whether direct user-triggered TTS requires Agent Preview; voice Provider schemas; AssetQueue scheduling; asset rename/delete.

## Acceptance Criteria

- Failed batches leave prior assets and metadata unchanged.
- Concurrent batch TTS and AssetQueue binding cannot lose metadata updates.
- Same target name never silently destroys an existing asset.
- Successful batches publish all files and metadata once.

## Test Plan

Inject failure at generation N, temporary write, metadata merge, and publish. Run two concurrent batches and one batch against AssetQueue binding using a temporary Project.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml batch_tts_transaction -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml asset_queue_rollback -- --test-threads=1
```

## Remaining Risks

Remote generation costs cannot be rolled back. Generated but unpublished temporary files require bounded cleanup.
