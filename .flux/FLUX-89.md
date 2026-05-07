---
title: Settings Page Polish - Sticky Save/Action Bar
status: Todo
createdBy: Agent
updatedBy: Agent
assignee: unassigned
tags:
  - ui-polish
priority: Medium
effort: S
history:
  - type: activity
    user: Agent
    date: '2026-05-07T12:00:00.000Z'
    comment: Created ticket based on user feedback to polish settings page.
---

The "Save Configuration" button is located at the top. If a user edits "Agent Workflow" or preferences at the very bottom, they have to scroll all the way back up to save.

**Implementation:** Implement a sticky bottom action bar (or a floating overlay at the bottom-right) that appears to prompt the user to **"Save Changes"** or **"Discard"** whenever `isDirty` is true.
