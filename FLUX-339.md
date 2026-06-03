---
id: FLUX-339
title: Agent workflow skill integration for branch management
status: Todo
priority: Medium
effort: S
assignee: unassigned
tags:
  - feature
  - agent-workflow
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:44.088Z'
    comment: Created as subtask of FLUX-292.
  - type: activity
    user: Agent
    date: '2026-06-03T01:53:49.460Z'
    comment: Updated description.
---
## Problem / Motivation

The agent implementation skill needs updated instructions so agents respect the user's branch decision and handle the full branch lifecycle: working on the branch, committing there, and creating a PR at finish time.

## Implementation Plan

### 1. Branch creation is a user decision at task start

Branch creation is **not** automatic when moving to In Progress. It is a decision made by the user when starting a Todo ticket from the portal (see FLUX-340 for the portal UI). The agent's job is to:
- Check `get_branch` at session start.
- If `branch` is set on the ticket: check out that branch before making any changes.
- If no branch is set: proceed on the current branch (user chose "start normally").

### 2. Agent stays on branch for the full session

Add to the implementation skill: once on a ticket branch, never `git checkout` to another branch without explicit user confirmation in chat. If branch switching is genuinely required mid-session, stop, ask the user, and wait.

### 3. Commits go to the ticket branch

When working on a branch, all commits happen there. Do not merge or rebase mid-session. The `finish` step handles the PR creation.

### 4. `finish <ticket>` with a branch → creates a PR

When the user says `finish FLUX-XX` for a ticket with a `branch` field:
1. Stage all relevant files and commit on the ticket branch.
2. Call `finish_ticket` via MCP — this triggers push + `gh pr create` in the engine (see FLUX-337).
3. The PR URL is stored in `implementationLink` and the ticket moves to `Ready`.
4. Record PR URL in the completion comment.

When no branch is set: existing finish behaviour unchanged (local commit + hash in `implementationLink`).

### 5. If a PR is rejected / returned

If the ticket is moved back from `Ready` to `In Progress` (reviewer sends it back), the agent should:
- Check out the existing branch (it's still in `branch` field).
- Apply requested changes.
- Push to the same branch — the open PR updates automatically.
- Call `finish_ticket` again to move back to `Ready`.

### 6. XS effort exemption

Branch creation is optional for XS effort tickets. The portal "Start Task" prompt should pre-select "start normally" for XS tickets to avoid overhead.

### 7. Update orchestrator skill MCP tool table

Add `create_branch`, `get_branch`, `delete_branch` to the tool table in the orchestrator skill. Remove any reference to `switch_branch`.
