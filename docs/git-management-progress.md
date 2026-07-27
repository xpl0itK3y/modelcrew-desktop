# Git Management Implementation Progress

This document is the authoritative backlog for the staged Git management
implementation. A stage is complete only after its typecheck, unit and
integration tests, review, progress update, and dedicated commit all succeed.
Scope may be removed or deferred only after an explicit user decision.

## Stage Status

| Stage | Status | Commit | Summary |
| --- | --- | --- | --- |
| 1. Baseline and progress infrastructure | complete | `chore: establish git management implementation baseline` | Progress tracking, one verification command, rustfmt baseline, and CI lint gate |
| 2. Local/provider state and commit identity | complete | `refactor: separate local git and provider state` | Separate snapshots and repository/global/manual identity precedence |
| 3. Operation coordinator | complete | `feat: coordinate repository operations` | Shared/exclusive repository locks, queue, stale-state checks, managed runner |
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

## Stage 2 Evidence

- Added generation-bearing `LocalGitSnapshot`, independent
  `ProviderRepositoryState`, and the composed `GitPanelViewModel`.
- Provider loading, ready, and error state no longer changes or replaces the
  last local Git snapshot. Account settings consume the provider store instead
  of issuing a second profile request.
- New commits resolve a complete repository identity first, then a complete
  global identity. A cached GitHub identity is available only as an explicit
  user selection and is revalidated by the backend; it is never selected
  automatically.
- Integration coverage verifies the serialized repository identity, generation
  increments, independent provider errors, IPC arguments, missing local
  identity behavior, and explicit provider selection.
- Validation after changes: `npm run verify:stage` passed the production
  typecheck/build, 320 frontend tests, 264 Rust tests, rustfmt, clippy with
  warnings denied, and `git diff --check`. The existing credentialed live
  remote test remains opt-in and ignored.
- Review after changes: CocoIndex found the GitHub avatar/account paths and a
  stale provider-profile error path outside the initial panel changes.
  CodeGraph confirmed the call path
  `GitChangesWorkspaceView -> commitAll -> git_commit -> commit_all` and showed
  that `githubCurrentUser` also had an Account settings caller. Review findings
  fixed before completion: provider failures are no longer collapsed into
  signed-out state, and an unavailable configured identity cannot visually
  fall through to a provider identity. The security-focused diff review also
  removed a direct Git subprocess path from identity resolution so config reads
  use the shared non-shell Git runner and remain inside the Stage 3 coordinator
  blast radius.

## Stage 2 Known Limitations

- Provider state represents account authorization only. Repository
  installation, organization approval, capabilities, protected branches, and
  GitLab state remain required in Stages 11 and 12.
- The current changes view still commits all worktree changes. A staged-only
  commit workflow remains required in Stage 7.
- Identity configuration and signing management remain required in Stage 5;
  this stage only reads complete repository or global `user.name`/`user.email`
  pairs and exposes a manual authenticated-provider override.

## Stage 3 Evidence

- Added one process-wide `GitOperationCoordinator` with fair shared/exclusive
  queues keyed by canonical worktree and common Git directory. Linked
  worktrees therefore serialize shared-ref mutations while unrelated
  repositories remain independent.
- All current Git-panel mutations and network operations run inside one
  exclusive operation closure. Panel reads, watcher summaries, and GitHub
  repository metadata reads use shared operations. Git subprocesses are
  constructed by the central shell-less argv runner.
- Commit, branch switch/create, and history actions carry the branch/HEAD
  snapshot shown by the UI. The backend validates it after acquiring the
  exclusive lock and immediately before the first mutation; attached,
  detached, and unborn HEAD states are covered.
- Stage integration coverage verifies FIFO exclusive execution, concurrent
  readers with writer fairness, independent unrelated repositories,
  common-directory locking across linked worktrees, all snapshot shapes, stale
  HEAD rejection, and a queued operation rejecting an external HEAD change
  after it finally acquires the lock.
- Validation after changes: `npm run verify:stage` passed the production
  typecheck/build, 320 frontend tests, 271 Rust tests, rustfmt, clippy with
  warnings denied, and `git diff --check`. The existing credentialed live
  remote test remains opt-in and ignored.
- Review after changes: CocoIndex found two alternate read paths outside the
  initial Tauri wrappers: GitHub remote/email lookup and the notify watcher.
  Both now use shared coordination. CodeGraph confirmed the frontend-to-IPC
  precondition flow, all current mutation wrappers entering the exclusive
  coordinator, shared provider/watcher reads, and common-Git-dir impact across
  linked worktrees. Manual and security-focused diff review found no remaining
  shell interpolation or production `Command::new("git")` bypass.

## Stage 3 Known Limitations

- The coordinator is in-process. Git commands entered in a general terminal or
  run by an IDE/external client cannot be locked; Stage 4 must detect their
  locks and state changes, and Stage 14 must route the dedicated Git console
  through this coordinator.
- Operation IDs, progress events, cancellation/process-group termination, and
  watching the worktree Git dir plus common Git dir with polling fallback
  remain required in Stage 4.
- Repository-controlled hooks, filters, helpers, signing commands, merge
  drivers, aliases, and related inherited Git environment trust are not made
  safe by serialization. Restricted/trusted execution remains required in
  Stage 5.
- Branch/HEAD preconditions prevent ref-state drift, but the current commit
  still stages the entire worktree and file edit/discard actions do not have a
  content compare-and-swap or recovery snapshot. Full recovery and the staged
  changes workflow remain required in Stages 6 and 7.

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
