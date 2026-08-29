# T17 Scene Name Validation and Atomic Create

- **Status:** Blocked
- **Severity:** High
- **Invariant:** INV-12 Project-Scoped Access; INV-04 Conflict Safety

## Evidence

`src-tauri/src/webgal/project.rs:223-251` joins unvalidated `scene_name` beneath `game/scene`. `create_scene` performs `exists()` then writes, creating a race and permitting traversal segments. The frontend can also stage `create_scene` plus an edit for the same file; the current persistence order may create content before calling `create_scene`, which then rejects the already-existing path.

## Dependencies

T14 Project-Scoped File Interfaces; T01 Backend ChangeSet Commit Interface.

## Scope

Define a canonical SceneName value at the ProjectPaths Seam. Reject separators, traversal, invalid extensions, reserved names, and case-insensitive collisions. Create with atomic non-overwrite semantics. Ensure a ChangeSet containing create plus content/header for one Scene publishes exactly one file operation.

## Out of Scope

Scene rename reference updates; general raw-path command migration; Scene parser validation.

## Acceptance Criteria

- Scene creation cannot escape `game/scene`.
- Concurrent same-name creates yield exactly one success without overwrite.
- `create_scene + edit/header` for one Scene commits successfully as one creation.
- Case and extension normalization is deterministic across supported platforms.

## Test Plan

Test traversal, absolute names, separators, case collisions, concurrent creates, pre-existing file, multiple creates, and create-plus-edit through T01.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml scene_name
cargo test --manifest-path src-tauri/Cargo.toml change_set_commit -- --test-threads=1
pnpm --dir design test --run src/app/lib/change-set-read-your-writes.test.ts
```

## Remaining Risks

Projects moved between case-sensitive and case-insensitive filesystems may already contain ambiguous names requiring migration diagnostics.
