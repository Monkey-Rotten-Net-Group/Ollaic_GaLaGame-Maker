# T09 Staged Output Read Overlay

- **Status:** Ready
- **Severity:** Medium
- **Invariant:** INV-07 Read Your Writes

## Evidence

Staging helpers use `StagingDraft.sceneFiles` and `StagingDraft.characters` in `change-set.ts`, allowing some create-then-write compositions. In contrast, `design/src/app/lib/ai-tools.ts:201-305` implements `list_scenes`, `read_scene`, `list_characters`, and `get_character` through disk IPC only. New staged entities are therefore invisible to ordinary read tools.

## Dependencies

None.

## Scope

Place a StagingProjectView Interface between tools and storage. Merge staged creates/edits over disk-backed Scene and Character reads, with deterministic identity and list ordering. Route all relevant read and write staging helpers through it.

## Out of Scope

Commit persistence, Project Memory context injection, asset generation, and cross-Run draft persistence.

## Acceptance Criteria

- `create_scene -> list_scenes/read_scene/edit_scene` observes one coherent Scene.
- `create_character -> list_characters/get_character/edit_character/plan_character_sprites` observes one coherent Character.
- Repeated creates and conflicting identities return deterministic errors.
- Disk remains unchanged before confirmation.

## Test Plan

Extend read-your-writes tests through actual tool `run` Interfaces, not only staging helpers. Cover create/edit/read sequences, aliases, duplicate names, and cancellation disposal.

## Verification Commands

```bash
pnpm --dir design test --run src/app/lib/change-set-read-your-writes.test.ts src/app/lib/ai-tools.test.ts
pnpm --dir design test
```

## Remaining Risks

Asset Metadata and Project Memory may later need the same view. Do not widen this task until a second concrete Adapter is required.
