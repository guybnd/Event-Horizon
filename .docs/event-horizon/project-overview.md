---
title: Project Overview
order: 1
---

# Event Horizon

Event Horizon is a local-first project operating layer for human and agent work.
The repository is the system of record: tickets, documentation, workflow
instructions, and the product code all live together in version control.

## Distribution Model

Event Horizon is primarily distributed as a standalone binary application (Windows, macOS, Linux). It embeds the entire engine, portal UI, and agent workflow configurations. End-users simply double-click the executable to start the local service and manage their projects via their browser, without needing Node.js or the CLI. See the [Installation & Setup](installation) guide for details.

## Core pieces

- `.flux/` stores ticket files, board config, and the source workflow assets.
- `.docs/` stores the in-product documentation tree served by the engine and
  edited from the portal.
- `engine/` runs the local API that reads, writes, and watches the repo-backed
  task and docs state.
- `portal/` provides the board, backlog, docs, and settings experience.

## Shipped workflow model

- Tickets move through grooming, active work, user-input, review, and done
  states using repo-backed markdown files as the source of truth.
- Documentation is part of the workflow, not an afterthought: agents should
  read the relevant docs before editing and refresh them when shipped behavior
  changes.
- Copilot-facing workflow guidance is split between a reusable skill source and
  an always-on instructions template that can be installed into target repos.

## Current capabilities worth knowing

- File-backed ticket board with configurable statuses, column order, tags,
  priorities, effort sizing, subtask hierarchy, and workflow prompt stages.
- Three-framework agent integration: Claude Code, Gemini CLI, and Copilot CLI —
  all launchable from ticket cards with live progress streaming, token tracking,
  and multi-turn interaction via the portal.
- In-product docs tree backed by `.docs/`, including hierarchy, editing, and
  wiki-oriented navigation.
- Global fuzzy ticket search in the header, with separate compact board and
  backlog controls for local search, sorting, and collapsible metadata
  filters backed by the URL.
- Workflow skill installation for six IDE targets (Copilot, Claude, Gemini,
  Cursor, Windsurf, generic) — keeps both the skill and instructions in
  sync inside a target workspace.
- Activity-aware task history so sorting and audit trails reflect more than
  comments alone.
- Configurable effort levels and per-framework model selection for grooming
  vs implementation tasks.
- Multi-workspace switching via header dropdown and Settings management —
  workspace list, folder picker, add/remove/rename, auto-registration on
  startup.
- Global app settings stored at the platform-conventional path (Windows
  `%APPDATA%`, macOS `~/Library/Application Support`, Linux `~/.config`)
  with first-boot migration from legacy `~/.event-horizon`.
- Agent session guard on workspace switch — confirms and stops active
  sessions before switching to prevent cross-project data confusion.
- Project auto-bootstrapping for new workspaces: derives project key from
  folder name, applies default user from global settings, and installs
  agent skills automatically.

## Recommended reading order

1. [[Architecture Overview]]
2. [[Agent Integrations]]
3. [[Docs Workspace]]
4. [[Code Map]]
5. [[Ticket Model]]
6. [[Ticket Interactions]]
7. [[Ticket Lifecycle]]
8. [[Workflow Install]]

## Related docs

- [[Architecture Overview]]
- [[Docs Workspace]]
- [[Ticket Model]]
- [[Ticket Interactions]]