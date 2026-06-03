---
id: FLUX-340
title: 'Portal UI — branch display in card, modal, and metadata panel'
status: In Progress
priority: Medium
effort: L
assignee: unassigned
tags:
  - feature
  - portal
  - git
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:44.306Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:44.306Z'
    comment: Created as subtask of FLUX-292.
  - type: activity
    user: Agent
    date: '2026-06-03T01:53:49.464Z'
    comment: Updated description. Changed effort to L. Updated tags.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T04:53:10.089Z'
---
## Problem / Motivation

Users need visibility into which branch is associated with a ticket and control over branch creation — directly from the board and ticket views. This ticket also encompasses the diff view surface (FLUX-334 feeds into this), ahead/behind indicators, and the "Start Task" decision prompt.

## Implementation Plan

### 1. "Start Task" prompt on Todo cards

When a user clicks to start a Todo ticket (move to In Progress), show a small prompt:

> **Start working on this ticket**
> ○ Create a new branch: `flux/FLUX-XX-slug`
> ○ Continue on current branch
> [Start]

- Branch option is pre-selected by default, except for XS effort tickets where "current branch" is pre-selected.
- On confirm, calls `POST /api/tasks/:id/branch` (if branch option chosen) then moves ticket to In Progress.
- Lives in a small modal or inline popover — not a full-screen overlay.

**File:** New component `portal/src/components/task-modal/StartTaskPrompt.tsx` + wired into `TaskCard.tsx` right-click menu and board column action.

### 2. Branch badge on TaskCard

Show a small branch chip (git-branch icon + truncated branch name) below the title when `task.branch` is set. Click copies the branch name to clipboard with a brief toast confirmation.

**File:** `portal/src/components/TaskCard.tsx`

### 3. MetadataPanel — branch row + status indicators

Add a "Branch" field row in `MetadataPanel.tsx`:
- When no branch: show "—" (no create button here; creation happens via Start Task prompt).
- When branch exists: show branch name chip + live `aheadCount`/`behindCount` fetched from `GET /api/tasks/:id/branch`. Display as `↑3 ↓1` badges next to the name.
- When branch is deleted/gone: show name in muted style + "missing" indicator.

**File:** `portal/src/components/task-modal/MetadataPanel.tsx`

### 4. TaskModal header — branch + PR link

In the modal header area (next to implementation link):
- Show branch name as a copyable chip.
- When `implementationLink` is a PR URL (starts with `https://github.com`), render it as a "View PR" button that opens the link. Otherwise render as commit hash (existing behaviour).

**File:** `portal/src/components/TaskModal.tsx`

### 5. Diff summary panel (integrates FLUX-334)

Below the implementation link / PR area in the right metadata column, add a "Changes" section:
- Total files changed, total additions (+), total deletions (-).
- Scrollable list of files with coloured `+N -N` counts.
- Populated from `task.diffSummary` (set by engine at finish time — see FLUX-334).
- Hidden when `diffSummary` is not set.

Clicking a file replaces the left-side description/activity panel with the diff viewer (FLUX-334's `DiffViewer.tsx`). A back button returns to description view.

**File:** New component `portal/src/components/task-modal/DiffSummaryPanel.tsx`

### 6. Dependencies

- FLUX-336: `branch` field on Task type
- FLUX-337: branch REST routes
- FLUX-334: `diffSummary` field + diff sidecar + `DiffViewer.tsx`
