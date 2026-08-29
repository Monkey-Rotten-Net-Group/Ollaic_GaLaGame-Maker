# T10 Provider Capability Model

- **Status:** Ready
- **Severity:** Medium
- **Invariant:** INV-10 Bounded External I/O

## Evidence

`design/src/app/hooks/useAiAgent.ts:88` selects function calling from a static provider-name set. Backend Adapter selection and defaults are separately matched in `src-tauri/src/ai/commands.rs:942-968` and `1015-1025`. Custom OpenAI-compatible endpoints are forced to legacy mode even when tools work, while capability is not checked per model.

## Dependencies

None.

## Scope

Define one ProviderCapability description consumed by settings, conversational routing, Flow Agents, deadlines, and media-fetch policy. It reports supported chat tools, JSON mode, streaming cancellation, media URL output, and recommended deadlines. Keep concrete Provider Adapters behind this small Interface.

## Out of Scope

Implementing cancellation, deadlines, or safe fetch themselves; adding new Providers; automatic live capability probing unless required by an existing Provider.

## Acceptance Criteria

- No frontend provider-name allowlist decides function calling.
- Custom endpoints can explicitly declare supported capabilities.
- Unsupported capability combinations fail before a generation request.
- UI and backend routing consume the same capability source.

## Test Plan

Table-test every configured provider/model class and custom declarations. Cover tools supported/unsupported, JSON mode, local Provider, unknown Provider, and persisted legacy config migration.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml provider_capability
pnpm --dir design test --run src/app/components/AiSettingsDialog.test.tsx src/app/hooks/useAiAgent-provider.test.ts
```

## Remaining Risks

Provider capabilities can change remotely. Explicit custom declarations may be wrong and should yield actionable runtime errors.
