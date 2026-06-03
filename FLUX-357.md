---
priority: Medium
effort: S
tags:
  - docs
  - documentation
assignee: unassigned
id: FLUX-357
title: 'Docs: reference/ticket-schema.md and reference/realtime-channels.md (Phase B)'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:38.380Z'
    comment: Created ticket.
---
## Problem

`engine/src/schema.ts` is the source of truth for valid frontmatter, but no doc enumerates required fields, allowed history entry types per `type`, or status-change rules. The interaction between chokidar watchers, SSE, and portal polling is the most confusing thing in the system to debug and has no doc at all.

## Plan

- Create `.docs/event-horizon/reference/ticket-schema.md`: every frontmatter field (required/optional/type), each history entry type with required keys, status transition rules enforced by MCP.
- Create `.docs/event-horizon/reference/realtime-channels.md`: how chokidar → tasksCache → SSE → portal polling interact, ordering guarantees, debounce behavior, what each channel is responsible for.
- Cross-link from `architecture/overview.md` and INDEX.md.
