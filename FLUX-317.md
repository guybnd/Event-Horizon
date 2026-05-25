---
assignee: unassigned
tags:
  - feature
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T15:14:14.309Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 72986952-bba3-44df-ba90-dae470399f46
    startedAt: '2026-05-25T15:14:31.276Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T15:14:31.276Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T15:14:40.417Z'
  - type: activity
    user: Agent
    date: '2026-05-25T15:15:43.655Z'
    comment: >-
      Updated description. Changed priority to Medium. Changed effort to M.
      Updated tags.
  - type: comment
    user: Agent
    comment: >-
      Grooming complete. Plan covers: epic card visual differentiation (left
      accent + badge), subtask progress bar with done/total count, and a
      clickable popover panel listing all subtasks for navigation. Effort
      estimated at M due to the new popover UI and data resolution logic.
    date: '2026-05-25T15:15:50.840Z'
    id: c-2026-05-25t15-15-50-840z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T15:15:50.840Z'
id: FLUX-317
title: add indicator on ticket with subtasks how many are done
status: Todo
createdBy: Guy
updatedBy: Agent
---
## Problem / Motivation

Parent tickets (those with subtasks) look identical to regular tickets on the board, making it hard to see at a glance which tickets are "epics" orchestrating child work and how much progress has been made. Users need a quick visual signal showing subtask completion status and a way to navigate to individual subtasks without opening the full ticket view.

## Implementation Plan

### 1. Epic card visual treatment in `TaskCard.tsx`
- Detect when `task.subtasks?.length > 0` — this makes the card an "epic"
- Add a subtle left-border accent (e.g., a 3px purple/indigo left border) to differentiate from regular cards
- Add a small "Epic" label badge near the ticket ID

### 2. Subtask progress indicator
- Resolve subtask IDs to Task objects using the `tasks` array from `AppContext`
- Calculate `doneCount` (subtasks with status === 'Done' or in the archive/released statuses) vs `totalCount`
- Render a compact progress bar + label (e.g., "3/5 done") below the description snippet
- Use a segmented bar or filled bar with green for done, gray for remaining

### 3. Clickable subtask panel (popover)
- Clicking the progress indicator opens a popover (similar to the existing comment popover pattern)
- The popover lists each subtask with: status badge, title, assignee
- Each subtask row is clickable and navigates to that ticket (using `openBoardTask`)
- Include a header showing "Subtasks (3/5 done)"

### 4. Data flow
- `Board.tsx` already builds `parentByChildId` — extend it to also pass resolved subtask Task objects to epic cards (or resolve inside `TaskCard` using context's `tasks` array)
- Add a `tasks` lookup capability to `TaskCard` — either pass the full task list as prop or expose a helper from `AppContext`

### Key files
- `portal/src/components/TaskCard.tsx` — main changes (epic styling, progress bar, popover)
- `portal/src/components/Board.tsx` — may need to pass additional data
- `portal/src/AppContext.tsx` — expose tasks lookup if needed
