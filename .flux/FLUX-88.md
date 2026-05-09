---
title: Settings Page Polish - Unify Settings Toggle UI
status: Released
createdBy: Agent
updatedBy: Agent
assignee: unassigned
tags:
  - ui-polish
priority: Medium
effort: XS
implementationLink: 601fa76f882e1a8149ae7105b11c9a6aa418608d
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
    date: '2026-05-07T12:21:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T12:21:00.000Z'
    comment: >-
      Starting work to unify the toggle UI on the settings page preferences
      section.
    id: c-2026-05-07t12-21-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T12:25:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T12:25:00.000Z'
    comment: >-
      Extracted a `SettingToggleCard` component and unified all 4 boolean
      preference toggles under the new style. Ready for review, type `finish
      FLUX-88` when ready.
    id: c-2026-05-07t12-25-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T10:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T10:00:00.000Z'
    comment: >-
      User confirmed completion. Changes committed in
      601fa76f882e1a8149ae7105b11c9a6aa418608d.
    id: c-2026-05-08t10-00-00-000z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.364Z'
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.364Z'
releaseDocPath: release-notes/0.2.0
---

The boolean preferences at the bottom of the page use mixed UI patterns.
* "Ticket Animations" and "Card Hover Preview" use custom switch boxes with nested dropdowns inside a `bg-gray-50` card.
* "Enable Backlog Screen" and "Require Comment" use a full-row `<label>` with a native HTML checkbox.

**Implementation:** Create a unified `SettingToggleCard` component that uses a consistent sliding switch (like iOS/macOS) and uniform descriptive text placement for all on/off preferences.
