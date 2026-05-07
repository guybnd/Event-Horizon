---
title: Settings Page Polish - Tabbed Navigation or Sidebar
status: Released
createdBy: Agent
updatedBy: Agent
assignee: unassigned
tags:
  - ui-polish
priority: Medium
effort: S
implementationLink: a29328510f890dddb4f27d4205ad03e036ac9e9f
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
    date: '2026-05-07T12:05:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T12:05:00.000Z'
    comment: Starting implementation of the tabbed navigation for the Settings page.
    id: c-2026-05-07t12-05-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T12:15:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T12:15:00.000Z'
    comment: >-
      Implemented tabbed navigation on the Settings page. Board and attribute
      screens are now separated from preferences to reduce cognitive load.
      Please review and type `finish FLUX-87` when ready.
    id: c-2026-05-07t12-15-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-07T12:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T12:20:00.000Z'
    comment: >-
      Completed tabbed navigation for Settings page. Verified build using npm.
      Changes committed in a29328510f890dddb4f27d4205ad03e036ac9e9f.
    id: c-2026-05-07t12-20-00-000z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.993Z'
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.993Z'
releaseDocPath: release-notes/v0.1.0
---

Currently, the settings page is one very long continuous scroll. We can break it down into logical tabs (or a left-side navigation menu) to reduce cognitive load:
* **Workflow & Statuses:** Board Columns, Hidden Statuses, User Input Status, Ready for Merge.
* **Attributes:** Global Tags, Priority Levels.
* **Workspace:** Users & Agents, Project Keys, Docs Workspace.
* **Preferences:** Board Card Click Behavior, Ticket Animations, Card Hover Preview, Backlog Screen, Comment Prompts.
* **Agent Integration:** Skill & Copilot Instructions syncing.
