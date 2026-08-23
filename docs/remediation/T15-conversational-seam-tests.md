# T15 Conversational Orchestration and Persistence Seam Tests

- **Status:** Blocked
- **Severity:** Medium
- **Invariant:** INV-13 Seam Verification

## Evidence

`useAiAgent-preview.test.ts` proves Preview isolation and one mocked create rollback, while persistence commands are test doubles. `change-set-conflicts.test.ts` and `change-set-read-your-writes.test.ts` exercise pure staging Modules. There is no cross-Seam suite for stale Run ownership, backend CAS, autosave during Commit, accept draft preservation, rollback failure, or real Tauri command semantics.

## Dependencies

T02, T03, T16, T08, T09.

## Scope

Build a focused harness crossing conversational orchestration, Tauri command Adapter, and a real temporary Project. Consolidate regression scenarios that require more than one Module while preserving focused tests in each prerequisite task.

## Out of Scope

Full browser E2E, live Provider calls, Production Flow tests already covered in Rust, and exhaustive UI visual testing.

## Acceptance Criteria

- Tests prove no Project writes before confirmation.
- Accept covers stale baseline, atomic success, rollback, and rollback-failed outcomes.
- Stop/new Run proves old ownership cannot return.
- Autosave and cached drafts cannot overwrite or discard committed/user data.
- Create/edit same-run and staged read overlay cross the real command Seam.

## Test Plan

Use deterministic deferred Providers, controllable filesystem failure injection, fake timers for autosave, and temporary Projects. Avoid replacing the persistence Interface with no-op mocks.

## Verification Commands

```bash
pnpm --dir design test --run src/app/integration/ai-agent-persistence.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml change_set_commit -- --test-threads=1
pnpm --dir design test
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

## Remaining Risks

Tauri WebView event ordering and platform close behavior may still need a smaller Playwright desktop smoke suite later.
