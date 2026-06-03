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
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.697Z'
    comment: Created as subtask of FLUX-292.
  - type: activity
    user: Agent
    date: '2026-06-03T01:53:49.437Z'
    comment: Updated description. Updated tags.
  - type: activity
    user: Agent
    date: '2026-06-03T02:52:57.786Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Design decisions (2026-06-03):


      **Branch name stays on ticket after merge** — no automated cleanup. Branch
      name is a useful historical artifact (common practice in Linear, Jira,
      GitHub Issues). Portal shows it muted when `exists: false`. PR URL in
      `implementationLink` is the canonical live record.


      **`gh` auth check at startup** — engine runs `gh auth status` on launch.
      If it fails, a portal warning banner is shown. Engine does NOT block. At
      `finish_ticket` time, if `gh` is absent: degrade gracefully — commit
      locally, store hash in `implementationLink`, append a warning comment to
      the ticket ("PR creation skipped — gh not configured. Commit: `<hash>`.").
      No hard failure.
    date: '2026-06-03T02:52:57.831Z'
    id: c-2026-06-03t02-52-57-831z
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

### 3. `gh` auth check at engine startup

At engine startup, run `gh auth status`. If it fails:
- Emit a portal warning event (use the existing event/broadcast system) so the portal can display a persistent banner: "GitHub CLI not configured — PR creation unavailable. Run `gh auth login` to enable."
- Log a warning to the engine console.
- Do NOT block startup. Engine continues normally; PR creation simply degrades.

### 4. PR creation as part of `finish` — two-tier degradation

When `finish_ticket` is called for a ticket that has a `branch` field set:

**If `gh` is available and authenticated:**
1. Push the branch to remote: `git push -u origin <branch>`.
2. Create a PR via `gh pr create --title "<ticket title>" --body "<ticket body excerpt + ticket link>"`.
3. Store the PR URL in `implementationLink`.
4. Proceed with the normal `finish_ticket` → `Ready` transition.

**If `gh` is absent or not authenticated (graceful degradation):**
1. Commit locally as normal.
2. Store the commit hash in `implementationLink` (existing behaviour).
3. Append a warning comment to the ticket: "PR creation skipped — gh not configured. Commit: `<hash>`. Open a PR manually when ready."
4. Proceed with `Ready` transition.

When `finish_ticket` is called for a ticket with **no** branch: existing behaviour unchanged.

### 5. Post-merge branch display (no cleanup needed)

After a PR merges, the branch is typically deleted on GitHub but the `branch` field stays on the ticket. This is intentional — the branch name is a useful historical artifact. The portal detects `exists: false` from `GET /api/tasks/:id/branch` and shows the name muted. No automated cleanup on the engine side.

### 6. Error handling

Handle gracefully: dirty working tree on create, branch already exists, unmerged-branch delete attempt. Return structured errors via `errorResult()` so the agent can surface them clearly.

### 7. Use `simple-git` (not `execSync`)

Prefer `simple-git` for consistency with any existing engine git usage. Fall back to `execSync` only if `simple-git` is not already a dependency.
