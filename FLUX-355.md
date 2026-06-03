---
priority: Medium
effort: XS
tags:
  - docs
  - documentation
assignee: unassigned
title: 'Docs: restructure — decisions folder + INDEX by subsystem (Phase A)'
status: Done
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
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T03:52:19.470Z'
  - type: comment
    comment: >-
      Phase A complete (uncommitted, awaiting `finish FLUX-355`).


      **Changes:**

      - Created `.docs/event-horizon/decisions/` with `README.md` documenting
      ADR conventions and index.

      - Moved `architecture/decoupled-storage.md` →
      `decisions/0001-storage-modes.md` and added skip-banner pointing to
      current reference.

      - Moved `multi-agent-cli-research.md` →
      `decisions/0002-multi-agent-cli.md` and added skip-banner pointing to
      current reference.

      - Renamed `architecture/repository-map.md` → `architecture/code-map.md`.

      - Rewrote `INDEX.md` as a subsystem table with code entry points,
      reference doc, and decision links per subsystem. Planned references
      (FLUX-356..360) are called out inline.

      - Updated 7 wiki-link references across docs from `[[Repository Map]]` →
      `[[Code Map]]`.


      **Verification:** `grep -r repository-map .docs/` returns nothing. `grep
      -r decoupled-storage .docs/` returns nothing. Decisions README links
      resolve.


      **Files touched:**

      - `.docs/event-horizon/INDEX.md`

      - `.docs/event-horizon/decisions/README.md` (new)

      - `.docs/event-horizon/decisions/0001-storage-modes.md` (moved + banner)

      - `.docs/event-horizon/decisions/0002-multi-agent-cli.md` (moved + banner
      + frontmatter)

      - `.docs/event-horizon/architecture/code-map.md` (renamed + title)

      -
      `.docs/event-horizon/architecture/{overview,docs-workspace,ticket-model}.md`

      - `.docs/event-horizon/{development,project-overview}.md`

      - `.docs/event-horizon/workflow/{workflow-install,ticket-interactions}.md`


      No source code changed.
    user: Agent
    date: '2026-06-03T03:52:19.470Z'
    id: c-2026-06-03t03-52-19-470z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-06-03T03:54:12.859Z'
  - type: activity
    user: Agent
    date: '2026-06-03T03:54:12.859Z'
    comment: Updated implementation link.
  - type: comment
    comment: Committed as `93e4931` and closed.
    user: Agent
    date: '2026-06-03T03:54:12.859Z'
    id: c-2026-06-03t03-54-12-859z
author: Agent
implementationLink: '93e4931'
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
