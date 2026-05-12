# 🌌 Event Horizon

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-blue.svg)]()

> A local-first, agent-centric project management layer designed as the operating surface for solo developers and small teams building alongside AI coding agents.

Event Horizon stores all state in your repository — tickets, documentation, workflow instructions, and product code live together in version control. There is no cloud service, no account, and no sync dependency unless you want one.

---

## ✨ Core Principles

- **🗂️ Filesystem as Database:** Tickets are plain Markdown files with YAML frontmatter. Version control your management system just like your code. Open any ticket in VS Code, Obsidian, or a text editor.
- **🤖 Agent-First & Human-Friendly:** The file format is instantly parseable by LLMs while remaining readable and editable by humans. Agents and humans use the same surface.
- **⚡ Zero Latency:** No cloud APIs. The UI reacts at the speed of your local disk.
- **🔀 Flexible Storage:** Tickets live in-repo by default. Enable Git Sync to move them to an orphan branch — keeping ticket history off your main branch while retaining full git-native sync across machines.

---

## 🏗️ Architecture

```
Event Horizon Binary
├── engine/          Node.js/TypeScript REST API — reads, writes, and watches repo-backed state
├── portal/          React + Vite + Tailwind CSS v4 — board, backlog, docs, settings
└── data layer
    ├── .flux/       Board config (config.json), workflow skills, and tickets (default mode)
    └── .flux-store/ Git worktree on orphan branch — tickets only (Git Sync mode)
```

The binary embeds the engine and portal into a single executable. No Node.js or `npm install` required for end users.

### Storage Modes

**In-Repo (default):** Ticket files live in `.flux/` alongside your code. Simple to set up, no extra git knowledge needed.

**Git Sync (orphan branch):** Ticket files move to a `flux-data` orphan branch, checked out as a `.flux-store/` worktree. The branch shares your existing remote (GitHub, GitLab, etc.) but has zero commit ancestry with `main`. Benefits:
- Your `git log` stays clean — ticket churn never contaminates code history
- Tickets sync across machines via normal `git push/pull` on a separate branch
- No external service — the same remote you already use handles everything
- Agents reading `git log` see only real code changes

Enable it in **Settings → Git Sync → Enable Git Sync**. Migration is one click and fully reversible.

---

## 🚀 Quick Start (Binary Distribution)

Event Horizon ships as a standalone zero-dependency executable for Windows, macOS, and Linux.

1. **Download & Run:** Get the latest binary from the [releases page](../../releases) and launch it.
2. **Connect:** Your browser opens automatically at `http://localhost:3067`.
3. **Select Workspace:** Click **Browse** in the portal to select your project folder. If the folder has no `.flux/` directory yet, the onboarding wizard walks you through initial setup.

The service runs as a system tray application. Closing your browser does not stop the engine — quit from the tray icon or the portal header.

---

## ⚙️ Config Reference (`.flux/config.json`)

Board layout and behaviour are controlled by `.flux/config.json`:

| Field | Description |
|-------|-------------|
| `columns` | Board columns shown on the Kanban view (`name`, optional `color`) |
| `hiddenStatuses` | Statuses tracked in the system but hidden from the main board |
| `projects` | Project key prefixes, e.g. `["MYAPP"]` — determines ticket ID format |
| `users` | Known users and agents (`{ name: "Alice" }`) |
| `tags` | Tag definitions with optional colors |
| `priorities` | Priority levels with icons and colors |
| `enableBacklogScreen` | `true` to show the Backlog nav item |
| `requireInputStatus` | Status agents use when they need clarification (default `"Require Input"`) |
| `readyForMergeStatus` | Pre-merge review checkpoint status (default `"Ready"`) |
| `boardCardOpenMode` | `"full"` opens ticket in full view on card click; `"preview"` opens sidebar |
| `animationsEnabled` | Toggle UI animations |
| `docsRoot` | Path relative to workspace root where wiki markdown files live (default `.docs`) |
| `syncSettings.debounceMs` | Git Sync: milliseconds of file-write silence before auto-commit fires |
| `syncSettings.maxWaitMs` | Git Sync: maximum milliseconds before a sync is forced even under sustained writes |

---

## 🔀 Git Sync — How It Works

When you enable Git Sync, the engine performs a one-time migration:

1. Creates a `flux-data` orphan branch (no ancestry with `main`)
2. Moves all ticket `.md` files, `config.json`, `read-state.json`, and assets into a `.flux-store/` worktree pointing to that branch
3. Gitignores `.flux/` data files and `.flux-store/` on `main` so they never appear in code commits
4. Pushes `flux-data` to your remote immediately

From that point, a file watcher monitors `.flux-store/` and auto-commits and pushes on a debounced schedule (default: commit after 30s of silence, force after 5 minutes of continuous writes). You never run git commands manually.

**Multi-machine restore:** On a fresh clone where `flux-data` exists on the remote, the engine automatically re-attaches the worktree at startup via `git worktree add`. Your tickets appear without any extra steps.

**Restore to in-repo:** Settings → Git Sync → Restore to In-Repo reverses the migration cleanly — files move back to `.flux/`, the worktree is removed, and gitignore entries are cleaned up.

---

## 🤖 Agent Workflow

Event Horizon provides a structured workflow that keeps AI agents and humans on the same page throughout a ticket's lifecycle.

### The Ticket Lifecycle

