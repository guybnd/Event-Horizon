# Event Horizon

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org/)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange.svg)](LICENSE)
[![Status: 1.0](https://img.shields.io/badge/Status-1.0-brightgreen.svg)]()

### An IDE for the agent era.

https://github.com/user-attachments/assets/6a266cd2-b145-47b7-8eb2-aefeb9108b47

You still live in your editor — but more and more of the work gets handed to agents, and your editor was never built to *run* them. Event Horizon is the environment for that side of the job: break work into tickets, dispatch agents that each carry full context and run on their **own branch, in parallel**, and review everything as a **real pull request** before it lands. It runs alongside your IDE and terminal, and every change comes back as a normal git branch — your repo stays the source of truth.

Not a chat bolted onto your editor — the command surface for directing agents and reviewing what they ship: **plan → dispatch → review → ship**, on a board you own, all in your repo.

---

<a id="Quick Look"></a>

## Why Event Horizon?

### Every ticket is a living agent chat

Open a ticket and the agent is already briefed — description, history, branch, and attachments are in context, so you never re-explain. Minimize it to the dock and it keeps working in the background while you move on.

https://github.com/user-attachments/assets/2ce3e8f7-97b2-4c15-ae9a-925068bf48fb

### Run agents in parallel — safely

Each ticket gets its own git worktree on its own branch, so three agents can build three things at once with **zero file collisions**. Watch every session run live on the board.

https://github.com/user-attachments/assets/f09f2668-edab-4179-a394-a7098fddbde7

### Orchestrate, don't micromanage

Hand a ticket to a specialist persona, or fan the work out **scatter-gather** under a supervisor that reviews and synthesizes the results. Or talk to the **board orchestrator** about the whole project — it triages, breaks big asks into tickets, and dispatches the right agent to each.

https://github.com/user-attachments/assets/8ef35453-ac1a-4699-b52d-a4d7596fbf98

### Ship through real pull requests

Move a ticket to **Ready** and its branch is pushed and a PR opened automatically. Review the diff on GitHub, then `finish` squash-merges it and advances the ticket to **Done** — no terminal, no manual git dance.

https://github.com/user-attachments/assets/94aa932d-d288-46bd-bdc3-49f27aebec0d

### Design your own workflows

Pick an orchestration shape and build agent personas tuned to your product and process — then reuse them across the board.

https://github.com/user-attachments/assets/11a9fcaa-aee2-4c04-90bf-ad311decda4d

### Your board, in markdown, forever

Tickets are markdown files with YAML frontmatter, committed to your repo (or a dedicated data branch). They version alongside your code, work offline, render right in the portal's **Docs** screen, and never get trapped in someone else's database. Switch machines and your whole board comes with a `git clone`.

https://github.com/user-attachments/assets/c2a4cc93-4fd4-42ec-bd10-2929a69b6245

**And there's more:** multi-repo groups that map a feature across repositories and share one knowledge base · board-driven release notes auto-generated from your Done tickets · multi-workspace switching from one running instance. etc.


## What makes it different

Your IDE is still where you read code, debug, and make the precise edits you want by hand — keep it. What it was never built for is **running a team of agents**: several tasks at once, each needing context, each producing a diff someone has to review before it's safe to land. Bolt an agent chat onto an editor and you get one assistant, a couple of tasks, in a log that disappears. Event Horizon is built for that other half of the job — the agent-era IDE that sits alongside the editor you already use and hands everything back as standard git.

| Running agents from your editor today | With Event Horizon |
|---|---|
| One agent in a side panel, one task at a time | A **board of agents**, many tasks in parallel |
| A bland chat window — status and progress buried in the scroll | A **rich UI** shows everything at a glance: status columns, live agent progress, review state, actionble items and more |
| Re-explain the context on every new chat, get lost in your history | Each **ticket carries its full context** |
| Context window fills and the thread is lost | **Durable ticket history** — any agent or teammate resumes with full context |
| Watch it run; close the tab and the work is gone | Minimize to the dock — agents **run in the background** and ping you only when they need a call |
| Parallel agents collide in one working tree and pull the rug under each other | Each ticket runs in its **own git worktree + branch** |
| It blocks on a prompt mid-run, or quietly guesses | **Require Input** — a focused question with a sensible default, answered when *you're* ready |
| The diff lands in your files — catching problems is on you | **Ready → real PR →** review the diff → `finish` merges |
| One tool's agent for every task | Assign, customize and create the **agent, persona, and effort per ticket** |
| One repo, one window | **Multi-repo groups** — orchestrate, document and map a feature across repositories |
| Decisions vanish into disposable chat logs | Plans + history are **markdown committed to your repo** |
| Sessions live in a vendor's cloud | **Local-first** — travels with a `git clone` |

> **You bring the agent; Event Horizon is the environment around it.** It orchestrates a CLI you already use — **Claude Code, Gemini CLI, or GitHub Copilot CLI** — or a supported IDE (Cursor, Windsurf, Cline). It ships no LLM and needs no key of its own. Keep your editor, terminal, and debugger exactly as they are: every change still arrives as a normal **git branch + PR** you can pull into your own tools — Event Horizon just adds the board where agents do the building and you stay in command.

---



---

## Install

**Prerequisite — your agent.** Event Horizon orchestrates an agent CLI you install separately: [Claude Code](https://www.anthropic.com/claude-code), Gemini CLI, or GitHub Copilot CLI (or drive it from Cursor / Windsurf / Cline). Have at least one set up with its own credentials before you start.

### Option 1 — Download the app (recommended, zero dependencies)

Grab a build from the **[releases page](../../releases)** — no Node, no build step. It runs a local service and opens your board at `http://localhost:3067`.

- **Desktop app** — `.dmg` (macOS) / `.exe` (Windows): Event Horizon in its own window with a taskbar/dock entry.
- **Tray binary** — a single executable that runs in the system tray; closing the browser tab doesn't stop it.
- *First launch:* the builds are **unsigned**, so macOS Gatekeeper or Windows Defender may warn — it's a false positive, see [Troubleshooting](#first-run-troubleshooting).

### Option 2 — Run from source (Node 20+)

```bash
# download & extract event-horizon-source.zip from the releases page, then:
npm install
npm run build                               # portal (Vite) + engine (esbuild)
node engine/dist/index.js --workspace <path-to-your-project>
```

### Then: open a folder

Point Event Horizon at a project folder. New folders are **auto-bootstrapped** — board config, docs, and the agent skill + MCP config are written in, so your agent discovers the board automatically. Create a ticket, hand it to an agent, and you're running.

---

## Your first five minutes

1. **Open the app** → it lands at `http://localhost:3067` and asks for a project folder.
2. **Pick your repo** → Event Horizon bootstraps it (config + docs + agent skill installed).
3. **Create a ticket** — a one-line ask is enough ("add a dark-mode toggle").
4. **Hand it to an agent** — it grooms the ticket into a plan, asks you anything blocking via **Require Input**, then implements on its own branch.
5. **Review & ship** — when it hits **Ready**, a PR is open; review the diff and `finish` to merge.

> New to the board? Hit **"Bootstrap with AI"** on an empty board and an agent scans your repo and proposes a starter set of tickets.

---

## Works with your agent

Event Horizon installs a workflow skill + MCP config for your framework so the agent picks up tickets natively — no curl, no REST wrappers.

| Framework | CLI | Skill install path |
|-----------|-----|--------------------|
| Claude Code | `claude` | `.claude/rules/event-horizon.md` |
| GitHub Copilot | `github-copilot-cli` | `.github/skills/event-horizon/` |
| Gemini CLI | `gemini` | `.gemini/skills/event-horizon.md` |
| Cursor | (IDE) | `.cursor/rules/event-horizon.mdc` |
| Windsurf | (IDE) | `.windsurf/rules/event-horizon.md` |
| Cline | (IDE) | `.cline/skills/event-horizon-*.md` |
| Generic | — | `.event-horizon/skills/event-horizon.md` |

Install from **Settings → Agents → Install**, or `npx event-horizon install-skill --target /path/to/project`.

Under the hood, ticket operations are exposed as **MCP tools** served in-process over loopback HTTP (`http://127.0.0.1:3067/mcp`) by the running engine. The tools enforce workflow rules, validate schemas, and broadcast realtime updates to the portal. See [MCP Server](#mcp-server--how-agents-connect) for the full tool list.

---

## Core Principles

- **Filesystem as database** — tickets are plain Markdown + YAML frontmatter in `.flux/`, version-controlled with your code, editable in any text editor.
- **MCP-first** — agents act through MCP tools that appear directly in their tool list; the server enforces the workflow and validates every write.
- **Agent-first & human-friendly** — the same surface is instantly parseable by an LLM and readable by you.
- **Zero latency** — no cloud APIs; the UI reacts at the speed of your local disk.
- **Yours** — local-first by default; nothing leaves your machine unless you turn on Git Sync.

---

## Why agents succeed here — governed shared memory

In a single repo your "multi-agent shared memory" is really *many agent sessions, separated in time, reading and writing the same ticket history*. Event Horizon **governs** that memory so each new session inherits a clean, trustworthy state instead of raw noise — that's why agents don't drift, repeat discarded work, or lose your instructions.

- **Provenance** — history is append-only and attributed (`user`/`date`, human vs agent); nothing is silently rewritten, so an agent can always see *who decided what, and when*.
- **Authority over recency** — pinned entries and your own comments are re-surfaced even after they age out of the recent window, so human instructions never get buried under a pile of agent chatter.
- **Relevance windowing** — each session's noise is compacted to summaries with on-demand `expand`, so a new agent reads *signal*, not thousands of lines of prior tool output — and stays inside a useful context window.
- **Temporal supersession** — when a decision is replaced, the dead one collapses to a marker, so an agent reads the *live* decision state instead of reconciling abandoned plans by hand.

The payoff: **governed shared memory → less context drift, fewer repeated or contradictory decisions, human intent preserved → a higher agent success rate.**

---

## Architecture

```
Event Horizon
├── engine/           Node.js/TypeScript — REST API + in-process MCP server (loopback HTTP, stdio fallback)
├── portal/           React + Vite + Tailwind v4 — board, backlog, docs, settings
├── electron/         Opt-in desktop shell (own window + tray) — standalone, not in the main install
├── global settings   %APPDATA%/EventHorizon (Win) | ~/Library/Application Support (Mac) | ~/.config (Linux)
└── data layer
    ├── .flux/        Board config, workflow skills, tickets (default mode)
    └── .flux-store/  Git worktree on an orphan branch (Git Sync mode)
```

The downloadable binary embeds the engine and portal into a single executable — **no Node.js required for end users**.

---

## MCP Server — How Agents Connect

Ticket operations are exposed as **MCP tools**, served in-process over loopback HTTP by the running engine (headless stdio fallback). The workflow installer writes the MCP config into your project so agents discover the tools automatically.

| Tool | Purpose |
|------|---------|
| `get_ticket` | Read ticket (frontmatter + body + history) |
| `list_tickets` | Filter by status, assignee, tag, priority |
| `get_board_config` | Read board config (statuses, tags, project key) |
| `create_ticket` | Create a new ticket |
| `create_subtask` | Create a child ticket linked to a parent |
| `update_ticket` | Update metadata (title, priority, effort, tags, body) |
| `change_status` | Move to a new status (enforces a comment on Require Input / Ready) |
| `add_comment` | Append a comment to history |
| `log_progress` | Log progress activity |
| `finish_ticket` | Atomic: set implementationLink + completion comment + Done |

Config is placed at the framework-appropriate path (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, …) during skill installation. The MCP tools and the REST API (`localhost:3067/api/`) share the same in-memory state — MCP is the primary path for agents; REST serves the portal and acts as a fallback.

---

## Multi-Workspace

Manage multiple projects from one running instance. Switch from the **header dropdown**; add/remove/rename under **Settings → Workspace**. Opening a new folder auto-registers and bootstraps it. Switching while agents are running prompts you to stop them first.

---

## Git Sync

Move tickets onto an orphan branch so they never touch your code history:

1. Creates a `flux-data` orphan branch (no ancestry with `main`).
2. Moves tickets to a `.flux-store/` worktree on that branch.
3. Auto-commits and pushes on a debounced schedule (30s of silence, 5min max).

Enable in **Settings → Workspace → Git Sync**. Fully reversible; multi-machine restore is automatic on `git clone`.

---

## Ticket Format

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

History is append-only and schema-validated on load — invalid frontmatter surfaces as a visible error, never silent corruption.

---

## Desktop app (Electron, opt-in)

Prefer a real app window over a browser tab? Prebuilt **`.dmg`/`.exe`** installers ship on every [release](../../releases), or build your own from the standalone [`electron/`](electron/) package (it's **not** part of the main install, so the normal setup never downloads Electron):

```bash
npm run dev                               # engine + vite
cd electron && npm install && npm start   # or, from the root: npm run electron
```

---

## First-run troubleshooting

**macOS** — the build is **Apple Silicon (arm64)** and unsigned; on an Intel Mac, run from source. Clear the Gatekeeper quarantine with `xattr -d com.apple.quarantine /path/to/event-horizon`, or right-click → **Open** → **Open Anyway**.

**Windows** — the unsigned binary may trip a Defender false positive (e.g. `Trojan:Script/Wacatac`); the desktop app may flag a cached JS file (`VirTool:JS/Anomelesz.A`). Both are false positives from unsigned packaging — run from source, allow the file, or report it at <https://www.microsoft.com/wdsi/filesubmission>. Set `PORT=<n>` to change the port.

---

## Development & docs

```bash
cd engine && npm install && npm run dev    # API + MCP  → http://localhost:3067
cd portal && npm install && npm run dev    # hot reload → http://localhost:5167 (proxies API)
```

In-product docs live at `.docs/` and render in the portal's **Docs** screen — [Project Overview](.docs/event-horizon/project-overview.md) · [Architecture](.docs/event-horizon/architecture/overview.md) · [MCP Server](.docs/event-horizon/mcp-server.md) · [Agent Integrations](.docs/event-horizon/agent-integrations.md) · [Installation](.docs/event-horizon/installation.md) · [Configuration](.docs/event-horizon/configuration.md) · [Ticket Lifecycle](.docs/event-horizon/workflow/ticket-lifecycle.md).

---

## License

Event Horizon is **source-available**, not open-source, under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- ✅ **Free** for personal, hobby, academic, and other **non-commercial** use — use, modify, and share.
- 💼 **Commercial use requires a paid license** — contact **guylivingroom@gmail.com**.

Copyright remains with the author. Bundled third-party components keep their own permissive licenses — see [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt).
