---
title: Installation & Setup
order: 2
---

# Installation & Setup

This guide explains how to add Event Horizon to an existing project, configure it for your team, and install the agent workflow skill.

---

## Prerequisites

- **Node.js ≥ 18** and **npm ≥ 9**
- A Git repository (or any directory) to track

---

## Step 1 — Get the Event Horizon engine

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-org/event-horizon.git
cd event-horizon
npm install
```

---

## Step 2 — Initialise your project workspace

Run the `init` command, pointing it at the project you want to manage:

```bash
npm run init -- --target /path/to/your-project --key MYAPP
```

| Argument | Description |
|----------|-------------|
| `--target <path>` | Path to the project root. Defaults to the current working directory. |
| `--key <KEY>` | Project key used as a ticket ID prefix (e.g. `MYAPP-1`). Prompted interactively if omitted. |
| `--force` | Re-scaffold an existing workspace (overwrites config, skips docs). |

This creates:
- `.flux/config.json` — board configuration
- `.flux/assets/` — image attachment storage
- `.docs/project-overview.md` — starter documentation page (if `.docs/` doesn't exist)

---

## Step 3 — Start the engine

```bash
cd /path/to/event-horizon/engine
npm run dev -- --workspace /path/to/your-project
```

The engine will:
1. Validate that `.flux/` exists at the workspace path.
2. Watch `.flux/*.md` ticket files and `.docs/**/*.md` for changes.
3. Serve the portal UI from `http://localhost:3001` (if `portal/dist/` is present).

---

## Step 4 — Open the portal

Navigate to **http://localhost:3001** in your browser.  
The board will be empty and ready for your first ticket.

---

## Step 5 — Install the agent workflow (optional)

To enable the GitHub Copilot agent workflow (grooming, implementation, and commit flows):

1. Open **Settings** in the portal header.
2. Go to the **Agent Workflow** tab.
3. Click **Install Workflow**.

This installs skill files into `.github/skills/event-horizon/` and patches `.github/copilot-instructions.md` inside your project.

Alternatively, from the CLI:
```bash
npm run install-skill -- --target /path/to/your-project --framework copilot
```

---

## Config Reference

The `.flux/config.json` file is the single source of truth for board configuration.

| Field | Type | Description |
|-------|------|-------------|
| `columns` | `{ name, color? }[]` | Board columns shown on the Kanban view |
| `hiddenStatuses` | `{ name, color? }[]` | Statuses tracked but hidden from the board |
| `projects` | `string[]` | Project key prefixes for ticket IDs |
| `users` | `{ name }[]` | Known users — shown in assignee dropdowns |
| `tags` | `{ name, color? }[]` | Tag definitions |
| `priorities` | `{ name, icon, color }[]` | Priority levels with Lucide icon names |
| `enableBacklogScreen` | `boolean` | Show the Backlog nav item |
| `requireInputStatus` | `string` | Status name agents use to request clarification |
| `readyForMergeStatus` | `string` | Status name for the pre-merge review checkpoint |
| `boardCardOpenMode` | `"full" \| "preview"` | Default card click behaviour |
| `animationsEnabled` | `boolean` | Toggle board animations |
| `docsRoot` | `string` | Docs directory relative to workspace root (default: `.docs`) |

---

## Multiple Projects

You can manage multiple project keys from a single workspace by adding them all to `projects` in `config.json`:

```json
{
  "projects": ["CORE", "WEB", "OPS"]
}
```

When creating a ticket, choose the appropriate key from the **Project Key** field in the header.

---

## Related Docs

- [Project Overview](event-horizon/project-overview)
- [Architecture Overview](event-horizon/architecture/overview)
- [Ticket Lifecycle](event-horizon/workflow/ticket-lifecycle)
- [Agent Workflow Install](event-horizon/workflow/workflow-install)
