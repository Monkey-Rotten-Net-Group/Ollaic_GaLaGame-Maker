# T01 Backend ChangeSet Commit Interface

- **Status:** Ready
- **Severity:** High
- **Invariant:** INV-03 Atomic Commit; INV-04 Conflict Safety

## Evidence

`design/src/app/hooks/useAiAgent.ts:885-981` sequences independent Scene, Character, Memory, Asset Metadata, and Scene creation IPC calls. Its compensation loop catches and discards rollback failures, yet reports complete rollback. `design/src/app/lib/change-set.ts:857-899` performs conflict checks before those writes and omits Asset Metadata/create baselines. `src-tauri/src/pipeline/scheduler.rs:1546-1634` demonstrates an existing backend transaction pattern, but conversational ChangeSets do not cross that Seam.

## Dependencies

None.

## Scope

Define one backend `apply_change_set` Interface. The request carries Project identity, all resource operations, and exact baseline preconditions. Validate paths and every precondition immediately before writing. Apply crash-safe writes under one Project-scoped write guard. Return a structured committed/conflict/rollback-failed result with per-resource evidence.

## Out of Scope

Frontend migration; Preview UI; Force Apply policy; AssetQueue outputs; batch TTS; OS-level crash recovery beyond the existing crash-safe writer.

## Acceptance Criteria

- No write occurs when any baseline precondition is stale.
- Scene, Character, Memory, Asset Metadata, and created Scene operations commit through one Interface.
- A mid-commit failure restores every prior resource or returns an explicit rollback-failed result naming residual resources.
- Create operations use atomic non-overwrite semantics.
- The Interface does not accept arbitrary output paths.

## Test Plan

Use real temporary Projects and injected failure points after each resource class. Cover stale current/non-current Scene, Character, Memory, Asset Metadata, create collisions, multiple created Scenes, successful commit, full rollback, and rollback failure reporting.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml change_set_commit -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml
```

## Remaining Risks

A process crash between filesystem operations still depends on crash-safe writer recovery. Project-wide locking policy must remain compatible with running Flow Steps and manual editor saves.
