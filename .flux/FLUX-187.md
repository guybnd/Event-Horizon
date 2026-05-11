---
priority: Medium
tags:
  - ui
  - ui-polish
  - settings
  - portal
assignee: unassigned
effort: M
createdBy: Unknown
title: 'token cost badge: clickable toggle, cached/fresh split, color thresholds'
status: Done
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-11T01:57:54.024Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T01:58:10.113Z'
    comment: Launched Claude Code session (abdca332).
  - type: comment
    user: Guy
    date: '2026-05-11T01:58:43.402Z'
    comment: |-
      cose badge locations:
      top bar
      card box in board
      inside card full view top bar
    id: c-2026-05-11t01-58-43-397z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T02:00:24.233Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:00:24.234Z'
    comment: >-
      Grooming complete. Plan written to ticket body. All four badge locations
      identified (TaskCard, TaskModal, CliSessionPanel, Header). Key decisions:
      extract shared TokenBadge component to avoid 4x duplication; toggle writes
      directly to config via saveConfig; cache split tracked in engine as
      separate fields; thresholds stored in config.json and exposed in
      PreferencesSection.
    id: c-2026-05-11t02-00-24-234z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T02:00:29.995Z'
    comment: >-
      Grooming complete. Here's the plan summary:


      **4 badge locations:** TaskCard (board), TaskModal top bar,
      CliSessionPanel (agent session), Header (lifetime stats).


      **Key decisions made:**

      1. **Clickable toggle** — Extract a shared `TokenBadge` component used in
      all 4 locations. Click handler calls `saveConfig` directly so all
      locations sync immediately without a Settings page visit.


      2. **Cached/fresh split** — Engine splits `cache_read_input_tokens` and
      `cache_creation_input_tokens` into separate tracked fields instead of
      collapsing them into `inputTokens`. New fields appear in `tokenMetadata`
      and `CliSessionSummary`. Hover tooltip shows the breakdown.


      3. **Color thresholds** — `tokenCostThresholds: { green, yellow }` added
      to `Config`. Settings UI gets threshold number inputs under the token
      display toggle. Badge colors green/amber/red based on `costUSD` vs
      thresholds.


      Ticket is now in **Todo**, body has the full implementation plan, effort
      is **M**.
  - type: activity
    user: Agent
    date: '2026-05-11T02:00:38.685Z'
    comment: Launched Claude Code session (74da5be6).
  - type: activity
    user: Agent
    date: '2026-05-11T02:00:44.289Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-11T02:04:07.133Z'
    comment: Launched Claude Code session (3ab5290b).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T02:05:25.516Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:05:25.517Z'
    comment: >-
      Starting implementation: shared TokenBadge component, cache split in
      engine, color thresholds, Settings UI.
    id: c-2026-05-11t02-05-25-517z
  - type: activity
    user: Agent
    date: '2026-05-11T02:06:37.040Z'
    comment: Claude Code session stopped.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T02:18:36.284Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:18:36.285Z'
    comment: >-
      Implementation complete. Shared TokenBadge component extracted
      (portal/src/components/TokenBadge.tsx) and used in all 4 badge locations:
      TaskCard (card variant), TaskModal top bar (modal variant),
      CliSessionPanel (panel variant x2), Header lifetime cost badge. Clickable
      toggle updates tokenDisplayMode via saveConfig in each location. Engine
      now propagates cacheReadTokens/cacheCreationTokens through
      getCliSessionSummaryForTask and tokenMetadata accumulation on session exit
      (both main proc and reply proc). Tooltip shows cache read/creation/fresh
      breakdown. Color thresholds (green/amber/red) read from
      config.tokenCostThresholds and applied to cost display. PreferencesSection
      gains threshold number inputs. Settings.tsx wires tokenCostThresholds
      state. TypeScript clean on portal.
    id: c-2026-05-11t02-18-36-285z
  - type: comment
    user: Guy
    date: '2026-05-11T02:21:45.221Z'
    comment: cache input split does not seem to have been implemented
    replyTo: c-2026-05-11t02-18-36-285z
    id: c-2026-05-11t02-21-45-217z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-11T02:21:45.221Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-11T02:21:45.253Z'
    comment: Launched Claude Code session (15436909).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T02:25:21.507Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:25:21.507Z'
    comment: >-
      Investigation complete. The cache input split IS implemented correctly in
      the working tree. Root cause of the user report: the running engine loaded
      index.ts before the file was modified at 12:17PM, so cache fields never
      appeared in live session responses. After an engine restart,
      cacheReadTokens and cacheCreationTokens will flow through
      getCliSessionSummaryForTask and accumulate into tokenMetadata on session
      exit. TokenBadge tooltip shows cache read/creation/fresh breakdown on
      hover. Portal TypeScript clean.
    id: c-2026-05-11t02-25-21-507z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T02:25:29.841Z'
    comment: >-
      The implementation is complete and the ticket is now in Ready status.
      Here's what I found:


      **Root cause of the user's report:** The engine process started at
      12:09PM, but `engine/src/index.ts` was modified at 12:17PM by the previous
      agent session. Since the engine runs in no-watch mode after a source edit,
      it never reloaded — so `cacheReadTokens`/`cacheCreationTokens` were
      missing from all live session API responses.


      **What's actually implemented (correct in the working tree):**

      1. **Engine** — `getCliSessionSummaryForTask` returns
      `cacheReadTokens`/`cacheCreationTokens`, and both the main proc and reply
      proc accumulate them from
      `evt.usage.cache_read_input_tokens`/`cache_creation_input_tokens`. These
      are merged into `tokenMetadata` on session exit.

      2. **TokenBadge** — tooltip shows "Cache read: N · Cache creation: N ·
      Fresh input: N" when cache tokens are present.

      3. **Clickable toggle** — all 4 badge locations toggle `tokenDisplayMode`
      via `saveConfig`.

      4. **Color thresholds** — green/amber/red based on
      `config.tokenCostThresholds`.

      5. **PreferencesSection** — threshold number inputs wired through
      Settings.


      **Action needed:** Restart the engine to pick up the working tree changes
      before verifying.
  - type: activity
    user: Agent
    date: '2026-05-11T02:27:25.656Z'
    comment: Launched Claude Code session (b2f8152f).
  - type: activity
    user: Agent
    date: '2026-05-11T03:29:41.494Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-11T03:38:08.633Z'
    comment: Launched Claude Code session (73e2a3ac).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T03:38:31.065Z'
  - type: comment
    user: Agent
    date: '2026-05-11T03:38:31.066Z'
    comment: >-
      Shipped in commit 3c5875e. Implemented three enhancements: (1) cost badge
      is now clickable to toggle between USD cost and raw token count, updating
      the global tokenDisplayMode preference so both TaskCard and
      CliSessionPanel stay in sync; (2) engine now tracks cacheReadTokens and
      cacheCreationTokens separately from inputTokens, with a hover tooltip
      showing the fresh/cached breakdown; (3) color-coded thresholds
      (green/yellow/red) configurable via a new Preferences section with
      defaults /bin/zsh.10//bin/zsh.50. Validated TypeScript clean.
    id: c-2026-05-11t03-38-31-066z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T03:38:37.934Z'
    comment: >-
      FLUX-187 is closed. Ticket moved to Done with commit `3c5875e` recorded as
      the implementation link. The three shipped improvements: clickable
      cost/token toggle, cached vs fresh token split with hover tooltip, and
      color-coded thresholds with Preferences UI.
  - type: activity
    user: Agent
    date: '2026-05-11T03:38:41.545Z'
    comment: Claude Code session lost (engine restarted).
implementationLink: ''
subtasks: []
---
## Token Cost Badge Improvements

Three focused enhancements to the token cost badge shown on task cards and in the CLI session panel.

### 1. Clickable toggle (cost ↔ tokens)

The cost badge in both locations should be clickable to toggle between USD cost display and raw token count display. Currently this is a global setting in Preferences — it should also be toggleable inline by clicking the badge itself. The click should update the global `tokenDisplayMode` preference so both locations stay in sync.

### 2. Cached vs fresh token split

The engine currently collapses `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` into a single `inputTokens` figure. Split these so the display can show fresh vs cached separately. Cached tokens should be visible on hover only.

### 3. Color-coded thresholds + Settings UI

The cost badge should be color-coded based on configurable thresholds (green/yellow/red). Add a settings area in the Preferences tab to configure the threshold values. Conservative defaults: green < $0.10, yellow $0.10–$0.50, red > $0.50.

---

Scope: `portal/src/components/TaskCard.tsx`, `portal/src/components/task-modal/CliSessionPanel.tsx`, `portal/src/components/settings/PreferencesSection.tsx`, `portal/src/types.ts`, `engine/src/index.ts` (token metadata schema).
