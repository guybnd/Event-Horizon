---
id: FLUX-339
title: Agent workflow skill integration for branch management
status: Ready
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
  - type: comment
    user: Agent
    comment: >-
      Updated `.github/skills/event-horizon/implementation.md` (v2.4.0): added
      step 2 to check `get_branch` at session start and checkout the ticket
      branch if set; added "Branch Rules" section covering stay-on-branch
      discipline, no auto-creation, returning from Ready, and XS exemption;
      added "Reviewer Agent Handoff" section. Updated
      `.github/skills/event-horizon/orchestrator.md`: added `branch` field to
      ticket model table; added `create_branch`, `get_branch`, `delete_branch`
      to MCP tools table with notes; added note that `finish_ticket` triggers PR
      creation when branch is set; added note that no `switch_branch` tool
      exists.
    date: '2026-06-03T03:02:14.181Z'
    id: c-2026-06-03t03-02-14-181z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T03:02:14.181Z'
  - type: agent_session
    sessionId: e058a8be-b1c3-45cf-b895-82c9ed57043c
    startedAt: '2026-06-03T03:06:59.731Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T03:07:16.979Z'
        message: Working
        type: tool
        data:
          toolName: Skill
          parameters:
            skill: review
            args: FLUX-339 --persona architect
      - timestamp: '2026-06-03T03:07:22.589Z'
        message: 'Running: git diff master -- .github/skills/event-horizon/im...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              git diff master -- .github/skills/event-horizon/implementation.md
              .github/skills/event-horizon/orchestrator.md
              .github/skills/event-horizon/grooming.md
              .github/skills/event-horizon/release.md 2>/dev/null | head -300
            description: Show diff of changed skill files
      - timestamp: '2026-06-03T03:07:29.779Z'
        message: Running command
        type: info
      - timestamp: '2026-06-03T03:07:33.564Z'
        message: Reading implementation.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /Users/guy/Event-Horizon/.github/skills/event-horizon/implementation.md
      - timestamp: '2026-06-03T03:07:44.780Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:08:29.783Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T03:08:40.366Z'
        message: >-
          ---


          ## FLUX-339 Architect Review


          ### Overview


          The changes update four skill files to integrate branch management
          into the agent workflow: implementation, orchestrator, grooming, and
          release. The core architecture — user decides at Start Task, agent
          checks out, `finish_ticket` pushes + creates PR atomically — is sound.
          The reviewer loop (Ready → In Progress → re-checkout existing branch →
          push → Ready) is well-designed and intentionally manual.


          ---


          ### What's Working Well


          - **Branch ownership is correctly placed.** Portal decides whether to
          create a branch; agent only follows what `get_branch` returns. This
          respects the intended UX from FLUX-340.

          - **`finish_ticket` as the atomic PR trigger** is clean. The agent
          never calls `gh pr create` directly — the engine owns that.

          - **File Boundaries section** is a good addition. Makes the `.flux/`
          prohibition concrete rather than buried in a "Critical Rules"
          footnote.

          - **Removal of YAML schema landmines** is justified — once history
          construction is fully delegated to MCP tools, those examples become
          dead weight and a distraction.

          - **REST API fallback threshold** is now precise: "ToolSearch returns
          no event-horizon tools." The old "if MCP tools are unavailable" was
          too vague for agents to evaluate.


          ---


          ### Issues


          **1. Branch may not exist locally when `get_branch` returns a name
          (medium)**


          Step 2: "If `branch` is set, run `git checkout <branch>`." If the
          branch was created by the portal via `create_branch` (which creates it
          on the remote), the agent's local git won't have it. `git checkout
          flux/FLUX-XX-slug` will fail with "branch not found."


          The fix is to run `git fetch origin <branch>` before `git checkout`,
          or use `git checkout -b <branch> origin/<branch>`. The instructions
          should be explicit about this — agents that hit this will either error
          or silently work on the wrong branch.


          **2. "Returning from Ready" — push step is implicit (low-medium)**


          Branch Rules: *"check out the existing branch, apply changes, a...
    user: Claude Code
    date: '2026-06-03T03:06:59.731Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T03:08:40.367Z'
tokenMetadata:
  inputTokens: 173456
  outputTokens: 4140
  costUSD: 0.184355
  costIsEstimated: false
  cacheReadTokens: 153559
  cacheCreationTokens: 19888
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
