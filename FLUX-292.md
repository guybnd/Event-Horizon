---
id: FLUX-292
title: Agent should be able to create branch for each feature working on
status: Grooming
priority: Medium
effort: L
assignee: unassigned
tags:
  - feature
  - engine
  - agent-workflow
  - git
  - mcp
createdBy: Guy
updatedBy: Agent
history:
  - type: comment
    user: Agent
    comment: >-
      Groomed ticket. Added implementation plan covering schema, engine branch
      manager, agent workflow integration, and portal UI surfaces. Effort: L —
      touches schema, engine API, agent workflow, and multiple portal components.
      No blocking questions; the design extends the existing implementationLink
      pattern and uses standard git operations.
    date: '2026-05-25T04:40:26.378Z'
    id: c-2026-05-25t04-40-26-378z
  - type: comment
    user: Guy
    date: '2026-05-25T05:35:43.496Z'
    comment: consider MCP workfglow
    replyTo: c-2026-05-25t04-40-26-378z
    id: c-2026-05-25t05-35-43-493z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-25T05:35:35.920Z'
  - type: activity
    user: Guy
    date: '2026-05-29T00:49:59.159Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Re-groomed ticket. Key change: incorporated MCP tools as the primary
      branch management interface (per Guy feedback). Added Part 3 for MCP tool
      definitions following existing mcp-server.ts patterns. Effort: L — touches
      schema, engine module, MCP server, agent workflow skill, and portal UI.
    date: '2026-05-29T00:55:00.000Z'
    id: c-2026-05-29t00-55-00-000z
---

## Problem / Motivation

Agents currently work directly on the active branch (usually `master`). When multiple agents handle separate tickets concurrently, their changes can conflict or pollute commit history. There is no mechanism to isolate work per ticket, track which branch corresponds to which ticket, or display this association in the UI.

Adding per-ticket feature branches lets agents work in isolation, makes concurrent ticket execution safer, and gives users visibility into where each feature lives in git.

## Implementation Plan

### Part 1: Schema — add `branch` field to ticket frontmatter

- Add optional `branch` field (string) to the ticket model in `portal/src/types.ts`.
- The engine schema validator (`engine/src/schema.ts`) should accept but not require this field.
- The field stores a branch name like `flux/FLUX-292-agent-branch-per-ticket`.

### Part 2: Engine — branch lifecycle management

Add a new module `engine/src/branch-manager.ts` with:

1. **`createTicketBranch(ticketId, baseBranch?)`** — creates `flux/<TICKET-ID>-<slugified-title>` from the given base (default: current branch). Stores the branch name on the ticket via the task store. Uses `git checkout -b`.
2. **`switchToTicketBranch(ticketId)`** — checks out the ticket's branch. Verifies it exists first.
3. **`getTicketBranch(ticketId)`** — returns the stored branch name from the ticket frontmatter.
4. **`deleteTicketBranch(ticketId)`** — cleans up after merge/close. Only deletes if the branch has been merged.

Expose via REST API routes (fallback):
- `POST /api/tasks/:id/branch` — create and associate a branch.
- `DELETE /api/tasks/:id/branch` — remove branch association (and optionally delete the git branch).
- `GET /api/tasks/:id/branch` — return branch info (name, exists, ahead/behind counts).

### Part 3: MCP tools for branch management

Add new MCP tools to `engine/src/mcp-server.ts` following the existing pattern:

- **`create_branch`** — creates and associates a feature branch with a ticket. Params: `ticketId`, `baseBranch?`. Calls `createTicketBranch()` internally.
- **`switch_branch`** — checks out the ticket's branch. Params: `ticketId`.
- **`get_branch`** — returns branch info (name, exists, ahead/behind). Params: `ticketId`.
- **`delete_branch`** — removes branch association and optionally deletes the git branch. Params: `ticketId`, `force?`.

This lets agents manage branches natively through the MCP protocol, consistent with how they already manage ticket status and comments.

### Part 4: Agent workflow integration

Modify the implementation skill (`.claude/rules/event-horizon.md`):

- When an agent moves a ticket to `In Progress`, it should use `create_branch` MCP tool to create a feature branch if one doesn't already exist.
- Agent commits go to the ticket's branch rather than the main branch.
- On `finish <ticket>`, the branch info is preserved in the ticket for reference (merge strategy is left to the user — no auto-merge to master).
- Add `create_branch` and `switch_branch` to the MCP tool table in the orchestrator skill.

### Part 5: Portal UI — display branch in card and full view

**TaskCard.tsx:**
- Show a small branch badge (git-branch icon + truncated branch name) below the ticket title when `task.branch` is set.
- Clicking the badge copies the branch name to clipboard.

**MetadataPanel.tsx (full view / popup):**
- Add a "Branch" field row showing the branch name.
- Include a "Create Branch" button when no branch is set and ticket is in a workable status.
- Show branch status indicators (exists/deleted, ahead/behind main).

**TaskModal.tsx:**
- Display the branch name in the header area next to implementation link.
- Add copy-to-clipboard action.

### Part 6: Naming convention and safety

- Branch naming: `flux/<TICKET-ID>-<slugified-title>` (max 60 chars for the slug portion).
- Never auto-delete branches that have unmerged commits.
- If a branch already exists (e.g., user-created), associate it without recreating.
- The feature works in both in-repo and orphan storage modes — it operates on the main repo's git, not the flux-data worktree.

### Non-goals for v1

- Auto-merging branches back to main (users handle PR/merge workflow).
- Multi-worktree parallel agent execution (future ticket).
- Branch protection rules or PR creation.
