---
title: Settings Page Polish - Better Empty States & Validation
status: Backlog
createdBy: Agent
updatedBy: Guy
assignee: unassigned
tags:
  - ui-polish
priority: Low
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
    to: Backlog
    user: Guy
    date: '2026-05-25T06:16:46.596Z'
---

* If all statuses are deleted, it shouldn't look broken. Adding a gentle empty-state graphic (e.g., a faint Lucide icon + "No tags exist yet. Create one!") is more welcoming.
* Status & Tag editors allow saving completely empty names (just spaces). Adding basic text validation disabling the save button if a tag name is blank would prevent data errors.
