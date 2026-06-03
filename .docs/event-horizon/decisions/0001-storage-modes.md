---
title: "ADR 0001 — Storage Modes"
order: 1
---
# ADR 0001 — Storage Modes

> **Historical reasoning — skip this for ticket work.**
> For current storage behavior see [[Architecture Overview]]. This page captures the decision spike that produced today's in-repo / orphan-branch options.

## Problem Statement

Event Horizon currently uses `.flux/` as its ticket store, with all markdown files committed directly to the application repository. This works well for an initial design, but creates friction as the repo matures:

- **Git log pollution**: every status change, comment, or board move produces a commit. In an active project, ticket churn can easily outnumber real code changes by 10:1, making `git log` and `git blame` unreliable for understanding what changed in the application.
- **Diff noise**: PRs accumulate unrelated `.flux/` hunks. Reviewers must mentally filter out project-management noise.
- **Agent confusion**: AI agents reading `git log` or generating commit context ingest ticket-state commits as if they were meaningful code events, producing inaccurate summaries and inflated change analysis.
- **History archaeology**: bisecting a regression or cherry-picking a fix requires hopping past dozens of ticket commits to find the one that actually changed source files.

The repository-as-datastore model is explicitly noted in the architecture overview as a deliberate choice. This document evaluates whether that tradeoff still makes sense and what alternatives exist.

---

## Option A: Global `~/.flux/` Directory

Move the ticket store out of the repo entirely into a per-user, per-workspace directory under the user's home folder. Each workspace would be identified by a slug or hashed path, e.g. `~/.flux/my-project/`.

**How it works**

- The engine resolves the workspace root at startup and maps it to a subdirectory under `~/.flux/`.
- Tickets are read and written there rather than in the repo.
- The `.flux/` path in the repo is removed or repurposed.

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | Low — engine change only, no new dependency |
| Git cleanliness | Excellent — no ticket files in the repo at all |
| Offline / local support | Full |
| Agent read/write compatibility | High — same file format, different path |
| Collaboration / multi-device | None — files live on one machine |
| Migration cost | Medium — requires migrating existing `.flux/` files on first run |

**Notes**: Very low friction for solo developers. The current markdown + YAML format is preserved entirely, so agent tooling works without modification. The main gap is multi-device use; tickets do not follow the user to another machine. No querying or indexing improvements.

---

## Option B: SQLite in `~/.event-horizon/`

Replace the per-ticket markdown files with a structured SQLite database stored alongside the existing `settings.json` at `~/.event-horizon/`. One database per workspace, or a single shared DB with a workspace column.

**How it works**

- The engine replaces filesystem reads/writes with SQLite queries via a driver such as `better-sqlite3`.
- Tickets are stored as rows; history as a related table or a serialised JSON column.
- The markdown + YAML format becomes an import/export concern rather than the canonical store.

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | Medium — new dependency, schema design, migration tooling needed |
| Git cleanliness | Excellent — nothing ticket-related in the repo |
| Offline / local support | Full |
| Agent read/write compatibility | Reduced — agents can no longer read ticket files directly; must go through the API |
| Collaboration / multi-device | None out of the box; DB file is not sync-friendly |
| Migration cost | High — all existing `.flux/` markdown must be parsed and ingested |

**Notes**: SQLite enables efficient querying (filtering by status, assignee, tag), faster indexing, and aggregate views. The main cost is breaking the agent's current ability to read `.flux/*.md` files directly. Agents would be fully API-dependent. This is a larger investment and makes sense if querying and performance become pain points, but it removes the "open any ticket in a text editor" simplicity that is valuable today.

---

## Option C: Centralized Server / Cloud Backend

Host tickets on a remote service with an HTTP API. The engine becomes a thin client that proxies reads and writes to the server.

**How it works**

- A hosted API (self-hosted or SaaS) stores all ticket state.
- The local engine authenticates and forwards all task CRUD operations to the remote.
- The markdown file format may be preserved as a serialization layer or abandoned entirely.

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | High — requires auth, network config, a hosted service |
| Git cleanliness | Excellent — nothing ticket-related in the repo |
| Offline / local support | Degraded or none — requires connectivity |
| Agent read/write compatibility | Reduced — no local files; fully API-dependent |
| Collaboration / multi-device | Full |
| Migration cost | High — data egress from local files, ongoing hosting dependency |

**Notes**: This is the right model for teams that need shared ticket state across contributors and devices. For a solo-developer or embedded-agent workflow, the setup cost and loss of offline guarantees make this the least attractive option today. It would make sense as a future paid tier rather than a baseline change.

