---
assignee: unassigned
tags:
  - refactor
  - dx
priority: Low
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T05:57:41.461Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-10T06:52:26.410Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-10T14:10:14.131Z'
    comment: Launched Claude Code session (cfdf5307).
  - type: activity
    user: Agent
    date: '2026-05-10T14:10:58.975Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-10T14:16:03.401Z'
    comment: Launched Claude Code session (5a69bc30).
  - type: activity
    user: Agent
    date: '2026-05-10T14:17:38.623Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-10T14:37:11.122Z'
    comment: Launched Claude Code session (793e2576).
  - type: activity
    user: Agent
    date: '2026-05-10T14:39:07.373Z'
    comment: >-
      Updated description. Updated tags to refactor, dx. Changed priority from
      None to Low. Changed effort from None to M.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T14:39:13.993Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:39:13.994Z'
    comment: >-
      Grooming complete. Full refactor analysis written to ticket body. Four
      areas identified: (1) engine/src/index.ts split into ~12 modules with a
      shared processCliOutput() to eliminate duplicated stdout loop; (2)
      TaskModal.tsx hooks + sub-component extraction targeting ~600-line result;
      (3) Settings.tsx section split; (4) optional AppContext hooks. Three
      follow-on implementation tickets proposed.
    id: c-2026-05-10t14-39-13-994z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T14:39:20.801Z'
    comment: >-
      Grooming complete. Here's the analysis summary written to the ticket:


      **Findings — 4 areas ranked by token-cost impact:**


      1. **`engine/src/index.ts` (2551 lines, highest priority)** — monolith
      with every concern crammed in. Most critically, the JSON stdout-processing
      loop (event parsing, pending-text logic, token accumulation,
      permission-block detection) is copy-pasted verbatim across both the
      `start` and `input` CLI session routes (~80 duplicate lines). Proposed
      split into ~12 focused modules (`config.ts`, `history.ts`,
      `cli-session.ts`, `routes/*.ts`, etc.) with a shared `processCliOutput()`
      function eliminating the duplication.


      2. **`portal/src/components/TaskModal.tsx` (2707 lines)** — 38+ `useState`
      calls in one component. Proposed extractions: `useTaskForm`,
      `useCliSession`, `useImageAttachment` hooks, plus `MetadataPanel`,
      `CommentBox`, and `CliSessionPanel` components. Target: ~600 lines.


      3. **`portal/src/components/Settings.tsx` (1447 lines)** — split each
      settings section into `portal/src/components/settings/*.tsx`; parent
      becomes a tab switcher only.


      4. **`portal/src/AppContext.tsx` (746 lines)** — optional: extract
      `useTaskPolling` and `useHealthCheck` hooks (~180 lines removed).


      **Three follow-on implementation tickets are proposed** in the body. All
      refactors are structural-only — no behaviour changes.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T14:41:50.762Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:41:50.763Z'
    comment: >-
      Creating three follow-on implementation tickets: FLUX-182 (engine split),
      FLUX-183 (TaskModal extraction), FLUX-184 (Settings split).
    id: c-2026-05-10t14-41-50-763z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-10T14:43:49.452Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:43:49.453Z'
    comment: >-
      Created three follow-on implementation tickets from the refactor plan:
      FLUX-182 (Split engine/src/index.ts into focused modules, effort L),
      FLUX-183 (Extract TaskModal hooks and sub-components, effort L), FLUX-184
      (Split Settings.tsx into per-section components, effort M). All three are
      in Grooming status, ready for implementation planning.
    id: c-2026-05-10t14-43-49-453z
  - type: activity
    user: Agent
    date: '2026-05-11T03:29:41.494Z'
    comment: Claude Code session lost (engine restarted).
title: identify refactor opportunities to make code more readable
status: Done
createdBy: Guy
updatedBy: Agent
---
## Goal

Analyse the codebase for refactor opportunities that improve human and AI readability, reduce per-turn token cost, and enforce separation of concerns. This ticket produces a plan document — no code changes are made here. Implementation is broken into follow-on tickets.

---

## Findings

### 1. `engine/src/index.ts` — 2551 lines, single monolith

The biggest problem in the codebase. Every concern lives in one file: Express setup, middleware, file I/O helpers, history utilities, asset helpers, docs helpers, CLI session management, and all ~25 route handlers.

**Duplicated stdout-processing loop** — The JSON event parsing, pending-assistant-text logic, token accumulation, and permission-block detection appear verbatim in both `POST /cli-session/start` (lines 1336–1415) and `POST /cli-session/input` (lines 1538–1604). ~80 lines of near-identical code with separate bugs and comments.

