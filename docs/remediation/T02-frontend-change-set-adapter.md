# T02 Frontend ChangeSet Adapter Migration

- **Status:** Complete
- **Severity:** High
- **Invariant:** INV-03 Atomic Commit; INV-04 Conflict Safety

## Evidence

`design/src/app/hooks/useAiAgent.ts:885-981` owns persistence ordering and compensation. `acceptChange` runs `detectConflicts` and then separately calls persistence, leaving a check-to-write race. `forceApplyChange` also mutates the live editor before persistence succeeds.

## Dependencies

T01 Backend ChangeSet Commit Interface.

## Scope

Replace frontend multi-IPC persistence with one typed Adapter for T01. Map backend conflict and rollback results to existing pending/conflict/error states. Keep Preview isolated and update live editor state only from a successful commit result.

## Out of Scope

Changing patch generation, staging algorithms, Preview layout, Reject behavior, or Provider orchestration.

## Acceptance Criteria

- `persistChangeSet` no longer performs resource writes or compensation.
- Accept and Force Apply cross the same backend commit Seam.
- Failed/conflicted commits leave the live buffer and PendingChangeSet reviewable.
- Success refreshes affected frontend stores exactly once.

## Test Plan

Hook tests mock the typed `applyAiChangeSet` Adapter for applied, conflict, recovery-failed, and transport-error outcomes. The IPC test verifies request serialization at the Tauri command boundary.

## Verification Commands

```bash
pnpm --dir design test --run src/app/hooks/useAiAgent-preview.test.ts
pnpm --dir design test --run src/app/lib/ai-change-set-ipc.test.ts
pnpm --dir design test
pnpm --dir design build
```

## Remaining Risks

Stale React state after a successful backend commit still requires explicit refresh behavior. Cross-window UI notifications remain separate from commit correctness.
