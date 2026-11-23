# Cascade Tooling

Automates downstream branch propagation, verification, and boundary auditing based on [`topology.json`](topology.json). Requires Node.js 24+ (native TypeScript execution) and pnpm.

## Commands

Run from the repository root (on the `main` branch):

```bash
node tools/cascade/cascade.ts                 # Cascade and verify all enabled branches
node tools/cascade/cascade.ts --force-checks  # Ignore verified commit cache and recheck all branches
node tools/cascade/cascade.ts --dry-run       # Merge and verify without updating any branch refs
node tools/cascade/cascade.ts --skip-checks   # Merge only (for conflict triage, not for release)
node tools/cascade/cascade.ts --repo <path> --topology <file> --keep-worktree

node tools/cascade/audit.ts                   # Read-only ancestry, ownership, and protocol-leak audit
node --test tools/cascade/*.test.ts           # Run tooling unit and integration tests
```

## Cascade Behavior

1. **Topology validation**: Rejects duplicate branches, missing upstreams, enabled branches depending on disabled ones, and cycles; sorts enabled branches topologically.
2. **Snapshot**: Records the starting tip of every enabled branch and fails early if any enabled branch is checked out with uncommitted changes (except under `--dry-run`).
3. **Isolated merges**: Processes branches in a temporary detached worktree. For each upstream not yet an ancestor of the branch, creates one `--no-ff` merge commit (`--no-verify` skips staged-file hooks because full checks run on the whole tree afterward). Already-merged upstreams are skipped.
4. **Conflict handling**:
   - `git rerere` replays prior resolutions (shared via `.git/rr-cache`).
   - `package.json` conflicts use three-way semantic key merging across all merge bases; same-key divergence or delete-modify conflicts are reported as real conflicts.
   - `pnpm-lock.yaml` conflicts always halt the branch and block its descendants for manual resolution.
   - Unresolved conflicts abort the merge, mark the branch `conflict`, and block all descendants.
5. **Verification**: Runs `pnpm install --frozen-lockfile`, `lint`, `fmt:check`, `typecheck`, `vitest run`, and `build` with `CI=1` (preventing Lefthook from rewriting shared Git hooks). Logs are written to `.git/cascade/<timestamp>/<branch>.log`, and passing commits are recorded in `.git/cascade/verified.json`. Unverified tips (manual merges or direct source commits) are checked even when no upstream merge is pending.
6. **Atomic publication**: Moves each verified branch ref via `git update-ref --stdin` compare-and-swap against its starting tip and parent tips. Refuses to move a branch currently checked out in a worktree (detach that worktree HEAD first, or run from the `main` branch). Never pushes to remotes.

Run reports are written to `.git/cascade/<timestamp>/report.json`. Exit code is `1` if any branch failed, conflicted, or was blocked.

## Conflict Recovery

Resolve the reported conflict directly on the target branch (with `rerere` enabled so future runs reuse the resolution), then rerun cascade:

```bash
git -c rerere.enabled=true switch <branch>
git -c rerere.enabled=true merge <upstream>
# resolve conflicts, git add, git commit
git switch main
node tools/cascade/cascade.ts
```

## Boundary Audit

`node tools/cascade/audit.ts` performs read-only checks against all enabled branches without changing working trees:

- Upstream ancestry (`merge-base --is-ancestor`).
- Layer file ownership (`ownership.ts`) and forbidden retired web paths.
- Absence of Electron host protocol symbols in non-Electron Core branches.
- Optional `--reference <path>` inventory diff against an external reference checkout.
