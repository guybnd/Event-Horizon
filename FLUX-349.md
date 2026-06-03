---
priority: Low
effort: S
tags:
  - refactor
  - engine
assignee: unassigned
id: FLUX-349
title: 'Engine: split routes/tasks.ts by concern'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:32.142Z'
    comment: Created ticket.
---
## Problem

`engine/src/routes/tasks.ts` is 622 lines covering CRUD, asset upload, branch allocation, and remote ID coordination. Hard to scan, hard to test individually.

## Plan

- Split into:
  - `routes/tasks/crud.ts` — POST/PUT/GET task CRUD + subtask creation.
  - `routes/tasks/assets.ts` — image and asset upload.
  - `routes/tasks/branch.ts` — branch allocation + PR creation hook.
- Keep one barrel `routes/tasks/index.ts` that mounts them so `index.ts` import stays unchanged.
- Acceptance: no behavior change; each file < 300 lines.
