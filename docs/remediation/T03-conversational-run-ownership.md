# T03 Conversational Run Ownership and Cancellation

- **Status:** Blocked
- **Severity:** High
- **Invariant:** INV-06 Run Ownership

## Evidence

`design/src/app/hooks/useAiAgent.ts:583-593` checks one shared `cancelledRef`; `sendPrompt` resets it at lines 797-800. `stop` clears `inFlightRef` at lines 1166-1177. Request tokens guard only final UI cleanup at lines 843-850, not tool execution or `finalizeChangeSet`. `src-tauri/src/ai/commands.rs:815-869` exposes `ai_chat_turn` without request identity or cancellation.

## Dependencies

T10 Provider Capability Model.

## Scope

Introduce a per-Run identity and cancellation handle shared by frontend orchestration and backend Provider execution. Every awaited continuation, tool call, message update, and Preview publication must prove current ownership. Stop revokes that identity and aborts or detaches Provider work safely.

## Out of Scope

Agent Flow cancellation; Provider deadline defaults; chat history retention; ChangeSet transaction behavior.

## Acceptance Criteria

- Starting Run B cannot reactivate Run A.
- A stopped Run cannot execute a tool, replace a message, or publish Preview after any awaited operation.
- Stop requests backend cancellation when supported and always enforces frontend ownership.
- Repeated Stop is idempotent.

## Test Plan

Use controllable deferred Provider turns. Cover stop-before-response, stop-during-multiple-tools, stop-then-new-run, late success, late error, and providers without transport cancellation.

## Verification Commands

```bash
pnpm --dir design test --run src/app/hooks/useAiAgent-run-ownership.test.ts
cargo test --manifest-path src-tauri/Cargo.toml ai_chat_cancel
pnpm --dir design test
```

## Remaining Risks

Some third-party transports may not stop remote billing after local abort. Ownership checks must still prevent all local side effects.
