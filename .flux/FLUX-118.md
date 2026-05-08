---
title: Add settings to comment tooltip box
status: Done
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - ux
priority: Low
effort: S
implementationLink: PENDING
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T04:15:12.827Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-08T14:25:59.125Z'
    comment: Launched Claude Code session (fe12f05e).
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:26:09.497Z'
    comment: |-
      ```text
      Let me read the ticket and explore the relevant code before planning.
      ```
    id: c-2026-05-08t14-26-09-497z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:26:58.525Z'
    comment: >-
      ```text

      Let me read the relevant sections of TaskCard to understand the current
      comment popover implementation.

      ```
    id: c-2026-05-08t14-26-58-525z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:27:18.445Z'
    comment: >-
      ```text

      Now I understand the current setup. The comment popover is `w-[420px]
      max-h-[480px]` with `text-xs`. The ticket notes prefer "click to expand"
      over manual settings. My plan:


      1. Add an "Open in modal" expand button to the comment popover header —
      clicking it opens the full TaskModal focused on comments

      2. Bump the popover font size from `text-xs` to `text-sm` for readability
      and widen slightly


      Let me check how `openTaskModal` is called from TaskCard:

      ```
    id: c-2026-05-08t14-27-18-445z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:27:27.941Z'
    comment: |-
      ```text
      Good. Now let me move the ticket to In Progress and implement the changes:
      ```
    id: c-2026-05-08t14-27-27-941z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:27:48.451Z'
    comment: >-
      ```text

      Now let me update the ticket to In Progress and make the changes. I'll add
      an "Expand" button to the comment popover that opens the task modal, and
      bump the font/size:

      ```
    id: c-2026-05-08t14-27-48-451z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T14:27:55.111Z'
  - type: comment
    user: Agent
    date: '2026-05-08T14:27:55.111Z'
    comment: >-
      Starting implementation. Plan: add an expand button (Maximize2 icon) to
      the comment popover header that opens the full ticket modal (focused on
      comments), bump comment text from text-xs to text-sm for better
      readability, and widen the popover slightly from 420px to 480px. No
      settings persistence needed since this is a click-to-expand interaction
      rather than a stored preference.
    id: c-2026-05-08t14-27-55-111z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:28:02.479Z'
    comment: |-
      ```text
      Good, ticket is In Progress. Now let me make the code changes:
      ```
    id: c-2026-05-08t14-28-02-479z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:28:06.402Z'
    comment: |-
      ```text
      Now widen the popover and bump font size, and add the expand button:
      ```
    id: c-2026-05-08t14-28-06-402z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:28:13.393Z'
    comment: |-
      ```text
      Now add the expand button to the popover header:
      ```
    id: c-2026-05-08t14-28-13-393z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:28:24.111Z'
    comment: |-
      ```text
      Now bump the comment text from `text-xs` to `text-sm` within the popover:
      ```
    id: c-2026-05-08t14-28-24-111z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:28:31.116Z'
    comment: |-
      ```text
      Also bump the reply text size:
      ```
    id: c-2026-05-08t14-28-31-116z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:28:35.886Z'
    comment: |-
      ```text
      Let me verify the build compiles:
      ```
    id: c-2026-05-08t14-28-35-886z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:28:41.896Z'
    comment: >-
      ```text

      Clean. The changes are:


      1. **Wider popover**: 420px → 480px, max-height 480px → 520px

      2. **Larger comment text**: `text-xs` → `text-sm` for both top-level
      comments and replies

      3. **Expand button**: `Maximize2` icon in the popover header — clicking it
      closes the popover and opens the full TaskModal


      Moving the ticket to Ready now.

      ```
    id: c-2026-05-08t14-28-41-896z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
    comment: >-
      Implementation complete. portal/src/components/TaskCard.tsx changes: (1)
      Popover widened 420px→480px, max-height 480px→520px for more content
      visibility. (2) Comment text bumped text-xs→text-sm for both top-level and
      reply comments. (3) Maximize2 expand button added to popover header —
      closes the popover and opens full TaskModal for comfortable reading of
      long threads. TypeScript check passes. Ready for review.
    id: c-2026-05-09-ready
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:29:07.020Z'
    comment: >-
      ```text

      Implementation is done and the ticket is `Ready`. Here's a summary of the
      changes in `portal/src/components/TaskCard.tsx`:


      1. **Wider, taller popover** — 420px → 480px wide, max-height 480px →
      520px, so more content fits without scrolling

      2. **Larger text** — comment body text bumped from `text-xs` to `text-sm`
      (both top-level and replies)

      3. **Expand button** — `Maximize2` icon in the popover header; clicking it
      closes the popover and opens the full TaskModal, giving full-screen access
      to the comment thread


      When you're ready, say `finish FLUX-118` to commit and close.

      ```
    id: c-2026-05-08t14-29-07-020z
  - type: comment
    user: Guy
    date: '2026-05-08T14:30:36.138Z'
    comment: >-
      looks ok but pressing the fullview button opens the card in windowed mode
      and also it doesnt lead to the comments section
    replyTo: c-2026-05-08t14-29-07-020z
    id: c-2026-05-08t14-30-36-138z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-08T14:30:36.138Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-08T14:30:36.543Z'
    comment: Launched Claude Code session (1b6390c7).
  - type: activity
    user: Agent
    date: '2026-05-08T14:31:54.696Z'
    comment: Launched Claude Code session (a97ecbaf).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T01:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T01:00:00.000Z'
    comment: >-
      Fixed both issues from Guy's feedback. The expand button in the comment
      popover now calls openTaskFullView (full-screen mode, not windowed) with
      scrollToComments: true, which scrolls directly to the comments section
      after opening. TypeScript check passes. Ready for review.
    id: c-2026-05-09-fix-expand
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:33:22.824Z'
    comment: >-
      ```text

      Both issues are fixed. The expand button in the comment popover now:


      1. Opens in **full-view mode** (not the windowed modal) via
      `openTaskFullView`

      2. **Scrolls to the comments section** automatically via `{
      scrollToComments: true }`


      Say `finish FLUX-118` when you're ready to commit and close.

      ```
    id: c-2026-05-08t14-33-22-824z
  - type: activity
    user: Agent
    date: '2026-05-08T14:33:40.576Z'
    comment: Launched Claude Code session (f8b75690).
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:36:02.112Z'
    comment: >-
      ```text

      FLUX-118 is closed. Committed as `17dce82` — comment popover widened, text
      bumped to `text-sm`, expand button opens full-view mode and scrolls to
      comments.

      ```
    id: c-2026-05-08t14-36-02-112z
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-08T14:42:12.164Z'
order: 124
---

## Summary
The comment tooltip box could benefit from user-customizable settings such as font size, box dimensions, or an click-to-expand feature to improve readability.

## Requirements

### 1. Design & Implement Tooltip Customization
- Evaluate the best UX for interacting with large comments in tooltips.
- Add settings (either globally in Settings or locally on the tooltip) to adjust font size and tooltip dimensions.
- Alternatively, implement a "click to expand" feature that opens the tooltip content into a larger modal or pane.

## Acceptance Criteria
- [ ] Users can read long comments comfortably without awkward scrolling or tiny text.
- [ ] Any added settings are saved and persisted.

## Likely Affected Areas
- Tooltip component for comments.
- Settings UI.

## Notes
- We should probably prefer a "click to expand" or auto-sizing approach before adding too many manual settings.

## Original Request
maybe we want bigger font, bigger box, click to expand, whatever. need to think of whats nice ui ux for this
