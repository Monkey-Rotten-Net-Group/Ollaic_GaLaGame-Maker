# T19 Asset Rename and Delete Transaction

- **Status:** Blocked
- **Severity:** High
- **Invariant:** INV-03 Atomic Commit; INV-09 Recoverable Flow Output

## Evidence

`src-tauri/src/assets/commands.rs:541-574` deletes the asset, then reference directory, then metadata without compensation. `rename_asset` at lines 579-641 renames the file, reference directory, every Scene reference, and Asset Metadata sequentially. A failure after an early operation leaves cross-resource state partially updated.

## Dependencies

T05 AssetQueue Output Transaction; T14 Project-Scoped File Interfaces.

## Scope

Reuse the asset transaction and Project write guard for rename/delete. Snapshot asset file, reference directory, affected Scene files, and metadata before mutation. Apply atomically from the caller's perspective and report rollback residuals.

## Out of Scope

Batch TTS generation, AssetQueue generation scheduling, bulk asset migration, and UI confirmation wording.

## Acceptance Criteria

- Failure at any rename/delete stage restores all earlier resources.
- Scene references and metadata always agree with the published asset name/existence.
- Concurrent asset mutation is serialized by Project/resource identity.
- Rollback failure returns residual paths and never claims success.

## Test Plan

Inject failures after file mutation, reference-directory mutation, each Scene update, and metadata update. Cover multiple referencing Scenes, missing reference directory, rollback failure, and concurrent rename/delete.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml asset_mutation_transaction -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml assets::commands::tests -- --test-threads=1
```

## Remaining Risks

External tools editing files outside Ollaic can still race unless revision checks are applied to affected Scene files.
