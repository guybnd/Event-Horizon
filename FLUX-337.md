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
  - type: activity
    user: Agent
    date: '2026-06-03T01:53:49.437Z'
    comment: Updated description. Updated tags.
---
## Problem / Motivation

The engine needs git operations to create, query, and delete per-ticket branches, plus REST endpoints as a fallback interface. The `finish` flow should create a PR (not just a commit) so the review loop happens through GitHub, and tickets at `Ready` map cleanly to open PRs awaiting human review.

## Implementation Plan

### 1. Create `engine/src/branch-manager.ts`

Functions:
- `createTicketBranch(ticketId, title, baseBranch = 'master')` — runs `git checkout -b flux/<ID>-<slug>`, stores branch name on ticket via `patch-ticket`.
- `getTicketBranch(ticketId)` — reads branch from ticket frontmatter.
- `deleteTicketBranch(ticketId)` — deletes only if merged (`git branch -d`). Refuses unmerged branches unless `force: true`.
- Helper: `slugify(title)` — lowercase, replace non-alphanum with hyphens, truncate to 60 chars.
- `getBranchStatus(branchName)` — returns `{ exists, aheadCount, behindCount }` relative to `master`.

**Note:** No `switchToTicketBranch` function. Agents stay on their branch for the full session. If a branch switch is ever needed, it must be confirmed by the user first — this is not an automated operation.

### 2. Add REST routes

Add to `engine/src/routes/tasks.ts` (or new `branch.ts` route file):
- `POST /api/tasks/:id/branch` — calls `createTicketBranch`, returns `{ branch }`.
- `GET /api/tasks/:id/branch` — returns `{ name, exists, aheadCount, behindCount }`.
- `DELETE /api/tasks/:id/branch` — removes association, optionally deletes git branch.

### 3. PR creation as part of `finish`

When `finish_ticket` is called for a ticket that has a `branch` field set:
1. Push the branch to remote: `git push -u origin <branch>`.
2. Create a PR via `gh pr create --title "<ticket title>" --body "<ticket body excerpt + ticket link>"`.
3. Store the PR URL in `implementationLink` (overwrites any prior commit hash).
4. Proceed with the normal `finish_ticket` → `Ready` transition.

When `finish_ticket` is called for a ticket with **no** branch:
- Existing behaviour unchanged: commit hash in `implementationLink`, transition to `Ready`.

### 4. Error handling

Handle gracefully: dirty working tree on create, branch already exists, `gh` not authenticated, unmerged-branch delete attempt. Return structured errors via `errorResult()` so the agent can surface them clearly.

### 5. Use `simple-git` (not `execSync`)

Prefer `simple-git` for consistency with any existing engine git usage. Fall back to `execSync` only if `simple-git` is not already a dependency.
