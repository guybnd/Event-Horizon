---
assignee: Agent
tags:
  - docs
  - ux
priority: High
effort: M
implementationLink: 5cb795e8db9245c8009a13a36902ae1d5f492e6b
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T17:45:00.000Z'
    comment: Created ticket. Need a full docs pass — update setup, install, and how-to docs to reflect current binary distribution model.
  - type: comment
    user: Agent
    date: '2026-05-08T17:45:00.000Z'
    comment: >-
      Groomed. Audited existing docs against current reality:

      Current state of `.docs/event-horizon/`:
      - `installation.md` — still describes cloning the repo and running `npm
        run init`. Needs to describe downloading the binary and double-clicking
        it.
      - `project-overview.md` — generally fine; needs a note about the binary
        distribution model.
      - `architecture/` — likely still accurate for the engine/portal split but
        needs a pass for the IDE workspace model (workspaceRoot, settings.json,
        NO_WORKSPACE 503s).
      - `workflow/ticket-lifecycle.md`, `ticket-interactions.md`,
        `workflow-install.md` — may reference old dev-only setup or outdated
        skill paths.

      Key things that changed since docs were last written:
      1. **Binary distribution** — users download `event-horizon.exe` (or macOS/
         Linux equivalent), double-click, browser opens automatically. No Node.js,
         no git clone, no npm install.
      2. **`event-horizon.config.json`** — sits next to the exe; edit to change
         port before first launch.
      3. **IDE workspace model** — binary starts with no project; user clicks
         "Browse" or types a path in the portal to open a project. Workspace is
         remembered across restarts in `~/.event-horizon/settings.json`.
      4. **`event-horizon init`** — still needed for first-time project setup,
         but now you run the binary's init command (or `npx event-horizon init`)
         rather than `npm run init -w engine`.
      5. **System tray** — background process; no terminal window. Quit from tray.
      6. **Skill install** — Settings → Workspace tab → Install Agent Workflow.
         Binaries embed the skill files so no internet access needed.
      7. **README.md** at repo root — update to reflect binary-first usage for
         new users, keep developer contribution section for contributors.

      Files to update/create:
      - `.docs/event-horizon/installation.md` — rewrite as binary-first guide.
      - `.docs/event-horizon/project-overview.md` — add binary distribution paragraph.
      - `.docs/event-horizon/architecture/overview.md` — update workspace model
        section.
      - `README.md` — update "Install in Your Project" to binary-first; keep
        dev setup section below for contributors.
      - Optionally: create `.docs/event-horizon/configuration.md` covering
        `event-horizon.config.json`, `config.json` schema, and `settings.json`.

      Out of scope for this ticket: API reference, full config schema exhaustive
      reference (can be a follow-up).
    id: c-flux127-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T17:45:00.000Z'
  - type: comment
    user: Antigravity
    date: '2026-05-08T08:39:20.000Z'
    comment: >-
      Completed the full documentation pass for the binary distribution model. Rewrote `installation.md`, added the binary context to `project-overview.md` and `architecture/overview.md`, streamlined the `README.md` for a binary-first quick start, and created the new `configuration.md` reference guide. Committed in `5cb795e8db9245c8009a13a36902ae1d5f492e6b`.
    id: c-2026-05-08t08-39-20-000z
  - type: status_change
    from: Todo
    to: Done
    user: Antigravity
    date: '2026-05-08T08:39:20.000Z'
id: FLUX-127
title: Docs pass — update setup, install, and architecture docs for binary distribution
status: Done
createdBy: Guy
updatedBy: Agent
---

## Problem / Motivation

The existing `.docs/` and `README.md` content still describes the pre-binary, developer-first setup (clone the repo, run npm, point at a local workspace via CLI). Since FLUX-73/76/77/78/121/122/124, Event Horizon ships as a standalone binary with an IDE-style workspace picker, auto-open browser, and system tray. A new user following the current docs would be completely lost.

## Implementation Plan

### 1. `.docs/event-horizon/installation.md` — full rewrite

Structure:
- **Quick start (binary)**: download → double-click → browser opens → click Browse → select or init a project folder
- **Init a new project**: run `event-horizon init` (or point the binary at an already-initialised `.flux/` folder)
- **Configuration**: `event-horizon.config.json` (port), `.flux/config.json` (board), `~/.event-horizon/settings.json` (last workspace)
- **Install the agent workflow skill**: Settings → Workspace → Install Agent Workflow
- **Switching projects**: Settings → Workspace → browse to new folder
- **Quitting**: system tray → Quit

### 2. `.docs/event-horizon/project-overview.md`

Add a paragraph describing the binary distribution model and point to installation.md.

### 3. `.docs/event-horizon/architecture/overview.md`

Update to describe:
- IDE workspace model (`workspaceRoot`, `requireWorkspace` middleware, 503 `NO_WORKSPACE`)
- Settings persistence (`~/.event-horizon/settings.json`)
- System tray lifecycle
- Port config (`event-horizon.config.json`)

### 4. `README.md`

- Lead with binary-first quick start (3 lines: download, run, browse to project)
- Move developer contribution section below the fold
- Update any npm-run-based instructions that only apply to contributors

### 5. `.docs/event-horizon/configuration.md` (new)

Reference page covering:
- `event-horizon.config.json` fields
- `.flux/config.json` schema (columns, statuses, projectKey, tags, users, etc.)
- `~/.event-horizon/settings.json` (workspace persistence)
