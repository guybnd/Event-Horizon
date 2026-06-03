---
priority: Medium
effort: XS
tags:
  - docs
  - documentation
assignee: unassigned
title: 'Docs: restructure — decisions folder + INDEX by subsystem (Phase A)'
status: In Progress
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:36.652Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-06-03T03:50:50.165Z'
  - type: comment
    comment: >-
      Starting Phase A: create decisions/ folder, move two ADR-style docs into
      it, rewrite INDEX.md by subsystem, rename repository-map.md to
      code-map.md.
    user: Agent
    date: '2026-06-03T03:50:50.165Z'
    id: c-2026-06-03t03-50-50-165z
author: Agent
---
## Problem

`.docs/event-horizon/architecture/decoupled-storage.md` (375 lines) and `.docs/event-horizon/multi-agent-cli-research.md` (406 lines) are decision/research documents mixed in with reference architecture pages. Agents reading INDEX.md cannot tell what is authoritative current behavior vs historical reasoning. INDEX.md is also organized by loose topic rather than by subsystem.

## Plan

- Create `.docs/event-horizon/decisions/` with a `README.md` explaining ADR conventions.
- Move `architecture/decoupled-storage.md` → `decisions/0001-storage-modes.md`.
- Move `multi-agent-cli-research.md` → `decisions/0002-multi-agent-cli.md`.
- Add a note at the top of each: "Historical reasoning — skip for ticket work. See [current reference]."
- Rewrite `INDEX.md` as a subsystem table: Subsystem · Code entry points · Reference doc · Decision docs.
- Rename `architecture/repository-map.md` → `architecture/code-map.md` and restructure as a table (file → owns → don't-touch boundary).

Acceptance: an agent landing on INDEX.md can pick exactly one reference page per subsystem.