1. **Grooming:** Drop a ticket onto the board. Instruct your agent to groom it — the agent reads the ticket, fleshes out requirements, estimates effort and priority, and rewrites the ticket body as a concrete implementation plan.
2. **Require Input:** If the agent needs a decision before it can proceed, it posts one focused question to the ticket history and moves the ticket to **Require Input**. The portal surfaces this as a visual prompt on the card.
3. **Todo → In Progress:** Once the plan is solid, the ticket moves to **Todo** and your agent picks it up for implementation.
4. **Ready:** When implementation is complete, the agent stages nothing and moves the ticket to **Ready** for your review.
5. **Finish:** You review the changes. When satisfied, say `finish FLUX-XX` in chat. The agent commits all changes, records the commit hash in `implementationLink`, and closes the ticket to **Done** — atomically in one step.

### Installing the Workflow

The workflow is a set of phase-specific skill files installed into your project's `.github/` directory (or Anthropic's Claude Code rules format). Install or refresh via:

- **Portal:** Settings → Install Agent Workflow
- **CLI:** `npx event-horizon install-skill --target /path/to/project`

The installer patches only the Event Horizon blocks in your instructions file, leaving unrelated custom instructions untouched.

### Two-Way CLI Integration

Event Horizon integrates with AI coding CLIs (Claude Code, Copilot CLI) for a live session loop:

- Agent sessions launched from a ticket appear in the ticket's activity history
- Session end/exit is recorded automatically
- User prompts arriving from the CLI are displayed as inline comment replies on the ticket
- Token usage and cost estimates are tracked per session

---

## 📝 Ticket Format

Tickets are `.md` files in `.flux/` (or `.flux-store/` in Git Sync mode) with YAML frontmatter:

```yaml
---
title: "Add dark mode toggle"
status: Done
createdBy: User
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - ui
priority: High
effort: M
implementationLink: a488a47
subtasks: []
history:
  - type: activity
    user: User
    date: '2026-05-07T09:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T09:10:00.000Z'
    comment: Moved to Require Input. Should we use standard slate or a custom hex palette?
  - type: comment
    user: User
    date: '2026-05-07T09:15:00.000Z'
    comment: Use Tailwind's standard slate colors.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-07T09:20:00.000Z'
  - type: activity
    user: Agent
    date: '2026-05-07T09:40:00.000Z'
    comment: >-
      Implemented slate dark mode via Tailwind. Committed in a488a47.
---

# Objective
Implement a dark mode toggle that persists user preference via local storage.

# Tasks
- [x] Add toggle icon to Header
- [x] Wire up theme context provider
- [x] Test layout with slate palette
```

History entries are append-only. The YAML frontmatter is schema-validated on load — invalid frontmatter surfaces as a visible error in the portal rather than silently corrupting the board.

---

## 📚 Project Documentation

Event Horizon ships with an in-product documentation tree under `.docs/`, served through the portal's **Docs** screen. Core materials:

- **[Project Overview](.docs/event-horizon/project-overview.md)** — System shape and shipped capabilities
- **[Architecture Overview](.docs/event-horizon/architecture/overview.md)** — Runtime logic, storage models, and request flow
- **[Decoupled Storage](.docs/event-horizon/architecture/decoupled-storage.md)** — Git Sync design, options considered, and the orphan branch implementation
- **[Docs Workspace](.docs/event-horizon/architecture/docs-workspace.md)** — How the docs tree, live editor, and permissions work
- **[Repository Map](.docs/event-horizon/architecture/repository-map.md)** — Key codebase surfaces and file locations
- **[Ticket Lifecycle](.docs/event-horizon/workflow/ticket-lifecycle.md)** — Status model and agent execution rules
- **[Workflow Install](.docs/event-horizon/workflow/workflow-install.md)** — Installing and refreshing agent skills

> When shipped behavior changes, update the nearest `.docs/` page rather than leaving context buried in ticket history.

---

## 🛠️ Development Setup

### Prerequisites
- Node.js ≥ 18
- Two terminal windows (engine + portal dev server)

### 1. Start the Engine
```bash
cd engine
npm install
npm run dev
```
Runs on `http://localhost:3067`. Hot-reloads on source changes.

### 2. Start the Portal (hot reload)
```bash
cd portal
npm install
npm run dev
```
Runs on `http://localhost:5167` and proxies `/api` calls to the engine.

### Pointing at a workspace
The engine needs a workspace to serve tickets from. Either pass it as a flag:
```bash
cd engine && npm run dev -- --workspace /path/to/your/project
```
Or select one from the portal's Settings screen after startup.

---

## 🏗️ Production Build

```bash
npm run build          # Build portal (Vite) + engine (esbuild bundle)
npm run package:mac    # Package into a macOS standalone binary
npm run package:win    # Package into a Windows standalone binary
```

The packaged binary serves both the API and portal from a single process.

---

## 🔧 Utilities

### patch-ticket CLI

Safely edit ticket YAML from the terminal without risking frontmatter corruption:

```bash
# From the engine directory
npm run patch-ticket -- FLUX-42 --status "In Progress"
npm run patch-ticket -- FLUX-42 --comment "implementation complete"
npm run patch-ticket -- FLUX-42 --status "Ready" --comment "all tests pass"

# From the repo root (no cd needed)
npx tsx engine/src/patch-ticket.ts FLUX-42 --workspace . --status "Done"
```

Works in both in-repo and Git Sync modes — detects `.flux-store/` automatically.
