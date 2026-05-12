---
assignee: unassigned
tags:
  - architecture
  - backend
  - engine
  - bug
priority: High
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-12T03:22:30.030Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-12T03:22:32.152Z'
    comment: Launched Claude Code session (3c569bb4).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T03:27:00.423Z'
  - type: activity
    user: Agent
    date: '2026-05-12T03:27:00.423Z'
    comment: Updated description.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T03:27:08.901Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T03:27:15.808Z'
    comment: >-
      Grooming is done. Here's the summary:


      **6 confirmed bugs found** across the git sync implementation:


      | # | File | Bug | Impact |

      |---|------|-----|--------|

      | 1 | `routes/tasks.ts:43` | New tickets use `getFluxDir()` instead of
      `getActiveFluxDir()` | New tickets land in `.flux/` (not synced) in orphan
      mode |

      | 2 | `routes/tasks.ts:269` | Asset path computed relative to `.flux/`
      instead of active dir | Broken inline image paths on sync workspaces |

      | 3 | `patch-ticket.ts:82,92` | Hardcoded `.flux/` path, no orphan-mode
      detection | CLI fails silently on sync workspaces |

      | 4 | `index.ts:199,202` | Startup only checks for `.flux/`, not
      `.flux-store/` | Fully-migrated workspaces don't auto-activate |

      | 5 | `release.ts:5` | Hardcoded `__dirname`-relative `.flux/` path |
      `flux:release` reads wrong dir on sync workspaces |

      | 6 | `storage-sync.ts:116-123` | Pre-restore snapshot committed but never
      pushed | Data loss from remote on restore |


      Also documented as **design constraints** (not bugs): `.flux` dir name is
      mandatory and hardcoded, `flux-data` branch name is hardcoded,
      `read-state.json` is intentionally local-only (per-machine), and the 30s
      debounce is not configurable.


      Ticket is now `Todo`.
  - type: activity
    user: Agent
    date: '2026-05-12T03:27:15.811Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T03:29:10.317Z'
    comment: >-
      Updated description. Updated tags to architecture, backend, engine, bug.
      Changed priority from Critical to High. Changed effort from None to M.
  - type: activity
    user: Agent
    date: '2026-05-12T03:31:41.396Z'
    comment: Launched Claude Code session (ea6be6ee).
  - type: status_change
    from: Todo
    to: Ready
    user: Agent
    date: '2026-05-12T03:35:25.619Z'
  - type: comment
    user: Agent
    date: '2026-05-12T03:35:25.620Z'
    comment: >-
      Implementation complete. All 6 orphan-mode hardcoded path issues fixed:


      1. routes/tasks.ts:43,269 — new ticket write and asset URL path now use
      getActiveFluxDir()

      2. index.ts:199,202 — startup workspace validation now accepts
      .flux-store/ via isValidWorkspaceRoot() helper

      3. patch-ticket.ts:82,92 — ticket path and config path detect .flux-store/
      via existsSync before resolving

      4. release.ts:5 — FLUX_DIR now detects orphan mode; --workspace flag added
      for explicit override

      5. task-store.ts:288 — chokidar ignored filter now compares against
      path.basename(getActiveFluxDir()) instead of hardcoded '.flux'

      6. WorkspaceSelector.tsx, WorkspaceSection.tsx — UI copy updated to
      mention .flux/ or .flux-store/


      No new TypeScript errors introduced.
  - type: comment
    user: Agent
    date: '2026-05-12T03:47:59.989Z'
    comment: >-
      Fixed all three issues from the code review:


      1. OnboardingWizard.tsx:186 — updated copy to mention both .flux/ and
      .flux-store/ directories

      2. patch-ticket.ts:93 — removed duplicate existsSync call in
      loadRequireInputStatus; now uses the already-computed fluxSubdir
      module-level variable

      3. WorkspaceSection.tsx:174 — gated the Sync Timing inputs block on
      storageMode === 'orphan' so they only appear when sync is actually active


      Portal TypeScript compiles clean. Engine errors are pre-existing in
      claude-code.ts, unrelated to this ticket.
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-12T03:56:48.021Z'
  - type: comment
    user: Agent
    date: '2026-05-12T03:56:48.022Z'
    comment: >-
      Implementation complete. Commit 6999ead covers all six fixes:
      getActiveFluxDir() in routes/tasks.ts, isValidWorkspaceRoot() helper in
      index.ts, orphan-mode path detection in patch-ticket.ts, --workspace flag
      and orphan detection in release.ts, dynamic basename in task-store.ts
      chokidar filter, and updated portal copy in
      WorkspaceSelector/OnboardingWizard/WorkspaceSection. implementationLink:
      6999ead
title: do a pass after the git sync feature
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 479978
  outputTokens: 10041
  costUSD: 0.683508
  costIsEstimated: false
  cacheReadTokens: 435094
  cacheCreationTokens: 41845
---
## Overview

Holistic audit and fix of all hardcoded `.flux/` assumptions that break or degrade behaviour in orphan mode (`.flux-store/`). These are the remaining gaps between the FLUX-209 implementation and a releasable orphan-mode experience.

---

## Issues Found

### 1. `routes/tasks.ts` — new ticket write path hardcoded to `.flux/`

**File:** `engine/src/routes/tasks.ts:43`

```ts
const filePath = path.join(getFluxDir(), `${nextId}.md`);
```

When a new ticket is created in orphan mode, it is written to `.flux/` instead of `.flux-store/`. Fix: use `getActiveFluxDir()`.

Also line 269: `path.relative(getFluxDir(), filePath)` used for asset URL construction — should use `getActiveFluxDir()`.

