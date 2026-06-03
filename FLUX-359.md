---
priority: Medium
effort: S
tags:
  - docs
  - documentation
  - dx
assignee: unassigned
title: 'Docs: recipes.md — common change recipes (Phase C)'
status: Done
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:39.912Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-06-03T04:01:02.652Z'
  - type: comment
    comment: >-
      Plan: write .docs/event-horizon/recipes.md with 6 task-oriented
      walkthroughs: add a ticket field, add an MCP tool, add a status with
      enforcement, add an agent framework, add a portal screen, change a history
      entry shape. Each recipe lists exact files to touch in order, with
      rationale and verification steps. Cross-link to the relevant reference
      pages instead of duplicating their content.
    user: Agent
    date: '2026-06-03T04:01:02.652Z'
    id: c-2026-06-03t04-01-02-652z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-06-03T04:05:40.282Z'
  - type: activity
    user: Agent
    date: '2026-06-03T04:05:40.282Z'
    comment: Updated implementation link.
  - type: comment
    comment: >-
      Done. Wrote .docs/event-horizon/recipes.md with 6 task-oriented
      walkthroughs (add ticket field, add MCP tool, add status with enforcement,
      add agent framework, add portal screen, change history entry shape). Each
      lists exact files in order plus verification steps; cross-links the
      reference pages. Commit 0740959.


      Separately, the docs view was stripping GFM tables because the tiptap
      editor only registered StarterKit. Added @tiptap/extension-table family +
      turndown gfm plugin and minor table CSS, plus normalized missing blank
      lines before lists/tables across 7 docs (commit 3ec6fb1).
    user: Agent
    date: '2026-06-03T04:05:40.282Z'
    id: c-2026-06-03t04-05-40-282z
author: Agent
implementationLink: 0740959
---
## Problem

Highest-leverage doc for agent productivity: a single page that says "to do X, touch these files in this order." Today this knowledge lives only in commit history and in agents re-deriving it each time.

## Plan

Create `.docs/event-horizon/recipes.md` with starter recipes (each ≤ 20 lines, touchpoints + validation step):

1. Add a new ticket frontmatter field.
2. Add a new MCP tool.
3. Add a new status with custom enforcement.
4. Add a new agent framework.
5. Add a new portal screen.
6. Change history entry shape.

Each recipe links to the relevant reference page. Acceptance: an agent can complete recipe 1 without reading any other doc beyond what the recipe links.
