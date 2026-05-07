---
title: fancy animations
status: Released
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - ui
  - animation
  - feature
  - config
priority: Medium
effort: M
implementationLink: 3a56127
subtasks: []
order: 100
history:
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T08:42:39.988Z'
    comment: >-
      Finished implementation of framer-motion ticket layout animations,
      handling scaling safely in the DOM with AnimatePresence. Tested and
      validated the exit/enter physics with user feedback.
  - type: activity
    user: Guy
    date: '2026-05-07T08:03:42.226Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T18:09:03.724Z'
    comment: Need input on animation library choice.
  - type: comment
    user: Agent
    date: '2026-05-07T18:09:03.724Z'
    comment: >-
      Groomed the ticket plan. Since you want the card to grow into the window
      visually (shared element transitions), installing framer-motion is highly
      recommended as it handles this complex layout geometry natively via
      layoutId. The plan is: Add animationsEnabled and animationSpeed to the
      global config. Update the Settings screen with controls for these fields.
      Use framer-motion to animate the TaskCard expanding seamlessly into the
      TaskModal bounding box. Does adding framer-motion sound good, or should we
      strictly stick to simple CSS fade/scale overlays?
    id: c-2026-05-07t18-09-03-724z
  - type: comment
    user: Guy
    date: '2026-05-07T08:09:42.150Z'
    comment: yeah lets add it thats fine
    id: c-2026-05-07t08-09-42-150z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T08:09:42.150Z'
    comment: Response submitted
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.988Z'
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.988Z'
releaseDocPath: release-notes/v0.1.0
---
## Summary
Add smooth scaling animations when opening a ticket card into a modal or full-screen view, and when closing it back down. Give users control over animation toggle and speed via Settings.

## Requirements
1. **Settings Config**: Add animationsEnabled (boolean) and animationSpeed (enum: fast/normal/slow) to the global settings schema.
2. **Animation Engine**: Animate the bounding box of the card transitioning to the modal window.
3. **Respect Preferences**: If animationsEnabled is false, fallback to instant rendering. Adjust the transition duration based on animationSpeed.

## Proposed Solution (Requires Input)
We recommend installing framer-motion to handle the shared layout animations (layoutId="ticket-{id}"), providing a native fluid feeling.



