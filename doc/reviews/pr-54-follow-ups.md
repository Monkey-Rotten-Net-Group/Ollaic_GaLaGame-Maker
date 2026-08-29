# PR #54 Review Follow-ups

This file records findings below the PR's P2 fix threshold. They are not merge blockers for PR #54.

## P3: Staged Output terminology

The remediation plan uses `StagingDraft` as a domain-facing term in `docs/remediation/README.md`, T08, and T09. `CONTEXT.md` defines generated work that has not been applied as **Staged Output** and asks documentation to avoid **Draft** for that concept.

Follow-up: distinguish the internal `StagingDraft` code type from the user-facing Staged Output concept, then update the remediation wording without renaming code blindly.

## P3: Agent Flow terminology

The remediation plan uses **Production Flow** in several T03, T07, and T15 passages. `CONTEXT.md` defines **Agent Flow** as the canonical product term.

Follow-up: replace Production Flow where it means Agent Flow, while preserving **Production Type** and **Production Brief** where those canonical terms are intended.
