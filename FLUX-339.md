---
id: FLUX-339
title: Agent workflow skill integration for branch management
status: In Progress
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
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:44.088Z'
    comment: Created as subtask of FLUX-292.
  - type: activity
    user: Agent
    date: '2026-06-03T01:53:49.460Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-06-03T02:52:57.826Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Design decisions (2026-06-03):


      **Reviewer agent is manually kicked off** — not an automatic hook on
      `Ready`. The user selects the scope and reviewer personality
      intentionally.


      **Review conversation lives on the ticket, not the GitHub PR.** GitHub PR
      = diff artifact. Ticket = review record. This keeps the full decision
      trail in the portal without requiring a GitHub context switch. Reviewer
      leaves a structured comment, moves ticket back to `In Progress` if changes
      needed. Working agent picks up the same branch, pushes, PR auto-updates.
      Reviewer approves → `Done`.
    date: '2026-06-03T02:52:57.854Z'
    id: c-2026-06-03t02-52-57-854z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T03:01:22.776Z'
---
## Problem / Motivation

The agent implementation skill needs updated instructions so agents respect the user's branch decision and handle the full branch lifecycle: working on the branch, committing there, creating a PR at finish time, and handing off cleanly to a reviewer agent when one is invoked.

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

### 5. Reviewer agent handoff (ticket-first)

Reviewer agents are **not** triggered automatically. The user manually kicks off a review session and selects the scope and "personality" of the reviewer. This is intentional — review is a deliberate act, not an automatic hook.

The review conversation lives **on the ticket**, not on the GitHub PR. This keeps the full decision trail visible in the portal without requiring a GitHub context switch. The GitHub PR is the diff artifact; the ticket is the review record.

Reviewer agent flow:
- Reviewer leaves a structured comment on the ticket: what passed, what needs changing.
- If changes needed: reviewer moves ticket back to `In Progress` with the comment as the stated reason.
- Working agent picks up the ticket, checks out the existing branch (still in `branch` field), applies changes, pushes. The open PR updates automatically.
- Working agent calls `finish_ticket` again → ticket back to `Ready`.
- If approved: reviewer moves ticket to `Done`.

Add a note in the implementation skill that when returning to `In Progress` from `Ready`, the agent should always re-read the most recent reviewer comment before making any changes.

### 6. If a PR is rejected / returned without a reviewer agent

If a human reviewer sends the ticket back to `In Progress` directly, the same flow applies:
- Agent checks out the existing branch.
- Applies requested changes and pushes.
- Calls `finish_ticket` to return to `Ready`.

### 7. XS effort exemption

Branch creation is optional for XS effort tickets. The portal "Start Task" prompt should pre-select "start normally" for XS tickets to avoid overhead.

### 8. Update orchestrator skill MCP tool table

Add `create_branch`, `get_branch`, `delete_branch` to the tool table in the orchestrator skill. Remove any reference to `switch_branch`.
