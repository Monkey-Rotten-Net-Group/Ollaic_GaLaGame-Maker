# T12 Agent Trace Data Minimization

- **Status:** Ready
- **Severity:** Medium
- **Invariant:** INV-11 Secret and Trace Safety

## Evidence

`design/src/app/hooks/useAiAgent.ts:242-248` writes and logs Agent traces. Tool turns retain full arguments/results around lines 652-660. Backend `sanitize_trace_value` at `src-tauri/src/ai/commands.rs:2261-2289` redacts secret-shaped keys and strings, but project prose, uploaded references, tool content, and full prompts are not minimized.

## Dependencies

None.

## Scope

Define a versioned TraceRecord Interface with data classification. Persist operational metadata, hashes, sizes, timing, tool names, result status, and opt-in bounded excerpts. Remove full prompts/tool payloads from default traces and console output. Add retention and explicit diagnostic-export behavior.

## Out of Scope

Chat session history; Provider raw response capture internal to the genai library; telemetry upload; config credential storage.

## Acceptance Criteria

- Default traces contain no full Scene, Memory, upload, prompt, or tool payload.
- Known and nonstandard credential formats are covered by tests.
- Diagnostic content requires explicit opt-in and visible retention limits.
- Existing trace readers handle version migration or fail clearly.

## Test Plan

Golden-test traces containing API keys, bearer tokens, arbitrary prose, upload content, nested tool arguments, and large responses. Assert bounded size and absence of sentinel secrets/content.

## Verification Commands

```bash
pnpm --dir design test --run src/app/hooks/useAiAgent-trace.test.ts
cargo test --manifest-path src-tauri/Cargo.toml trace_redaction
```

## Remaining Risks

Hashes and metadata can still reveal usage patterns. Provider SDK debug logging needs separate verification.