---

## Option D: Hybrid — Keep `.flux/`, Add to `.gitignore`

The minimal-change option: leave the file format and engine code entirely as-is, and simply add `.flux/` to `.gitignore`.

**How it works**

- Add `.flux/` (or a subset like `.flux/*.md`) to the repo's `.gitignore`.
- The engine, portal, and agent tooling continue to work exactly as today.
- Ticket files accumulate locally but are never staged or committed.

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | Minimal — one line in `.gitignore` |
| Git cleanliness | Excellent — ticket files are invisible to git |
| Offline / local support | Full |
| Agent read/write compatibility | Full — no format change |
| Collaboration / multi-device | None — files stay local |
| Migration cost | Minimal — existing committed files need a one-time `git rm --cached .flux/*.md` |

**Notes**: This option preserves all current behaviour while immediately solving the git noise problem. The existing `.flux/config.json`, `.flux/skills/`, and workflow assets would need to remain tracked (they are application configuration, not ticket data), requiring a more targeted gitignore pattern such as ignoring only `.flux/FLUX-*.md` and `.flux/read-state.json`. This is highly compatible with the current agent workflow and has no new dependencies.

---

## Option E: Gitignore + External Sync Layer

A hybrid of Option D and online sync: keep `.flux/` gitignored so ticket files never appear in the code history, but layer an independent sync mechanism on top so tickets follow the user across machines or collaborators.

### E1 — Cloud folder sync (Google Drive, Dropbox, iCloud, OneDrive)

**How it works**

- Move `.flux/` into a cloud-synced folder (e.g. `~/Google Drive/My Drive/flux/my-project/`) and symlink it back to the repo root, or configure the engine to resolve the ticket store from a configurable path.
- The cloud client handles background sync transparently; no git involvement.

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | Low-Medium — requires cloud client and a path config or symlink |
| Git cleanliness | Excellent — no ticket files in the repo |
| Offline / local support | Full (cloud clients cache locally) |
| Agent read/write compatibility | Full — same file format |
| Collaboration / multi-device | Good for one user across machines; limited for teams (no conflict resolution) |
| Migration cost | Low — move files, update path |

**Notes**: This is the most accessible option for personal multi-device use. The main risks are cloud client conflicts when two machines edit the same ticket simultaneously (cloud sync tools handle this by creating duplicate "conflict copy" files) and the assumption that a cloud client is installed and running. Not suitable for team collaboration where multiple people push ticket edits concurrently.

---

### E2 — Git orphan branch

**How it works**

- Create a parallel `flux-data` branch in the same git repository that shares the remote (GitHub, GitLab, etc.) but has no commit ancestry with `main`.
- Ticket files are committed to this branch only, completely separate from the code history.
- A lightweight script or git hook pushes `flux-data` after each write and pulls before each read.

```bash
# Initial setup
git checkout --orphan flux-data
git rm -rf .
# copy .flux/ files here, commit, push
git push origin flux-data

# Engine reads from working tree when on flux-data; or store in a git worktree
git worktree add .flux-store flux-data
```

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | Medium — orphan branch setup, hook wiring, worktree or checkout logic |
| Git cleanliness | Excellent — zero ticket noise in `main` history |
| Offline / local support | Full (local branch always available) |
| Agent read/write compatibility | High — same file format; worktree keeps path stable |
| Collaboration / multi-device | Good — same remote handles both code and ticket sync |
| Migration cost | Medium — one-time branch creation and file migration |

**Notes**: This is the most git-native option for multi-device sync. It reuses the existing remote without any external dependency. The main operational cost is the push/pull round-trip on every ticket mutation — either automated via hooks or accepted as a manual `git push origin flux-data` step. Merge conflicts are possible if two machines edit the same ticket offline; standard git conflict resolution applies. For a single developer this is low-friction. For a small team it enables genuine collaboration using familiar git tooling.

---

### E3 — Syncthing (P2P, no cloud dependency)

**How it works**

- Syncthing continuously syncs `.flux/` between configured devices over the local network or internet without routing through a cloud provider.
- The engine and agent work against the local `.flux/` directory as normal.

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | Medium — Syncthing installed on each device, folder shared |
| Git cleanliness | Excellent |
| Offline / local support | Full |
| Agent read/write compatibility | Full |
| Collaboration / multi-device | Good for personal multi-device; limited for teams |
| Migration cost | Low |

**Notes**: Similar profile to E1 but without a cloud provider dependency. Good fit for privacy-conscious setups or air-gapped environments. Conflict handling is basic (last-write-wins or conflict copies, depending on config).

