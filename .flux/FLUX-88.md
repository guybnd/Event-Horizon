---
title: Settings Page Polish - Unify Settings Toggle UI
status: In Progress
createdBy: Agent
updatedBy: Agent
assignee: unassigned
tags:
  - ui-polish
priority: Medium
effort: XS
history:
  - type: activity
    user: Agent
    date: '2026-05-07T12:00:00.000Z'
    comment: Created ticket based on user feedback to polish settings page.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-07T12:21:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T12:21:00.000Z'
    comment: Starting work to unify the toggle UI on the settings page preferences section.
---

The boolean preferences at the bottom of the page use mixed UI patterns.
* "Ticket Animations" and "Card Hover Preview" use custom switch boxes with nested dropdowns inside a `bg-gray-50` card.
* "Enable Backlog Screen" and "Require Comment" use a full-row `<label>` with a native HTML checkbox.

**Implementation:** Create a unified `SettingToggleCard` component that uses a consistent sliding switch (like iOS/macOS) and uniform descriptive text placement for all on/off preferences.
