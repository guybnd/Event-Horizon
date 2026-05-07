---
title: Settings Page Polish - Sticky Save/Action Bar
status: Done
createdBy: Agent
updatedBy: Guy
assignee: unassigned
tags:
  - ui-polish
priority: Medium
effort: S
history:
  - type: activity
    user: Agent
    date: '2026-05-07T12:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-07T12:00:00.000Z'
    comment: Created ticket based on user feedback to polish settings page.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T10:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T10:00:00.000Z'
    comment: Starting implementation of the sticky save/action bar.
    id: c-2026-05-08t10-00-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T10:05:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T10:05:00.000Z'
    comment: >-
      Implemented the sticky bottom action bar handling `isDirty` state with
      options to Save or Discard changes. Type `finish FLUX-89` when ready to
      sign off.
    id: c-2026-05-08t10-05-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-07T14:08:39.238Z'
order: 7
---

The "Save Configuration" button is located at the top. If a user edits "Agent Workflow" or preferences at the very bottom, they have to scroll all the way back up to save.

**Implementation:** Implement a sticky bottom action bar (or a floating overlay at the bottom-right) that appears to prompt the user to **"Save Changes"** or **"Discard"** whenever `isDirty` is true.
