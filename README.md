# Event Horizon

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-blue.svg)]()

> A local-first, agent-centric project management layer designed as the operating surface for solo developers and small teams building alongside AI coding agents.

Event Horizon stores all state in your repository — tickets, documentation, workflow instructions, and product code live together in version control. There is no cloud service, no account, and no sync dependency unless you want one.

---

## Features

### 1. 🤖 A local-first agent board

Send a ticket to an agent straight from its card and watch progress stream back to the ticket in real
time. There's no cloud service and no account — the engine runs locally and every artifact (tickets,
docs, workflow rules) is a plain file in your repo. Because each agent gets its own branch **and its
own git worktree** off to the side, concurrent agents never clobber each other and your working tree
stays clean.


> [](https://github.com/user-attachments/assets/e6b539f4-c082-4f2f-8b8b-2020c8c5c5dd)


<!-- VIDEO: "Event Horizon.mp4" (same overview clip, optional second placement). Remove this block if the hero clip above is enough. -->

### 2. 🔀 One ticket → one branch → one PR

Starting a task spins up a dedicated `flux/<id>-<slug>` branch in an isolated worktree. When you're
done reviewing, `finish` pushes the branch and opens the PR for you — the PR URL is recorded back on
the ticket as its implementation link. No manual branch juggling, no checkout dance on your main tree.

<img width="580" height="530" alt="image" src="https://github.com/user-attachments/assets/e1a72575-2756-441b-bdd9-64d6690c3419" />


> [](https://github.com/user-attachments/assets/66b1a908-5410-458e-8593-7673c5ebd09c)



### 3. 🙋 Answer the agent inline

When an agent needs a decision it moves the ticket to **Require Input** and posts one focused question
with proposed defaults. You answer right in the portal — no separate chat window — and the agent picks
up exactly where it left off.


> [](https://github.com/user-attachments/assets/26782532-622e-45ca-b023-023856bdd640)

### 4. 🧩 Phase-aware workflows + a visual workflow editor

Workflows are phase-aware — grooming, implementation, review, and finalize each get their own
behavior, and you can scope MCP servers per phase (keep a heavy search server out of grooming, for
example). The built-in workflow editor lets you compose multi-agent patterns (relay, scatter,
supervisor) and customize the skill prompts for each phase — no config files to hand-edit.


> [](https://github.com/user-attachments/assets/b0fd8184-674f-4319-a283-c88347c58fb6)


-------

> [](https://github.com/user-attachments/assets/930466b3-7395-4fed-ae5c-0013b23cf26c)

### 5. 📝 Full markdown, docs and tickets synced off your code history

Ticket bodies and project docs are first-class markdown, edited in-product or in any text editor. Turn
on Git Sync and both move to an orphan `flux-data` branch — versioned, multi-machine, and restored
automatically on clone, yet completely off your main code history.


> [](https://github.com/user-attachments/assets/50a4d5fc-14a3-4f03-841b-4c0f7759af64)

### 6. 🔌 Addon modules + a dedicated MCP for CLI & IDE agents

Agents talk to Event Horizon through an MCP server whose tools appear natively in their tool list —
works the same whether you drive Claude Code, Gemini, or Copilot from the CLI or from your IDE. Addon
modules extend the board with extra capabilities (scoped per phase, with live health probes) without
touching the core.

### 7. ✨ And more

- **Multi-workspace** — manage several projects from one running instance and switch from the header.
- **Global fuzzy search** — jump to any ticket from anywhere.
- **In-product docs tree** — browse and edit `.docs/` without leaving the portal.
- **Schema-validated tickets** — invalid frontmatter surfaces as a visible error, never silent corruption.
- **Append-only history** — every status change, comment, and agent session is recorded on the ticket.

---

## Core Principles

- **Filesystem as Database:** Tickets are plain Markdown files with YAML frontmatter in `.flux/`. Version-controlled alongside your code. Editable in any text editor.
- **MCP-First Agent Integration:** Agents interact through MCP tools that appear directly in their tool list — no curl, no REST wrappers. The MCP server enforces workflow rules, validates schemas, and broadcasts real-time updates to the portal.
- **Agent-First & Human-Friendly:** The file format is instantly parseable by LLMs while remaining readable and editable by humans. Agents and humans use the same surface.
- **Zero Latency:** No cloud APIs. The UI reacts at the speed of your local disk.
- **Flexible Storage:** Tickets live in-repo by default. Enable Git Sync to move them to an orphan branch — keeping ticket history off your main branch while retaining full git-native sync across machines.
- **Multi-Workspace:** Manage multiple projects from a single running instance. Switch workspaces from the header dropdown — active agent sessions are guarded against accidental switches.

---

## Architecture

```
Event Horizon
├── engine/           Node.js/TypeScript — REST API + MCP server (stdio)
├── portal/           React + Vite + Tailwind v4 — board, backlog, docs, settings
├── global settings   %APPDATA%/EventHorizon (Win) | ~/Library/Application Support (Mac) | ~/.config (Linux)
└── data layer
    ├── .flux/        Board config, workflow skills, tickets (default mode)
    └── .flux-store/  Git worktree on orphan branch (Git Sync mode)
```

The binary embeds the engine and portal into a single executable. No Node.js required for end users.

---

## Quick Start

1. **Download & Run** the binary from the [releases page](../../releases).
2. **Connect** — browser opens at `http://localhost:3067`.
3. **First Boot** — a one-time dialog shows your global data directory and migrates any legacy settings.
4. **Select Workspace** — browse to your project folder. New folders are auto-bootstrapped with config, docs, and agent skills.

The service runs as a system tray application. Closing the browser does not stop the engine.

> **Windows users — if Defender flags the exe:** see [Windows Defender false positive](#windows-defender-false-positive) below.

---


## Run from source (Windows)

If you want to avoid the binary entirely, the source distribution on the [releases page](../../releases) (`event-horizon-source.zip`) contains everything you need. Node.js 20+ required.

```bash
# 1. Download and extract event-horizon-source.zip, then:
cd event-horizon

# 2. Install dependencies
npm install

# 3. Build (portal + engine)
npm run build

# 4. Start the engine (opens browser automatically)
node engine/dist/index.js --workspace /path/to/your/project
```

The engine serves the portal at `http://localhost:3067`. Set `PORT=<n>` to override the port.

---

## MCP Server — How Agents Connect

Event Horizon exposes ticket operations as **MCP tools**, served in-process over loopback HTTP by the running engine (with a headless stdio fallback). When the workflow installer runs, it writes an MCP config file into your project so agents discover the tools automatically.

### Available Tools

| Tool | Purpose |
|------|---------|
| `get_ticket` | Read ticket (frontmatter + body + history) |
| `list_tickets` | Filter by status, assignee, tag, priority |
| `get_board_config` | Read board config (statuses, tags, project key) |
| `create_ticket` | Create a new ticket |
| `create_subtask` | Create child ticket linked to parent |
| `update_ticket` | Update metadata (title, priority, effort, tags, body) |
| `change_status` | Move to new status (enforces comment on Require Input / Ready) |
| `add_comment` | Append comment to history |
| `log_progress` | Log progress activity |
| `finish_ticket` | Atomic: set implementationLink + completion comment + Done |

### MCP Config (auto-generated)

```json
{
  "mcpServers": {
    "event-horizon": {
      "type": "http",
      "url": "http://127.0.0.1:3067/mcp",
      "alwaysLoad": true
    }
  }
}
```

The installer renders this in-process HTTP entry (FLUX-645) so every session shares the running engine's task-store; the URL's port tracks the engine. Config is placed at the framework-appropriate path (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, etc.) during skill installation.

### Relationship to REST API

The MCP tools and REST API coexist. **MCP is the primary path for agents** — tools appear natively and enforce workflow rules. The REST API (`localhost:3067/api/`) serves the portal and acts as a fallback. Both share the same in-memory state.

---

## Agent Workflow

Event Horizon drives an autonomous loop: agents work forward through tickets, surfacing decisions only when they need human input. The portal is the command center — no chat window required for most of the lifecycle.

### Ticket Lifecycle

1. **Grooming** — Agent reads the ticket, fills metadata, rewrites body as a concrete plan.
2. **Require Input** — Agent posts one focused question with proposed defaults. You answer in the portal.
3. **In Progress** — Agent implements. Progress logged to ticket history in real time.
4. **Ready** — Code complete, uncommitted. You review the diff from the ticket modal.
5. **Done** — `finish <ticket>` commits atomically and records the link.

### Supported Frameworks

| Framework | CLI | Skill Install Path |
|-----------|-----|-------------------|
| Claude Code | `claude` | `.claude/rules/event-horizon.md` |
| GitHub Copilot | `github-copilot-cli` | `.github/skills/event-horizon/` |
| Gemini CLI | `gemini` | `.gemini/skills/event-horizon.md` |
| Cursor | WIP | `.cursor/rules/event-horizon.mdc` |
| Windsurf | WIP | `.windsurf/rules/event-horizon.md` |
| Cline | WIP | `.cline/skills/event-horizon-*.md` |

Install via **Settings → Agent Integration → Install Agent Workflow**, or:

```bash
npx event-horizon install-skill --target /path/to/project
```

The installer writes both the workflow skill files and the MCP config for the detected framework.

---

## Multi-Workspace

- **Header dropdown** — shows active workspace, click to switch instantly.
- **Settings → Workspace** — add, remove, rename workspaces. Folder picker included.
- **Auto-registration** — opening a new folder adds it to the list.
- **Project bootstrapping** — new workspaces get a config derived from folder name, default user, and agent skills pre-installed.
- **Session guard** — switching while agents are running triggers a confirmation to stop them first.

---

## Git Sync

Move tickets to an orphan branch so they never touch your code history:

1. Creates `flux-data` orphan branch (no ancestry with `main`)
2. Moves tickets to `.flux-store/` worktree pointing to that branch
3. Auto-commits and pushes on a debounced schedule (30s silence, 5min max)

Enable in **Settings → Git Sync**. Fully reversible. Multi-machine restore is automatic on `git clone`.

---

## Config Reference

### Global Settings

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%/EventHorizon/settings.json` |
| macOS | `~/Library/Application Support/EventHorizon/settings.json` |
| Linux | `~/.config/event-horizon/settings.json` |

Fields: `workspaces[]`, `lastWorkspace`, `theme`, `defaultUser`, `preferredFramework`, `port`, `boardClickBehavior`, `animations`, `timeouts`.

### Project Config (`.flux/config.json`)

| Field | Description |
|-------|-------------|
| `columns` | Board columns (`name`, optional `color`) |
| `hiddenStatuses` | Statuses hidden from board but tracked in system |
| `projects` | Project key prefixes (e.g. `["MYAPP"]`) |
| `users` | Known users and agents |
| `tags` | Tag definitions with colors |
| `priorities` | Priority levels with icons and colors |
| `defaultAgent` | Agent framework for sessions (`claude`, `gemini`, `copilot`) |
| `effortLevel` | Global effort level (`low`, `medium`, `high`, `xhigh`, `max`) |
| `syncSettings.debounceMs` | Git Sync commit delay after last write |
| `syncSettings.maxWaitMs` | Git Sync forced commit ceiling |

---

## Ticket Format

Tickets are `.md` files with YAML frontmatter:

```yaml
---
title: "Add dark mode toggle"
status: Done
priority: High
effort: M
assignee: unassigned
tags: [feature, ui]
implementationLink: a488a47
history:
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-07T09:20:00.000Z'
---

Implement a dark mode toggle that persists user preference via local storage.
```

History is append-only. Schema-validated on load — invalid frontmatter surfaces as a visible error, never silent corruption.

---

## Documentation

In-product docs tree at `.docs/`, served through the portal's **Docs** screen:

- [Project Overview](.docs/event-horizon/project-overview.md)
- [Architecture](.docs/event-horizon/architecture/overview.md)
- [MCP Server](.docs/event-horizon/mcp-server.md)
- [Agent Integrations](.docs/event-horizon/agent-integrations.md)
- [Installation & Setup](.docs/event-horizon/installation.md)
- [Configuration](.docs/event-horizon/configuration.md)
- [Ticket Lifecycle](.docs/event-horizon/workflow/ticket-lifecycle.md)

---

## Development Setup

```bash
# Engine (API + MCP server)
cd engine && npm install && npm run dev

# Portal (hot reload)
cd portal && npm install && npm run dev
```

Engine: `http://localhost:3067` — Portal dev: `http://localhost:5167` (proxies API).

### Production Build

```bash
npm run build          # Portal (Vite) + Engine (esbuild)
npm run package:win    # Windows executable
npm run package:mac    # macOS executable
```

---

## Utilities

### patch-ticket CLI

```bash
npm run patch-ticket -- FLUX-42 --status "In Progress"
npm run patch-ticket -- FLUX-42 --comment "implementation complete"
npx tsx engine/src/patch-ticket.ts FLUX-42 --workspace . --status "Done"
```

Works in both in-repo and Git Sync modes.

### seed-demo CLI

Regenerate the bundled [`demo/`](demo) showcase workspace (the **Trailhead** board used for the
showcase recordings):

```bash
npx tsx engine/src/seed-demo.ts          # writes ./demo/.flux
npx tsx engine/src/seed-demo.ts --out path/to/dir
```

It validates every seeded ticket against the engine schema before writing, so the demo board stays
schema-valid as the format evolves. See [`docs/media/RECORDING.md`](docs/media/RECORDING.md) for how
the demo board feeds the showcase recordings.