---

### E4 — rclone to object storage (S3, B2, GCS)

**How it works**

- `rclone sync .flux/ remote:bucket/project-slug/` is run via a git hook (`post-commit`) or a cron/watcher.
- Restore with `rclone sync remote:bucket/project-slug/ .flux/` on a fresh clone.

**Tradeoffs**

| Dimension | Assessment |
|-----------|-----------|
| Setup complexity | Medium — rclone config, hook wiring, bucket provisioning |
| Git cleanliness | Excellent |
| Offline / local support | Full (local copy always present) |
| Agent read/write compatibility | Full |
| Collaboration / multi-device | Good for personal; limited for real-time team use |
| Migration cost | Low |

**Notes**: Gives the user a durable off-site backup in addition to sync. Not a real-time collaboration solution — two people editing simultaneously will overwrite each other. Works well as a personal backup/restore mechanism around a `git clone`.

---

## Comparison Table

| Option | Setup complexity | Git cleanliness | Offline support | Agent compatibility | Collab / multi-device | Migration cost |
|--------|-----------------|-----------------|-----------------|--------------------|-----------------------|---------------|
| A — Global `~/.flux/` | Low | Excellent | Full | High | None | Medium |
| B — SQLite | Medium | Excellent | Full | Reduced | None | High |
| C — Cloud backend | High | Excellent | Degraded | Reduced | Full | High |
| D — Gitignore `.flux/` | Minimal | Excellent | Full | Full | None | Minimal |
| E1 — Cloud folder (Drive/Dropbox) | Low–Medium | Excellent | Full | Full | Personal multi-device | Low |
| E2 — Git orphan branch | Medium | Excellent | Full | High | Personal + small team | Medium |
| E3 — Syncthing P2P | Medium | Excellent | Full | Full | Personal multi-device | Low |
| E4 — rclone object storage | Medium | Excellent | Full | Full | Personal multi-device | Low |

---

## E1 and E2 in Depth — How Agent Visibility Works

This section answers the practical question: *do we keep two copies of tickets, and how does the agent see them?*

### The key insight: the engine is the abstraction layer

In the current design, agents can read `.flux/*.md` files directly from disk OR go through the engine API. Once tickets move off-repo (via any option), **the engine API becomes the only canonical path**. The agent calls `GET /api/tasks`, the engine resolves wherever the ticket store lives, and the agent never needs to know the physical location. No duplicate copies needed.

---

### E1 (Google Drive) — how it actually works

**There is one canonical store.** Tickets live in a single folder on the Drive-synced path. The engine has a configurable `ticketStorePath` (set during first run or in `~/.event-horizon/settings.json`) that points there instead of `<repo>/.flux/`. The Drive client syncs changes in the background.

```
~/.event-horizon/settings.json:
  "ticketStorePath": "~/Google Drive/My Drive/event-horizon/my-project"

Engine reads/writes there → Drive client syncs automatically
Agent calls /api/tasks → engine resolves ticketStorePath → same files
```

The agent and portal work identically. The IDE extension works identically. The only visible change is where the files physically live.

**Is there any in-repo copy?** No — unless you also want `.flux/config.json` (board config) to stay repo-tracked, which is recommended since it IS application configuration. The separation is: `.flux/config.json` stays in the repo (tracked), ticket markdown files live at `ticketStorePath` (outside the repo).

**What happens on a fresh clone?** The engine detects that `ticketStorePath` doesn't exist (no Drive client, wrong machine) and falls back to empty local state or prompts to configure sync. Tickets are not in the repo, so `git clone` gives you the app but not the tickets — same as any other project management tool.

---

### E2 (Git orphan branch) — how it actually works

**There is still one canonical store per machine** — a git worktree. An orphan branch named `flux-data` lives in the same repository but has no commit ancestry with `main`. Git checks it out as a worktree at `.flux-store/` alongside the repo.

```
<repo>/
  .git/
  engine/
  portal/
  .flux/               ← only config.json stays here (tracked on main)
  .flux-store/         ← worktree pointing to flux-data branch (gitignored)
    FLUX-001.md
    FLUX-002.md
    ...
```

The engine's `ticketStorePath` points to `.flux-store/`. After each write, a git hook auto-commits and pushes `flux-data` to origin.

**Is there a two-instance problem?** No. There is one worktree (`flux-data`), one remote branch (`origin/flux-data`), and one sync path. No duplicate. The agent still goes through `GET /api/tasks`; it never reads `.flux-store/` directly.

