---
title: Tutorial & initial setup
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - ux
priority: Medium
effort: L
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T08:38:15.189Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T16:03:46.285Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. Scope is large (L effort). Key open decision: is the Welcome
      screen a new dedicated route/view added to the nav, or an overlay/modal
      shown automatically on first launch (detected by absence of tasks or a
      localStorage flag)? This affects routing and dismissal logic. A dedicated
      nav tab ("Welcome" or "Get Started") is the simpler approach and can be
      revisited later. The step-by-step ticket flow demo could be a static
      illustrated walkthrough or an interactive guided tour — static is safer
      for L scope. Marking as Require Input for the open UX decision.
    id: c-flux82-groom
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-07T23:44:31.231Z'
    comment: >-
      auto on first launch. maybe with a button in settings to restart tutorial

      localstorage flag that indicates its been through so we can skip

      maybe interactive guided tour is better even if more brittle it will scale
      better with the mass of changes that will inevitably come
    id: c-2026-05-07t23-44-31-231z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T23:44:31.231Z'
    comment: Response submitted
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-07T23:44:35.291Z'
order: 0
---

## Summary
A Welcome / Getting Started interactive guided tour for first-time users. It will auto-launch on the first visit to guide the user through the ticket lifecycle and prompt them to install the skill.

## Requirements

### 1. Auto-Launch Interactive Tour
- Detect first-time users via a `localStorage` flag (e.g., `flux:welcomed`).
- If the flag is missing, automatically launch an interactive guided tour (using a library or custom overlay).
- Provide a button in Settings to restart the tutorial.

### 2. Tour Content
- **Step 1:** Prompt to install the skill into their agentic IDE, with a button to open Settings or copy instructions.
- **Step 2:** Highlight the board and walk through a typical ticket lifecycle: Create → Groom → Todo → In Progress → Ready → Release.
- Explain the purpose of each stage with interactive tooltips pointing to actual UI elements.

## Acceptance Criteria
- [ ] On first launch, the interactive guided tour begins automatically.
- [ ] The tour successfully guides the user through the board's elements and ticket lifecycle.
- [ ] After completion or skipping, a `localStorage` flag is set to prevent auto-launch.
- [ ] A "Restart Tutorial" button is available in the Settings page.

## Likely Affected Areas
- `portal/src/App.tsx` (or main layout for initialization)
- `portal/src/components/Settings.tsx`
- New components for the guided tour overlay.

## Notes
- Based on user feedback: we are using the interactive guided tour approach and triggering automatically via localStorage.

## Original Request
Tutorial & initial setup
