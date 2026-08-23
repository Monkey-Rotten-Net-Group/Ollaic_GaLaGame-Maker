# T05 AssetQueue Output Transaction

- **Status:** Ready
- **Severity:** High
- **Invariant:** INV-09 Recoverable Flow Output

## Evidence

`src-tauri/src/pipeline/scheduler.rs:858-921` runs AssetQueue as a special branch. Its `AgentOutput` contains `asset_queue`, while `OutputTransaction::apply` at lines 1551-1569 covers only Character and Scene files. `create_rollback_snapshot` at line 1648 does not select AssetQueue-only output. The exact residual artifact set on injected failure remains an evidence gate.

## Dependencies

None.

## Scope

Inventory AssetQueue writes and bindings, then include every playable side effect in a rollback record before execution. On failure, cancellation, or interrupted-run recovery, restore or explicitly retain outputs according to one documented policy. Include StoryPlan consistency in the recovery record.

## Out of Scope

Conversational ChangeSets; batch TTS; asset rename/delete; Provider media URL safety.

## Acceptance Criteria

- A fault after each AssetQueue write cannot leave an untracked playable artifact or binding.
- Cancellation and crash recovery converge to a documented state.
- StoryPlan, queue state, metadata, and playable files agree after restore.
- Rollback errors are surfaced with residual paths.

## Test Plan

Add failure injection to generator, artifact write, binding, queue save, StoryPlan save, and run-state save. Use real temporary Projects and restart/attach recovery tests.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml asset_queue_rollback -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml pipeline::tests -- --test-threads=1
```

## Remaining Risks

Generated media may be expensive to recreate; policy may intentionally retain content-addressed unbound artifacts, but such retention must be tracked and non-playable.
