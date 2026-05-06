---
id: FLUX-29
title: 'Require Input: dedicated response workflow and notification ticker'
status: Grooming
priority: High
createdBy: Agent
updatedBy: Agent
assignee: Agent
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T19:50:00.000Z'
    comment: >-
      Split from FLUX-13 after the ticket direction changed. This ticket tracks
      the newer dedicated-status workflow with a focused response prompt,
      explicit post-response destination, and a notification count for open
      required-input items.
---
## Summary

Build a dedicated `Require Input` workflow where tickets enter a distinct status, the user responds through a focused prompt UI, and the app shows a visible count of open items waiting for user input.

## Scope

### 1. Dedicated status flow
- Keep `Require Input` as a distinct workflow status
- Tickets moved into `Require Input` should be easy to spot in the board
- This flow should work with configurable statuses in settings rather than hard-coded assumptions where practical

### 2. Focused response prompt
- Opening a `Require Input` ticket should support a focused response window/prompt
- The prompt should emphasize the pending question and the answer input box
- The user should be able to finish the response and choose where to send the ticket next

### 3. Post-response destination
- On submit, let the user route the ticket to one of the next workflow states
- First-pass destinations requested so far:
  - `Todo`
  - `Grooming`
- Record the response and status transition in ticket history

### 4. Notification ticker
- Show a visible notification-style count of open `Require Input` tickets
- The count should be available from the main application chrome, similar to a lightweight inbox indicator

## Open Design Notes

- The response prompt may live inside the ticket modal or as a dedicated compact overlay, but it should feel more focused than the normal full ticket editor
- If settings need explicit designation of which statuses represent `Todo`, `Grooming`, or `Require Input`, that config work can be included here if necessary for the flow to be reliable

## Acceptance Criteria

- [ ] Tickets can be moved into a distinct `Require Input` status
- [ ] Opening a `Require Input` ticket presents a focused response experience
- [ ] The response UI lets the user choose the next destination status before submitting
- [ ] Submitting the response records the answer and updates the status
- [ ] The app shows a visible count of tickets currently waiting in `Require Input`

## Likely Files

- `portal/src/components/TaskModal.tsx`
- `portal/src/components/Header.tsx`
- `portal/src/components/Board.tsx`
- `portal/src/AppContext.tsx`
- `portal/src/types.ts`
- `engine/src/index.ts`

## Related Tickets

- `FLUX-13` contains the earlier version of this idea and should not be treated as the implementation source for this revised workflow without reconciliation