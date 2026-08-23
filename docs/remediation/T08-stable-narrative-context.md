# T08 Stable Narrative Context

- **Status:** Ready
- **Severity:** Medium
- **Invariant:** INV-08 Narrative Context

## Evidence

`design/src/app/hooks/useAiAgent.ts:356-402` builds the function-calling system context without `buildMemoryContext(memory)`, while legacy mode includes it at line 420. Accepted changes become a short assistant summary at lines 978-980. `truncateContextMessages` in `story-agent.ts:145-162` forwards only recent role/content and truncates assistant content, not accepted diffs or tool results. The current Scene context also requests up to 9999 lines at `useAiAgent.ts:398`.

## Dependencies

None.

## Scope

Define a bounded NarrativeContext Module containing Project Memory summary, accepted fact digest, current Scene head/tail summary, and stable identifiers. Use it in function-calling and legacy prompts. Update the digest only after successful Commit.

## Out of Scope

Embedding search, long-term vector memory, chat UI persistence, and StagingDraft read overlay.

## Acceptance Criteria

- FC and legacy modes receive equivalent mandatory Memory/fact context.
- Context has explicit character/token bounds and preserves head/tail cues.
- Rejected or failed changes never enter accepted facts.
- Accepted facts survive chat-message truncation and session reload as Project-owned context.

## Test Plan

Snapshot both prompt modes with large Scene and Memory inputs. Cover accepted, rejected, failed, and multiple-session changes; assert deterministic bounds and fact presence.

## Verification Commands

```bash
pnpm --dir design test --run src/app/lib/story-agent.test.ts src/app/hooks/useAiAgent-context.test.ts
pnpm --dir design test
```

## Remaining Risks

Summarization can omit nuance. The Interface must distinguish canonical Project Memory from derived summaries.
