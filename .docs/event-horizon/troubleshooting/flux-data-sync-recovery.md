---
order: 110
title: Recovering a Wedged flux-data Sync (Dev-Machine Swap)
---

# Recovering a Wedged flux-data Sync (Dev-Machine Swap)

## Problem

`.flux-store` is a git worktree on the orphan `flux-data` branch. On startup the engine runs
`git pull --ff-only origin flux-data`. If you switch dev machines (or come back to one after a
long time away), your local board branch can fall far behind the shared remote while also
carrying local sync commits of its own. The fast-forward pull then fails — the branches have
genuinely diverged — and a later periodic sync tries to auto-merge instead. On a small
divergence the engine's existing conflict machinery (per-ticket `use-remote`/`use-local`/
`rename-local`/`manual`, plus the FLUX-1076 append-only history auto-merge) handles this fine.
On a *large* divergence (hundreds of commits, many conflicted ticket files), attempting to
resolve every ticket one at a time is the wrong tool — and forcing a resolution across that many
files is exactly how the conflict-resolution path can end up baking `<<<<<<<` markers into ticket
frontmatter, which the board then can't parse ("N board errors").

## Detecting it

The engine surfaces a distinct `diverged` sync status (`{ state: 'diverged', ahead, behind }`,
FLUX-1232) as soon as the startup pull fails for a reason other than a network/auth problem — this
happens *before* any auto-merge is attempted, so you get the choice before the periodic sync risks
a many-file conflict. `isSyncUnhealthy()` treats `diverged` the same as `conflict`/`error`. The
portal's sync status indicator (top of the board) turns orange and shows "Diverged" for this case.

If sync has already moved past this into a real `conflict` state (the periodic auto-merge already
ran), the same escape hatch below still applies — see the "Discard all local & take remote" button
in the conflict-resolution modal.

## The escape hatch: force-reset-to-remote

The deliberate "my local board state is disposable — just match remote" action. It:

1. Tags the current local HEAD as `flux-data-backup-<utc-timestamp>` (a local git tag) — nothing
   is lost, it's just no longer on the branch tip.
2. Fetches `origin/flux-data`, aborts any in-progress merge, and hard-resets `.flux-store` to
   match it.
3. Cleans up stray untracked leftovers from the aborted merge (gitignored local-only files like
   `config.json`/`read-state.json` are never touched — `git clean -fd` respects `.gitignore`).
4. Re-runs the same idempotent post-attach steps every other attach path runs, so the tree is
   left consistent.

Recovering the discarded local state, if you need it: `git -C .flux-store checkout
flux-data-backup-<ts>` (or cherry-pick specific commits off that tag).

### Option A — one-click, from the portal

Click the sync status indicator while it shows **Diverged** (or open the conflict modal and use
**Discard all local & take remote…**). Both require an explicit second confirmation naming the
consequence (how many local commits are discarded) before anything happens — never a one-click
accident.

### Option B — CLI

```sh
npm run flux:reset-remote -w engine -- [--workspace <path>]
```

If a live engine is already running and bound to that workspace, the CLI routes the reset through
it (`POST /api/storage/reset-remote`) instead of touching the worktree directly, since the engine
already holds it (chokidar watcher, in-flight sync) and a second process doing raw git surgery
underneath it could race. It falls back to a standalone reset only when no engine is reachable for
that workspace. Prints the backup ref name and the old→new HEAD.

## What this does NOT do

- It never runs automatically. A `diverged` status is only ever *offered* as a fix, never applied
  on its own — auto-discarding local state on boot would be a silent data-loss footgun.
- It doesn't replace the existing conflict-resolution flow for small, reviewable divergences —
  reach for it when the divergence is too large to resolve ticket-by-ticket, not as the default.

See [`storage-sync.ts`](../../../engine/src/storage-sync.ts)'s `forceResetToRemote()` and the REST
endpoint reference in [reference/rest-api.md](../reference/rest-api.md).
