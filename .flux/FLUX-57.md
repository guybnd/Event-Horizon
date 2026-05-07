---
title: Fix prompt full-view flow and response routing
status: Done
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - ui
  - bug
priority: High
effort: L
implementationLink: '881ac3e0cc4810ad72c2efc79285aa475bdbeef8'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T03:12:18.578Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T03:14:49.703Z'
    comment: Changed priority from None to High.
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Groomed this into the canonical prompt UX ticket. The first slice should
      fix the full-view layout and let prompt responses route to any valid
      non-prompt status, including `In Progress` and `Done` when appropriate.
    id: c-2026-05-07t03-53-39-4816199z-flux-57
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
  - type: comment
    user: Guy
    date: '2026-05-07T05:48:36.483Z'
    comment: >-
      see how it looks like shit now :

      ![image](assets/FLUX-57/image.png)


      we need a proper layouting of the full ticket page and maybe a dedicate d
      floating input modal that can be ocollapsed and re enabled with a shiny
      propmting button inside the ticket page
    id: c-2026-05-07t05-48-36-483z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-07T05:48:38.578Z'
order: 8
---
## Summary

Redesign the prompt experience in full ticket view so `Require Input` and
`Ready` states render cleanly, and introduce a dedicated floating prompt modal
that can be collapsed and re-enabled via a prominent prompting button inside
the ticket page.

## Requirements

### 1. Dedicated floating prompt modal
- Replace the current inline prompt layout with a floating/overlay prompt modal inside the full ticket view
- The modal should be collapsible — users can dismiss it to focus on the ticket content and re-open it via a visible prompt button
- The prompt button should be prominent and always accessible within the full ticket page when a prompt is active
- The floating modal should contain the pending question, response input area, and status routing controls

### 2. Repair full-view prompt layout
- `Require Input` and `Ready` surfaces should render correctly in full view without broken spacing, duplicated sections, or missing actions
- Opening a prompt ticket in full view should preserve the prompt context rather than degrading into a generic edit screen
- The layout should look clean and intentional, not like a broken form (see attached screenshot in comments)

### 3. Broaden response routing
- The response destination list should support all valid non-prompt statuses, not only `Todo` and `Grooming`
- Users should be able to route a prompt directly to `In Progress` or `Done` when that is the correct outcome
- Prompt-only statuses should not be offered as accidental response destinations
- The routing UI should use the configured workflow statuses from settings

### 4. Keep the workflow intent obvious
- The prompt UI should clearly show the pending question, the user's response input, the destination status, and the resulting action
- Ready-for-merge tickets should keep the finish-command handoff clear without looking like a broken response form
- Popup and full-view prompt behavior should stay consistent

## Acceptance Criteria

- [ ] Full-view prompt tickets use a dedicated floating/collapsible prompt modal
- [ ] A prominent prompt button allows re-opening the collapsed prompt modal
- [ ] Full-view prompt tickets render without broken or duplicated prompt UI
- [ ] Prompt responses can be routed to all appropriate non-prompt statuses, including `In Progress` and `Done`
- [ ] Ready-for-merge tickets still present the finalization handoff clearly
- [ ] Popup and full-view prompt behavior stays consistent
- [ ] The routing UI uses the configured workflow statuses safely

## Likely Affected Areas

- `portal/src/components/TaskModal.tsx`
- `portal/src/workflow.ts`
- `portal/src/types.ts` if prompt metadata needs adjustment

## Notes

- FLUX-60 is folded into this ticket as the narrower full-screen prompt bug report
- See screenshot in Guy's comment showing the current broken layout


