# T04 Reject Draft Preservation

- **Status:** Cancelled
- **Severity:** None (Rejected Finding)
- **Invariant:** INV-05 User Edit Preservation

## Evidence

`useAiAgent.revertChange` only changes PendingChangeSet status, and `design/src/app/components/StoryEditor.tsx:2419-2422` deletes the current cache entry after Reject. A second path analysis found that restoring a cached Scene does not delete its cache entry, while switching away from a dirty Scene re-stashes the live buffer. The reported Reject-specific data-loss path was not established.

## Dependencies

None.

## Scope

No implementation. Retain this file as an auditable record of the rejected Finding and the reproduction sequence that must be supplied before reopening it.

## Out of Scope

Accept-time draft loss and autosave/Commit races, which are handled by T16; general draft persistence across app restarts.

## Acceptance Criteria

- No code change is made for this Finding without a failing reproduction test.
- Any reopening identifies the exact state transition that makes a user buffer unreachable.

## Test Plan

None while Cancelled. A reopening must begin with the originally proposed A dirty -> B -> Preview touches A -> A -> Reject -> B -> A reproduction test.

## Verification Commands

```bash
pnpm --dir design test
```

## Remaining Risks

Reject behavior still lacks dedicated integration coverage, but absence of coverage is not evidence of the rejected loss mechanism.