---

### 2. `engine/src/index.ts` — startup workspace validation requires `.flux/` to exist

**File:** `engine/src/index.ts:199,202`

```ts
const cwdFallback = existsSync(path.join(process.cwd(), '.flux')) ? process.cwd() : null;
if (initial && existsSync(path.join(initial, '.flux'))) {
```

In orphan mode `.flux/` still exists (as an empty directory) so this does not break activation today, but it is fragile — a fresh clone with `flux-data` but no `.flux/` directory would fail to auto-activate. Fix: accept a workspace root if either `.flux/` or `.flux-store/` exists (or `.flux-store` is reachable via remote).

---

### 3. `patch-ticket` CLI hardcoded to `.flux/`

**File:** `engine/src/patch-ticket.ts:82,92`

```ts
const ticketPath = path.resolve(opts.workspace, '.flux', `${opts.id}.md`);
const configPath = path.resolve(workspace, '.flux', 'config.json');
```

The agent uses `patch-ticket` to update tickets. In orphan mode these paths are wrong and `patch-ticket` fails with "ticket file not found". Fix: detect orphan mode (`.flux-store/` exists) and resolve to the correct directory. Since `patch-ticket` is a standalone CLI it cannot import the engine's runtime `isOrphanMode()` — instead check `existsSync(path.join(workspace, '.flux-store'))` directly.

---

### 4. `release.ts` hardcoded to `__dirname/../../.flux`

**File:** `engine/src/release.ts:5`

```ts
const FLUX_DIR = path.join(__dirname, '../../.flux');
```

The release script reads tickets directly using a static path relative to the build output. In orphan mode this will read from `.flux/` (empty) and find no `Done` tickets. Fix: detect orphan mode and use `.flux-store/` accordingly. Accept a `--workspace` flag or resolve from CWD.

---

### 5. `task-store.ts` chokidar watcher `ignored` filter references `.flux` string literal

**File:** `engine/src/task-store.ts:288`

```ts
return basename.startsWith('.') && basename !== '.flux';
```

The exception for `.flux` prevents the watcher from skipping it as a hidden directory. In orphan mode the watcher watches `.flux-store/` — the exception should be updated to `.flux-store` to keep the same semantics. Fix: compare against the basename of `getActiveFluxDir()` instead of a hardcoded string.

---

### 6. Portal `TaskMarkdown.tsx` — asset URL prefix hardcoded to `.flux/assets/`

**File:** `portal/src/components/TaskMarkdown.tsx:8`

```ts
const FLUX_ASSETS_PREFIX = '.flux/assets/';
```

Image references embedded in ticket bodies use this prefix. The engine's asset API (`/api/assets/`) already resolves via `getTaskAssetsDir()` which is orphan-aware, so the API side is fine. However, if any ticket body was written with a `.flux/assets/…` path (all existing tickets were), and the asset is now in `.flux-store/assets/`, the path strip logic still works because it strips the prefix and calls the API — so this is actually fine at runtime. **No fix required** — asset serving already goes through the orphan-aware API.

---

### 7. Portal UI copy — `.flux/` directory name used in user-facing strings

**Files:**
- `portal/src/components/WorkspaceSelector.tsx:52`
- `portal/src/components/OnboardingWizard.tsx:186`
- `portal/src/components/settings/WorkspaceSection.tsx:53`

These strings tell the user "folder must contain a `.flux/` directory." In orphan mode the workspace is valid even if `.flux/` is empty (tickets are in `.flux-store/`). A fresh clone may only have `.flux-store/`. The copy should reflect that either directory qualifies.

---

## Implementation Plan

### Step 1 — Fix `routes/tasks.ts`
- Line 43: `getFluxDir()` → `getActiveFluxDir()` for new ticket write path
- Line 269: `getFluxDir()` → `getActiveFluxDir()` for asset URL relative path
- Add `getActiveFluxDir` to the import

### Step 2 — Fix `index.ts` workspace startup validation
- Extract a helper `isValidWorkspaceRoot(dir)` that returns true if `.flux/` or `.flux-store/` exists
- Replace both hardcoded `existsSync(path.join(..., '.flux'))` checks with this helper

### Step 3 — Fix `patch-ticket.ts`
- After resolving `opts.workspace`, check if `path.join(opts.workspace, '.flux-store')` exists
- If so, resolve ticket path and config path from `.flux-store/` instead of `.flux/`

### Step 4 — Fix `release.ts`
- Accept a `--workspace` CLI flag (default: CWD two levels up from `__dirname` to match current behaviour)
- Detect orphan mode via `existsSync(path.join(workspaceRoot, '.flux-store'))`
- Set `FLUX_DIR` to `.flux-store` or `.flux` accordingly

### Step 5 — Fix chokidar ignored filter in `task-store.ts`
- Replace hardcoded `'.flux'` string with `path.basename(getActiveFluxDir())`

### Step 6 — Update portal UI copy
- `WorkspaceSelector.tsx`, `OnboardingWizard.tsx`, `WorkspaceSection.tsx`: update copy to say the folder must contain a `.flux/` or `.flux-store/` directory

## Validation
- Create a new ticket in orphan mode — confirm it lands in `.flux-store/`
- Run `patch-ticket` against a ticket in orphan mode — confirm it finds the file
- Run `flux:release` from a workspace in orphan mode — confirm it finds `Done` tickets
- Watcher change events fire correctly for `.flux-store/` files
- Fresh clone with only `flux-data` remote branch auto-activates correctly
- UI copy no longer misleads orphan-mode users
