# T16 Editor Commit Coordination

- **Status:** Blocked
- **Severity:** High
- **Invariant:** INV-03 Atomic Commit; INV-05 Reject Preservation

## Evidence

During the current frontend persistence implementation, `useAiAgent.ts:900-935` awaits multiple resource writes and clears dirty state only near the end. `StoryEditor.tsx:1995-1999` runs autosave every interval when `dirtyRef` is true, and `handleSave` writes `nodesRef` at lines 1815-1828. Accepted edits also delete Scene draft-cache entries at lines 2413-2417 without treating non-current cached drafts as conflict input.

## Dependencies

T02 Frontend ChangeSet Adapter Migration.

## Scope

Coordinate editor saves with the single commit Adapter. Freeze or version the affected editor resources while a commit is in flight, include non-current cached drafts in conflict inputs, and reconcile successful results without allowing autosave to overwrite committed content.

## Out of Scope

Backend transaction implementation; Reject cleanup; general multi-window synchronization; autosave interval redesign.

## Acceptance Criteria

- Autosave cannot write an older current Scene buffer during an accepted commit.
- A non-current cached user draft causes a conflict or remains reachable after Accept.
- Commit failure restores normal autosave without changing draft ownership.
- Unaffected Scenes continue to save normally.

## Test Plan

Use fake timers and a deferred commit Adapter. Cover autosave firing before/during/after commit, non-current dirty draft on Accept, successful reconciliation, conflict, and transport failure.

## Verification Commands

```bash
pnpm --dir design test --run src/app/components/StoryEditor-ai-commit.test.ts
pnpm --dir design test --run src/app/hooks/useAiAgent-preview.test.ts
pnpm --dir design test
```

## Remaining Risks

Cross-window editor state needs backend revisions or a Project event stream beyond this frontend coordination task.
