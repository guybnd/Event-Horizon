---
id: FLUX-57
title: Fix prompt full-view flow and response routing
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags: []
priority: High
effort: None
implementationLink: ''
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
---
## Summary

Fix the prompt experience in full ticket view so `Require Input` and `Ready`
states render cleanly, do not look broken, and let the user route the ticket to
any appropriate non-prompt status after responding.

## Requirements

### 1. Repair full-view prompt layout
- `Require Input` and `Ready` surfaces should render correctly in full view without broken spacing, duplicated sections, or missing actions
- Popup and full-view prompt compositions should follow the same workflow rules
- Opening a prompt ticket in full view should preserve the prompt context rather than degrading into a generic edit screen

### 2. Broaden response routing
- The response destination list should support all valid non-prompt statuses, not only `Todo` and `Grooming`
- Users should be able to route a prompt directly to `In Progress` or `Done` when that is the correct outcome
- Prompt-only statuses should not be offered as accidental response destinations

### 3. Keep the workflow intent obvious
- The prompt UI should clearly show the pending question, the user's response input, the destination status, and the resulting action
- Ready-for-merge tickets should keep the finish-command handoff clear without looking like a broken response form
- Status routing should respect the configured workflow statuses from settings rather than hard-coding a narrow list

## Acceptance Criteria

- [ ] Full-view prompt tickets render without broken or duplicated prompt UI
- [ ] Prompt responses can be routed to the appropriate non-prompt statuses, including `In Progress` and `Done`
- [ ] Ready-for-merge tickets still present the finalization handoff clearly
- [ ] Popup and full-view prompt behavior stays consistent
- [ ] The routing UI uses the configured workflow statuses safely

## Likely Affected Areas

- `portal/src/components/TaskModal.tsx`
- `portal/src/workflow.ts`
- `portal/src/types.ts` if prompt metadata needs adjustment

## Notes

- FLUX-60 is folded into this ticket as the narrower full-screen prompt bug report
