---
title: Settings Page Polish - Improve Project Keys UI
status: Backlog
createdBy: Agent
updatedBy: Guy
assignee: unassigned
tags:
  - ui-polish
priority: Low
effort: XS
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
    date: '2026-05-25T06:16:39.745Z'
---

"Project Keys" is currently just a raw `<input>` field sitting naked in its container.

**Implementation:** Change it to behave like a tag-input field (styled like the `TagEditor` or User Editor) where hitting "Enter" adds a project key (e.g., `FLUX`, `DEV`) as a distinct pill that can be removed via an "X", rather than a raw comma-separated text string. This prevents typos and looks much cleaner.