**Proposed split:**

```
engine/src/
  index.ts              ← app setup + server start only (~80 lines)
  middleware.ts         ← requireWorkspace, cors, json setup
  workspace.ts          ← workspaceRoot, activateWorkspace, settings I/O
  config.ts             ← loadConfig, saveConfig, configCache, autoRegisterUnknownTags
  history.ts            ← buildCommentEntry, buildActivityEntry, normalizeHistoryEntries,
                           summarizeFieldChanges, hasAppendedStatusChange, ensureCreationActivity
  file-utils.ts         ← asset path helpers, doc path helpers, image/extension utils
  cli-session.ts        ← CliSessionRecord type, session maps, processCliOutput(),
                           appendSessionOutput, flushSessionOutput, stopAllCliSessions
  routes/tasks.ts       ← GET/POST/PUT/DELETE /api/tasks
  routes/cli-session.ts ← start, input, stop routes
  routes/docs.ts        ← /api/docs routes
  routes/config.ts      ← /api/config routes
  routes/workspace.ts   ← /api/workspace, /api/health, /api/path-setup
  routes/assets.ts      ← /api/assets, /api/tasks/:id/assets
  routes/skill.ts       ← /api/skill/status, /api/skill/install
  routes/stats.ts       ← /api/stats/tokens
```

**Extract `processCliOutput(session, proc, taskId)`** — shared by start and input routes. Eliminates the duplication entirely.

**Extract `buildInitialPrompt(task, config, appendPrompt)`** — the 20-line prompt-building block inside the start route. Makes the route handler skinny and testable.

---

### 2. `portal/src/components/TaskModal.tsx` — 2707 lines, single component

The `TaskModal` function has 38+ `useState` calls, 10 `useRef` calls, and hundreds of lines of inline JSX for metadata fields, comment boxes, CLI session panel, and the history list. It also owns all image-attachment logic.

**Proposed extractions:**

| Extract | Lines saved (approx) | What it contains |
|---|---|---|
| `useTaskForm(modalTask)` hook | ~120 | All form field state + dirty detection + originalPayload/currentPayload memos |
| `useCliSession(taskId)` hook | ~100 | cliSession state, sessionIsActive, selected framework, skipPermissions |
| `useImageAttachment(...)` hook | ~140 | `attachImageFilesToDraft`, `attachCommentImageFiles`, `attachReplyImageFiles`, paste/drag handlers |
| `MetadataPanel` component | ~250 | Status, Assignee, Priority, Effort, EffortOverride, ImplLink, Tags, Subtasks selects/inputs |
| `CommentBox` component | ~120 | Textarea + paste/drag handlers + asset error + submit button |
| `CliSessionPanel` component | ~150 | Live output pre, token display, stop/launch controls |

Leaving `TaskModal` responsible only for layout, modal chrome, and wiring the extracted pieces together — targeting ~600 lines.

---

### 3. `portal/src/components/Settings.tsx` — 1447 lines

Already has internal sub-components (`TagEditor`, `StatusEditor`, `PriorityEditor`, `SimpleEditor`). The main `Settings` export is still large because all sections (General, Board, Integrations, Releases) are inline.

**Proposed split:** Extract each settings section into its own component file under `portal/src/components/settings/`. The parent `Settings.tsx` becomes a tab switcher + save handler only.

---

### 4. `portal/src/AppContext.tsx` — 746 lines

Reasonably sized, but the context owns both global app state and two independent polling concerns.

**Optional extractions (lower priority):**
- `useTaskPolling(workspaceConfigured)` hook — `loadTasks`, live events, visibility/focus listeners, poll interval
- `useHealthCheck()` hook — the 10-second health check loop

Would shrink `AppContext.tsx` by ~180 lines and make each concern independently readable.

---

## Priority Order

1. **engine/src/index.ts split** — highest token-cost reduction; fixes the duplicated stdout loop first
2. **TaskModal.tsx hooks + component extraction** — largest file in portal; biggest AI context burden
3. **Settings.tsx section split** — straightforward, good DX win
4. **AppContext.tsx hooks** — optional polish, low urgency

---

## Out of Scope

- No behaviour changes — all refactors are structural only
- No new abstractions beyond what already exists (no generic form library, no state management library)
- Tests are not added in this ticket; refactored modules should remain straightforwardly testable

---

## Follow-on Tickets to Create

- `FLUX-XXX` — Split engine/src/index.ts into modules (extract processCliOutput + route files)
- `FLUX-XXX` — Extract TaskModal hooks and sub-components
- `FLUX-XXX` — Split Settings.tsx into section components
