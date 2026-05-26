---
id: FLUX-325
title: Customizable project templates in global settings
status: Grooming
priority: Low
effort: M
assignee: unassigned
tags:
  - feature
  - engine
  - settings
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-26T00:50:29.787Z'
    comment: Created as subtask of FLUX-324.
---
## Problem / Motivation

When bootstrapping new projects, users may want to customize what gets scaffolded (statuses, columns, agent configs, doc structure) rather than always getting the same opinionated defaults. A "project template" stored in global settings would let users configure their preferred defaults once and have them applied to all new projects.

## Scope

- Add a `projectTemplate` field to global settings schema.
- UI in settings to edit the template (statuses, columns, default tags, agent framework preference).
- Bootstrap logic reads from template instead of hardcoded defaults when available.
- Ship after FLUX-324 (global settings infrastructure) is complete.
