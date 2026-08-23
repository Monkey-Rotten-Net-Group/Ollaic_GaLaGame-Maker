# T14 Project-Scoped File Interfaces

- **Status:** Ready
- **Severity:** High
- **Invariant:** INV-12 Project-Scoped Access

## Evidence

`src-tauri/src/webgal/commands.rs:21-115` accepts raw paths for Scene load/save/read/write/list/delete/rename with no Project containment check. These custom commands are registered in the desktop invoke handler. Asset commands already contain stronger filename and canonical containment checks, demonstrating a reusable policy shape.

## Dependencies

None.

## Scope

Introduce a ProjectPaths Module whose Interface accepts Project identity plus domain-relative identifiers, not arbitrary filesystem paths. Centralize canonical containment, symlink policy, extension rules, and existing/non-existing target validation. Migrate Agent-facing and editor Scene file commands first.

## Out of Scope

Scene-name create atomicity, export destination protection, attachment-turn authorization, OS file-picker imports, and asset multi-file transactions.

## Acceptance Criteria

- Scene commands cannot read, write, delete, rename, or list outside the selected Project domain directory.
- Traversal, absolute paths, symlink escapes, case variants, and non-existing parent escapes are rejected.
- Frontend callers pass Project identity and domain identifiers.
- Existing valid Project operations remain compatible.

## Test Plan

Use real temporary Projects with sibling files, nested traversal, absolute paths, symlinks, missing targets, valid Unicode names, and platform-specific separators.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml project_paths
cargo test --manifest-path src-tauri/Cargo.toml webgal::commands
pnpm --dir design test
```

## Remaining Risks

A compromised desktop process retains the user's OS privileges. This task constrains the application Interface, not the entire process sandbox.