**Multi-device flow**: on a second machine, after `git clone`, the engine setup command runs `git worktree add .flux-store flux-data` to restore the ticket state from the remote. This is a one-time step, automatable in the installer.

**What makes this "git-native"**: tickets get their own linear git history on `flux-data`. You can run `git log flux-data` to see every ticket mutation, `git diff flux-data~1 flux-data` to see what changed, and `git revert` to undo a bad bulk-rename — all without polluting `main`.

---

### First-run UX — what "just install and go" looks like

Both E1 and E2 require one configuration choice at setup. The startup wizard would present this as a single question:

```
Where should Event Horizon store your tickets?

  1. In this repo  (default — simple, no sync, current behaviour)
  2. Google Drive / Dropbox / iCloud  (personal multi-device, cloud client required)
  3. Git orphan branch  (git-native sync via existing remote, no extra tools)
  4. Custom path  (you choose)
```

For option 1: done immediately, no setup.
For option 2: ask for the folder path (or auto-detect Drive root), write `ticketStorePath` to settings, migrate existing `.flux/FLUX-*.md` files in place.
For option 3: the installer creates the orphan branch, adds the worktree, installs a post-commit hook, and pushes to origin — all automated. One command, ~5 seconds.

From that point on the user interacts with the portal and agent exactly as today. The storage location is invisible.

---

## Recommendation

**Recommended path: E2 (git orphan branch) with the "Invisible Sync" progressive upgrade UX.**

### Rationale

The orphan branch approach is the most technically sound choice for Event Horizon's developer audience: it is git-native, requires no external service, provides full offline support, and reuses the existing remote (GitHub, GitLab, etc.) for durability and multi-device sync. The key design insight is to combine it with a progressive disclosure UX so the "beginner" case stays frictionless.

### The "Invisible Sync" Implementation Plan

**Default state — in-repo (current behaviour, zero friction for new users)**

By default, tickets stay in `.flux/` inside the repo, exactly as today. New users see no difference. Git noise remains until they opt in to sync.

**Progressive upgrade — "Enable Cloud Sync via Git"**

When the user requests multi-device sync (via a settings prompt or a `flux sync enable` command), the engine performs the following automatically in a single operation:

1. Creates a `flux-data` orphan branch in the existing repo (no ancestry with `main`).
2. Moves all existing `.flux/FLUX-*.md` and `.flux/read-state.json` files to that branch via a git worktree at `.flux-store/`.
3. Adds `.flux/FLUX-*.md` and `.flux/read-state.json` to the repo's `.gitignore` so they no longer appear in `main` history.
4. Registers a **file watcher** on `.flux-store/` that drives debounced background pushes to `origin flux-data`.

From this point on the user never thinks about git. The portal and agent work identically. Ticket files are invisible to `main`.

### Managing Commit Volume

**Strategy A — Debouncing ("Wait for Silence")**

The file watcher does not commit on every write. Instead:

- When a file in `.flux-store/` changes, a 30-second silence timer starts.
- Any subsequent change resets the timer.
- When the timer fires, the engine commits all pending changes and pushes to `origin flux-data` in one batch.

This collapses bursts of agent writes (50+ individual status/comment mutations) into a single sync commit.

**Strategy B — Auto-Squashing ("Garbage Collection")**

To prevent `flux-data` from accumulating thousands of low-value "Changed status to In Progress" commits:

- Every 1,000 commits on `flux-data`, the engine performs a history reset: soft-reset to the initial commit, then creates a single new "Snapshot — YYYY-MM-DD" commit representing the current state of all ticket files.
- The remote branch is force-replaced with this squashed history.
- The local `.git` folder stays small and pushes remain fast.

### Multi-Machine Restore

On a fresh `git clone`, the installer runs `git worktree add .flux-store flux-data` to pull the existing ticket state from the remote. This is a one-time step that can be automated as part of `npm run setup` or `flux init`.

### Option Ranking Summary

| Option | Verdict |
|--------|---------|
| **E2 — Git orphan branch (recommended)** | Best overall: git-native, no external dependencies, full offline, automatable |
| E1 — Cloud folder (Drive/Dropbox) | Good fallback if the user has no git remote or prefers GUI sync |
| D — Gitignore only | Viable stepping stone if implementation of E2 is deferred; eliminates git noise immediately |
| E3/E4 — Syncthing / rclone | Consider only if git remote is unavailable or cloud providers are ruled out |
| A — Global `~/.flux/` | Simpler but no sync story; superseded by E2 |
| B — SQLite | Unjustified format change at current scale |
| C — Cloud backend | Right for enterprise/team tiers; not a baseline change |
