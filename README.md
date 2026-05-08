# 🌌 Event Horizon

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: MVP](https://img.shields.io/badge/Status-MVP-blue.svg)]()

> A local-first, agent-centric management layer designed to serve as the central nervous system for solo developers and teams building alongside AI and LLM coding agents.

Event Horizon replaces traditional cloud-based ticketing with a high-performance, **filesystem-based integration pool**. By storing all state in the repository, you clone the entire management system right along with your code.

---

## ✨ Core Principles

* **🗂️ Filesystem as Database:** All state lives locally in the repository. Version control your management system just like your source code.
* **🤖 Agent-First & Human-Friendly:** Data structures (Markdown + YAML Frontmatter) are instantly parseable by LLMs while remaining effortlessly editable in tools like Obsidian or VS Code.
* **⚡ Zero Latency:** No cloud APIs. The UI reacts at the exact speed of your local disk.
* **📐 Schema Flexibility:** You dictate the structure and schema of your project via standard Markdown.

---

## 🏗️ Architecture

The project is split into three main areas:

* **Engine (`/engine`):** A local Node.js/TypeScript backend that watches files, manages state, and exposes a flexible local REST API. *(Future: Model Context Protocol (MCP) server support).*
* **Portal (`/portal`):** A lightning-fast, reactive Web UI built with **Vite, React, and Tailwind CSS v4**.
* **Data Layer (`.flux/`):** A directory inside the root repository acting as the persistent store containing ticket files.

---

## � Install in Your Project

Use Event Horizon as a local project management layer inside any Git repository.

### Prerequisites

* **Node.js ≥ 18** and **npm ≥ 9**
* A Git repository (or any directory) to manage

### 1. Clone or download the Event Horizon engine

```bash
git clone https://github.com/your-org/event-horizon.git
cd event-horizon
npm install
```

### 2. Initialise your project workspace

```bash
npm run init -- --target /path/to/your-project --key MYAPP
```

This creates `.flux/` (config + ticket store) and `.docs/` inside your project directory.

> **Tip:** If you run the command from inside your project directory, omit `--target`:
> ```bash
> cd /path/to/your-project
> npm run init -w engine -- --key MYAPP
> ```

### 3. Start the engine, pointing it at your project

```bash
cd /path/to/event-horizon/engine
npm run dev -- --workspace /path/to/your-project
```

### 4. Open the portal

Navigate to **http://localhost:3001** — the portal is served directly from the engine.

### 5. Create your first ticket

Click **+ New ticket** on the board and start planning.

---

## ⚙️ Config Reference (`config.json`)

The `.flux/config.json` file controls the board layout and behaviour:

| Field | Description |
|-------|-------------|
| `columns` | Board columns shown on the Kanban view (each has a `name` and optional `color`) |
| `hiddenStatuses` | Statuses tracked in the system but hidden from the main board |
| `projects` | Array of project key strings (e.g. `["MYAPP"]`) — determines ticket ID prefixes |
| `users` | List of known users (`{ name: "Alice" }`) |
| `tags` | Tag definitions with optional colors |
| `priorities` | Priority levels with icons and colors |
| `enableBacklogScreen` | `true` to show the Backlog nav item |
| `requireInputStatus` | Status name agents use when they need clarification (default `"Require Input"`) |
| `readyForMergeStatus` | Status name for the pre-merge review checkpoint (default `"Ready"`) |
| `boardCardOpenMode` | `"full"` opens ticket in full view on card click; `"preview"` opens sidebar preview |
| `animationsEnabled` | Toggle UI animations |

---

## 🚀 Getting Started (Development / Contributor Mode)

To run the full stack during development, you will need two terminal windows:

### 1. Start the Backend Engine
```bash
cd engine
npm install
npm run dev
```
> The Engine runs on `http://localhost:3001` and auto-reloads on source changes.
> The portal is also served from this port when `portal/dist/` exists.

### 2. Start the Frontend Portal (dev mode with hot reload)
```bash
cd portal
npm install
npm run dev
```
> The Portal dev server runs on `http://localhost:5173` and proxies `/api` calls to the engine.

---

## 🏗️ Production Build

```bash
npm run build          # Build portal (Vite) + engine (esbuild bundle)
npm run package:win    # Package into a Windows standalone binary
npm run package:mac    # Package into a macOS standalone binary
```

The packaged binary serves both the API and portal from a single process.
Place the binary alongside a `portal/dist/` directory (relative path).

---

## 📚 Project Documentation

Event Horizon ships with a repo-backed documentation tree under `.docs/` which is natively served through the Portal's interactive **Docs screen**. Core materials include:

* 🧭 **[project-overview](.docs/project-overview.md):** High-level system shape and shipped capabilities.
* 🔩 **[architecture/overview](.docs/architecture/overview.md):** Runtime logic and storage models.
* 📝 **[architecture/docs-workspace](.docs/architecture/docs-workspace.md):** How the docs tree, live editor, and permissions function.
* 🗺️ **[architecture/repository-map](.docs/architecture/repository-map.md):** Visual map to key codebase surfaces.
* 🔄 **[workflow/ticket-lifecycle](.docs/workflow/ticket-lifecycle.md):** Status model and rigid agent execution rules.
* 🔌 **[workflow/workflow-install](.docs/workflow/workflow-install.md):** Installation of skills and always-on instructions.

> **Note for Contributors & Agents:** When shipped behavior changes, update the nearest durable `.docs/` markdown page instead of leaving context buried in a ticket's history.

---

## 🤖 Agent Workflow & Instructions

Event Horizon provides powerful Copilot-facing assets explicitly tailored for agentic capabilities:

1. **Workspace Skill:** `.flux/skills/event-horizon-agent.md`
2. **Copilot Instructions:** `.flux/skills/event-horizon-copilot-instructions.md`

### Installing the Workflows
Installing the workflow patches these templates directly into the target `.github/` directory natively supported by GitHub Copilot (`.github/skills/event-horizon/SKILL.md` & `.github/copilot-instructions.md`).

You can install or refresh the workflow in two ways:
* **Via Portal:** Navigate to the **Settings** screen in the Portal and click `Install Workflow`.
* **Via CLI:** Run `npm.cmd run install-skill -- --target c:\GitHub\EventHorizon --framework copilot`.

*(The installer makes sure to only patch designated Event Horizon instruction blocks, preserving your unrelated custom instructions).*

### Example Agent Workflow
Event Horizon shines when acting as an asynchronous handoff medium between you and your AI agent. Here is an example of an end-to-step lifecycle:

1. **Creation:** You swiftly drop a ticket onto the board (e.g., `FLUX-42: Add dark mode`) and place it in the **Grooming** column.
2. **Planning (Grooming):** You instruct your agent in chat: *"Please groom FLUX-42."* 
   - The agent reads the ticket, fleshes out the requirements, deduces effort/priority, and identifies a missing requirement.
3. **Prompting (Require Input):** Because the agent needs clarification (e.g., *"Should we use standard slate or a custom hex?"*), it modifies the ticket's history with the question and moves its status to **Require Input**.
4. **Answering:** You see the ticket flagged on your board. You drop a comment on the ticket in the UI answering, *"Use Tailwind's slate colors"*. The portal automatically moves it into **Todo** or **In Progress**.
5. **Implementation:** The agent writes the code, referencing the verified requirements.
6. **Review (Ready):** Once the code is complete, the agent leaves the files unstaged and moves the ticket to **Ready**.
7. **Finish:** You review the changes locally. If everything looks good, you type *"finish FLUX-42"* in chat. The agent automatically commits the code, updates the ticket with the commit hash, and moves it safely to **Done**.

---

## 📝 The Data Schema 

Tickets are stored natively as `.md` files within the `.flux/` directory using comprehensive YAML frontmatter. This allows both the portal and autonomous agents to easily query, track history, and trace implementation details.

**Example `FLUX-42.md`:**
```yaml
---
title: "Feature: Add dark mode toggle"
status: Done
createdBy: User
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - ui
priority: High
effort: M
implementationLink: a488a47f1234567890abcdef
subtasks: []
history:
  - type: activity
    user: User
    date: '2026-05-07T09:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T09:10:00.000Z'
    comment: Moved to Require Input. Do we want to use standard slate or a custom hex?
  - type: comment
    user: User
    date: '2026-05-07T09:15:00.000Z'
    comment: Let's use Tailwind's standard slate colors.
  - type: activity
    user: Agent
    date: '2026-05-07T09:40:00.000Z'
    comment: >-
      Completed ticket. Implemented slate dark mode via Tailwind and updated the header UI. 
      Committed in a488a47.
order: 42
---

# Objective
Implement a dark mode toggle in the application's header that persists user preference via local storage.

# Tasks
- [x] Add Dark/Light toggle icon to Header
- [x] Wire up context provider for theme persistence
- [x] Test layout with slate color palette
```
