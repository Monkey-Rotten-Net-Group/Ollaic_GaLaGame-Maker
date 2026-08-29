# T07 Agent Flow Step Deadline

- **Status:** Blocked
- **Severity:** Medium
- **Invariant:** INV-10 Bounded External I/O

## Evidence

`src-tauri/src/pipeline/scheduler.rs:345-365` sets `step_timeout: None` in production constructors. The scheduler timeout branch exists at lines 925-939, so production currently selects an unbounded wait. Stop cancellation is separately implemented and tested.

## Dependencies

T10 Provider Capability Model.

## Scope

Define capability-aware default and configurable Flow Step deadlines. Inject them through production Orchestrator construction and preserve explicit timeout errors and retry behavior.

## Out of Scope

Conversational Stop; media body limits; frontend progress UX; changing retry counts.

## Acceptance Criteria

- Production constructors never leave Provider-backed Flow Steps unbounded.
- Local and long-running media capabilities can declare suitable deadlines.
- Timeout persists a deterministic failed state and permits retry.
- Stop remains distinguishable from timeout.

## Test Plan

Use controllable Agents with paused futures. Verify timeout, completion before deadline, stop before deadline, retry after timeout, and per-capability override.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml step_timeout -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml pipeline::tests -- --test-threads=1
```

## Remaining Risks

A local deadline cannot guarantee the remote Provider stopped billing unless its transport honors cancellation.
