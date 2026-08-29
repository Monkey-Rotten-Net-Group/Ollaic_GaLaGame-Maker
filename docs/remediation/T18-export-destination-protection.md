# T18 Export Destination Protection

- **Status:** Blocked
- **Severity:** High
- **Invariant:** INV-12 Project-Scoped Access

## Evidence

`src-tauri/src/webgal/project.rs:512-576` accepts an arbitrary export destination. For directory export it removes `dest/game` before copying source `project/game`, but it does not reject a destination equal to, inside, or an ancestor of the source Project. Metadata can also be written to the source before destination validation completes.

## Dependencies

T14 Project-Scoped File Interfaces.

## Scope

Add an ExportDestination value that canonicalizes existing ancestors and rejects overlap with the source Project in either direction. Validate before any source mutation or destination deletion. Preserve valid sibling and external destinations.

## Out of Scope

Export format changes, archive content validation, Project metadata transaction design, and OS file-picker UX.

## Acceptance Criteria

- Destination equal to Project, inside Project, or an ancestor containing Project is rejected before deletion/write.
- Symlink and non-existing destination overlap is resolved safely.
- Valid sibling directory and zip export remain functional.
- Rejected export leaves source bytes unchanged.

## Test Plan

Use temporary Projects for equal, child, parent, sibling, symlink alias, non-existing nested target, zip, and directory exports. Snapshot source tree before and after every rejected case.

## Verification Commands

```bash
cargo test --manifest-path src-tauri/Cargo.toml export_destination
cargo test --manifest-path src-tauri/Cargo.toml webgal::project::tests
```

## Remaining Risks

Network filesystems and mount aliases can defeat simple canonicalization; document supported filesystem assumptions.
