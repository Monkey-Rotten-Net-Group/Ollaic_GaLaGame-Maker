# Development Standards

The development rules are written in English and live beside the code they govern. Read the [root rules](AGENTS.md) and applicable directory rules before editing. Child rules add to the parent rules; cross-cutting work follows the conditional links in those files.

| Area | Rules |
| --- | --- |
| Shared architecture, formatting, tests, and review | [AGENTS.md](AGENTS.md) |
| Native iOS development and validation ownership | [apps/ios/AGENTS.md](apps/ios/AGENTS.md) |
| TypeScript, naming, and frontend checks | [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) |
| React components, UI behavior, and accessibility | [Component rules](apps/desktop/src/app/components/AGENTS.md) |
| Hooks, effects, and asynchronous cleanup | [Hook rules](apps/desktop/src/app/hooks/AGENTS.md) |
| Pure frontend logic and IPC contracts | [Library rules](apps/desktop/src/app/lib/AGENTS.md) |
| CSS and semantic tokens | [Style rules](apps/desktop/src/styles/AGENTS.md) |
| Browser journey tests | [E2E rules](apps/desktop/e2e/AGENTS.md) |
| Rust, Tauri security, and persistence | [apps/desktop/src-tauri/AGENTS.md](apps/desktop/src-tauri/AGENTS.md) |
| Engineering documentation | [docs/AGENTS.md](docs/AGENTS.md) |
| Development and release scripts | [scripts/AGENTS.md](scripts/AGENTS.md) |
| CI quality gates and releases | [.github/AGENTS.md](.github/AGENTS.md) |

## Adoption

These rules define the target baseline for maintaining a Tauri application, not the current business architecture or a claim that every gate is already configured. Existing violations are migration work, not precedent for new code.

Configure shared tools and canonical scripts, measure existing violations, and separate mechanical cleanup from behavior changes. Enable gates with tracked temporary baselines, then enforce them in CI and branch protection. Document exceptions with their reason, scope, and removal condition. Changing documentation alone does not change enforcement.

## Reference

The directory-based contribution structure is informed by [Jan's contributor guide](https://github.com/janhq/jan/blob/main/CONTRIBUTING.md). The exact conventions here are this project's choices; keep their authoritative text in the directory rules rather than duplicating it in this index.
