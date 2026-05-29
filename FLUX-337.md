---
id: FLUX-337
title: Engine branch-manager module and REST routes
status: Todo
priority: Medium
effort: M
assignee: unassigned
tags:
  - feature
  - engine
  - git
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.697Z'
    comment: Created as subtask of FLUX-292.
---
## Problem / Motivation

The engine needs git operations to create, switch, query, and delete per-ticket branches, plus REST endpoints as a fallback interface.

## Implementation Plan

1. Create `engine/src/branch-manager.ts` with functions:
   - `createTicketBranch(ticketId, baseBranch?)` — runs `git checkout -b flux/<ID>-<slug>`, stores name on ticket.
   - `switchToTicketBranch(ticketId)` — `git checkout <branch>`.
   - `getTicketBranch(ticketId)` — reads branch from ticket frontmatter.
   - `deleteTicketBranch(ticketId)` — deletes only if merged (`git branch -d`).
   - Helper: `slugify(title)` — lowercase, replace non-alphanum with hyphens, truncate to 60 chars.

2. Add REST routes in `engine/src/routes/tasks.ts` (or a new `branch.ts` route file):
   - `POST /api/tasks/:id/branch` — calls createTicketBranch, returns branch name.
   - `GET /api/tasks/:id/branch` — returns `{ name, exists, aheadBehind }`.
   - `DELETE /api/tasks/:id/branch` — removes association, optionally deletes git branch.

3. Use `child_process.execSync` or `simple-git` for git operations. Handle errors (branch exists, dirty working tree) gracefully.
