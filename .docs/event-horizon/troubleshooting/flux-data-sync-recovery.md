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
genuinely diverged.

**FLUX-1428: the periodic sync tick no longer auto-merges at all.** `runSync()` treats the push to
`origin/flux-data` as a compare-and-swap: push directly, and if it's rejected (the remote moved),
`reset --hard` onto the new remote head and replay this engine's own not-yet-pushed mutations
through the real ticket handlers (a durable local op journal — never a text-level merge of ticket
files), then push again. A journaled write (any human/agent-authored mutation — status changes,
comments, body edits) survives a lost race this way; nothing gets textually merged, so `<<<<<<<`
conflict markers can no longer be baked into ticket frontmatter by the periodic sync path. The
older per-ticket conflict-resolution machinery (`use-remote`/`use-local`/`rename-local`/`manual`,
plus the FLUX-1076 append-only history auto-merge) still exists and is still reachable through the
manual `resolveConflicts()`/`/api/storage/resolve-conflicts` endpoint for a worktree that's
genuinely mid-merge on disk (e.g. left over from an older engine version, or external git surgery)
— it is no longer something the periodic tick itself produces.

A *very large* startup divergence (hundreds of commits) is a different problem from a lost sync
race: replaying a long backlog of journaled ops through CAS's bounded retries isn't the right tool
either, which is what the escape hatch below is for.

## Detecting it

The engine surfaces a distinct `diverged` sync status (`{ state: 'diverged', ahead, behind }`,
FLUX-1232) as soon as the startup pull fails for a reason other than a network/auth problem — this
is a heads-up shown before the periodic sync tick even gets a chance to run its CAS+replay loop on
a large backlog. `isSyncUnhealthy()` treats `diverged` the same as `conflict`/`error`. The portal's
sync status indicator (top of the board) turns orange and shows "Diverged" for this case.

If sync has already moved past this into a real `conflict` state (a worktree that's genuinely
mid-merge on disk — see the FLUX-1428 note above), the same escape hatch below still applies — see
the "Discard all local & take remote" button in the conflict-resolution modal.

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
