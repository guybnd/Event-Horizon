---
title: Project Overview
order: 1
---

# Event Horizon

Event Horizon is a local-first project operating layer for human and agent work.
The repository is the system of record: tickets, documentation, workflow
instructions, and the product code all live together in version control.

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
- In-product docs tree backed by `.docs/`, including hierarchy, editing, and
  wiki-oriented navigation.
- Global fuzzy ticket search in the header, with separate compact board and
  backlog controls for local search, sorting, and collapsible metadata
  filters backed by the URL.
- Workflow installation that keeps both the skill and Copilot instructions in
  sync inside a target workspace.
- Activity-aware task history so sorting and audit trails reflect more than
  comments alone.

## Recommended reading order

1. [[Architecture Overview]]
2. [[Docs Workspace]]
3. [[Repository Map]]
4. [[Ticket Model]]
5. [[Ticket Interactions]]
6. [[Ticket Lifecycle]]
7. [[Workflow Install]]

## Related docs

- [[Architecture Overview]]
- [[Docs Workspace]]
- [[Ticket Model]]
- [[Ticket Interactions]]