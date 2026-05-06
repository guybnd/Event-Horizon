---
title: 'Require Input: visual indicator and prompt UI'
status: Done
createdBy: Guy
updatedBy: Guy
assignee: Guy
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:30:00.000Z'
    comment: >-
      Fleshed this out with full spec. This is self-contained and ready to work
      on — the "Require Input" status column already exists in config.
    id: c-2026-05-06t07-30-00-000z
  - type: comment
    user: Guy
    date: '2026-05-06T08:21:48.950Z'
    comment: >-
      Lets refactor this


      Require input shouldnt be a status but its own setting boolean on a ticket


      if true, then show the signal. we should also make it so that require
      input tickets are by default shown at the top of their respective list


      the require input should show up as it's own section perhaps, with a
      window that pops up with the questions, and the user can input the answer.
      when finishing this answer it should transition the ticket back into a
      separate status of 'input granted' or something like this so the agents
      can know to pick it back up. need to think about this flow in more detail
    id: c-2026-05-06t08-21-48-950z
  - type: status_change
    from: Done
    to: Grooming
    user: Guy
    date: '2026-05-06T08:21:52.412Z'
  - type: comment
    user: Agent
    date: '2026-05-06T19:20:00.000Z'
    comment: >-
      Re-groomed around the new boolean flag approach. This is not blocked on
      implementation details, but it still needs a product decision on the
      post-response transition state and whether the board gets a dedicated
      "Require Input" section now or in a follow-up.
    id: c-2026-05-06t19-20-00-000z
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
    comment: >-
      Requesting input in-ticket so implementation can start cleanly. Please
      answer two decisions here: 1) after a user responds, should the ticket
      keep its prior workflow status or move to a new "Input Granted" status? 2)
      should the first version include a dedicated board section for
      input-needed tickets, or should that ship later as a follow-up?
    id: c-2026-05-06t19-35-00-000z
  - type: comment
    user: Guy
    date: '2026-05-06T09:10:27.887Z'
    comment: >-
      1. we should have a window prompt open that basically shows just the
      question part and  the answer input box, when the user wants to finish
      responding he should be able to press where to send the ticket to like


      * send to to-do,

      * send to further grooming i.e maybe user wants to ask agent follow up
      questions
       in which case we probably need to be able to set a dedicated Grooming and To Do status in the settings so these are distinctively connected

      2.  we should probably have a distinct Status of needing input that should
      be configured in the setting same as above we should also add like a
      notification ticker with amount of open required inputs like facebook
      notification style
    id: c-2026-05-06t09-10-27-887z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-06T09:10:34.475Z'
  - type: status_change
    from: Grooming
    to: Done
    user: Guy
    date: '2026-05-06T09:14:45.949Z'
order: 6
priority: High
---
## Groomed Scope

Refactor "Require Input" away from a ticket status and into a ticket-level boolean flag, then make flagged tickets visually obvious and easy for a human to answer.

## Proposed Implementation

### Data model
- Add `requireInput: boolean` to the ticket/frontmatter model
- Keep the normal workflow status independent from the input-needed state
- Store enough history to show who requested input and when

### Board behavior
- Tickets with `requireInput: true` render a visible alert treatment on the card
- Within a column, `requireInput: true` tickets sort above other tickets by default
- If we later want a separate board section for these, that can build on the same flag

### Ticket view behavior
- Opening a flagged ticket shows a prominent "Response Needed" banner with the latest request/comment
- The response field is focused by default
- Submitting a response clears `requireInput`

## Acceptance Criteria

- [ ] Tickets can be flagged for required input without changing their workflow status
- [ ] Flagged tickets are visually distinct on the board
- [ ] Flagged tickets sort to the top of their current status list
- [ ] Opening a flagged ticket highlights the pending request and focuses the response field
- [ ] Responding clears the flag and records the response in history

## User Input Needed

- After a response, should the ticket return to its previous normal status unchanged, or should we introduce a separate `Input Granted` status?
- Do you want a dedicated board section for input-needed tickets in this ticket, or should that be a follow-up after the boolean flag lands?

## Files Likely Affected

- `engine/src/index.ts`
- `portal/src/types.ts`
- `portal/src/components/Board.tsx`
- `portal/src/components/TaskCard.tsx`
- `portal/src/components/TaskModal.tsx`

