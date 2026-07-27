# Git Management Implementation Progress

This document is the authoritative backlog for the staged Git management
implementation. A stage is complete only after its typecheck, unit and
integration tests, review, progress update, and dedicated commit all succeed.
Scope may be removed or deferred only after an explicit user decision.

## Stage Status

| Stage | Status | Commit | Summary |
| --- | --- | --- | --- |
| 1. Baseline and progress infrastructure | complete | `chore: establish git management implementation baseline` | Progress tracking, one verification command, rustfmt baseline, and CI lint gate |
| 2. Local/provider state and commit identity | pending | `refactor: separate local git and provider state` | Separate snapshots and repository/global/manual identity precedence |
| 3. Operation coordinator | pending | `feat: coordinate repository operations` | Shared/exclusive repository locks, queue, stale-state checks, managed runner |
| 4. Progress, cancellation, and watcher | pending | `feat: track and cancel git operations` | Operation events, process cancellation, external changes, hybrid watcher |
| 5. Repository trust, config, and signing | pending | `feat: add repository trust and git configuration` | Trust policy, executable integration audit, config scopes, signing |
| 6. Full recovery | pending | `feat: protect destructive git operations` | Backup refs, stash/patch state, conflict index, untracked archive |
| 7. Index, changes, conflicts, and stash | pending | `feat: complete git changes workflow` | Staged model, hunks, conflict lifecycle, stash lifecycle |
| 8. History and standard workflows | pending | `feat: expand git history workflows` | Streaming history, reflog, rebase, blame, bisect, patches |
| 9. Branches, remotes, tags, and worktrees | pending | `feat: complete repository reference management` | Complete reference and linked-worktree management |
| 10. Submodules and Git LFS | pending | `feat: support git submodules and lfs` | Submodule lifecycle and LFS object/lock workflows |
| 11. GitHub App installation flow | pending | `feat: integrate github app installations` | Device auth, keychain, refresh, installations and organization approval |
| 12. GitLab and provider permissions | pending | `feat: integrate gitlab repository access` | OAuth PKCE, roles, protection, capabilities and transport |
| 13. PR/MR lifecycle | pending | `feat: manage pull and merge requests` | Create, review metadata, checks, merge, close/reopen and forks |
| 14. Coordinated Git console | pending | `feat: add coordinated git console` | Shell-less command runner, catalog, risk checks, streaming and cancellation |
| 15. Scaling and final acceptance | pending | `test: complete git management acceptance coverage` | Virtualization, bounded queries and cross-platform acceptance matrix |

## Stage 1 Evidence

- Baseline before changes: `npm test` passed 314 tests.
- Baseline before changes: `npm run build` passed typecheck and production build.
- Baseline before changes: Rust passed 261 tests with one opt-in network test ignored.
- Baseline before changes: `cargo fmt --check` failed on existing formatting drift.
- Baseline before changes: Clippy was not installed in the local stable toolchain.
- Validation after changes: `npm run verify:stage` passed frontend build,
  314 frontend tests, 261 Rust tests, rustfmt, clippy, and `git diff --check`.
- Stage integration validation: actionlint 1.7.7 accepted the updated CI workflow.
- Review after changes: CocoIndex found no alternate baseline command path that
  bypasses the new gate; CodeGraph confirmed that runtime changes are limited
  to behavior-equivalent clippy fixes. Manual whitespace-insensitive diff review
  found no unresolved findings.

## Known Baseline Limitations

- Vite reports a large main bundle and a mixed static/dynamic import warning.
- jsdom reports that `HTMLMediaElement.play()` is not implemented during tests.
- The live remote Rust test requires explicit network credentials and is ignored
  by the default test run.

## Remaining Scope

Every stage marked `pending` in the table remains required. In particular,
provider authorization is not equivalent to repository installation/access,
backup refs do not replace uncommitted-file recovery, and external terminals
cannot be locked by the in-app coordinator; they must be detected and reconciled.
