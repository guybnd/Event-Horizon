---
title: add field for 'story points' or 'intensity'
status: Todo
priority: None
createdBy: Guy
updatedBy: Guy
assignee: Guy
tags: []
history:
  - type: comment
    user: Agent
    date: '2026-05-06T19:20:00.000Z'
    comment: >-
      Re-groomed as a sizing-field ticket. The main remaining decision is the
      naming and scale: classic story points, T-shirt sizes, or a custom agent
      intensity scale.
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
    comment: >-
      Requesting naming and scale choice in-ticket so implementation can be
      modeled once. Please pick one label (`Story Points`, `Effort`, or
      `Intensity`) and one first-version scale (Fibonacci numbers or T-shirt
      sizes).
  - type: comment
    user: Guy
    date: '2026-05-06T09:27:49.201Z'
    comment: Effort and tshirt sizes
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T09:27:49.201Z'
    comment: Response submitted
---
## Groomed Scope

Add a second estimation field so a ticket can capture implementation effort separately from urgency/priority.

## Candidate Naming

- `Story Points` for standard software planning terminology
- `Effort` for a simpler, less process-heavy label
- `Intensity` if you want an agent-oriented label

## Candidate Scales

- Fibonacci points: 1, 2, 3, 5, 8, 13
- T-shirt sizes: XS, S, M, L, XL

## Acceptance Criteria

- [ ] Tickets can store an optional effort estimate
- [ ] The field is configurable or at least clearly modeled in the UI
- [ ] The estimate is visible in the ticket view and editable like priority

## User Input Needed

- Which label do you want: `Story Points`, `Effort`, or `Intensity`?
- Which scale should first version use: Fibonacci numbers or T-shirt sizes?

## Files Likely Affected

- `engine/src/index.ts`
- `portal/src/types.ts`
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/TaskCard.tsx`
