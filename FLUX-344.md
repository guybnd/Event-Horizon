---
priority: Medium
effort: L
tags:
  - research
  - architecture
  - engine
assignee: unassigned
id: FLUX-344
title: 'Engine: evaluate splitting ticket history from frontmatter'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:28.392Z'
    comment: Created ticket.
---
## Problem

History is an append-only array stored inside the same YAML frontmatter as ticket metadata. Every comment rewrites the entire ticket file, file size grows unboundedly, a single malformed history entry can break the whole ticket parse, and git diffs on comments show walls of YAML — partially defeating the "readable in any editor" promise.

## Plan

Spike, not implementation. Compare:

1. Keep current model (status quo, document the tradeoff).
2. Sidecar `.flux/FLUX-42.history.jsonl` — append-only, body stays in `.md`.
3. SQLite sidecar for history only (`.flux/history.db`), markdown body unchanged.
4. Full SQLite (covered in existing decoupled-storage spike, link from here).

Output: ADR in `.docs/event-horizon/decisions/` recommending one option, with migration sketch and impact on the "open in any editor" promise.
