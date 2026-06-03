---
priority: Medium
effort: S
tags:
  - docs
  - documentation
  - dx
assignee: unassigned
title: 'Docs: recipes.md — common change recipes (Phase C)'
status: In Progress
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
author: Agent
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
