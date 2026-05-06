---
title: add subtasks to tickets
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: Guy
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T19:20:00.000Z'
    comment: >-
      Re-groomed this into a parent/child ticket relationship proposal. This is
      close to ready, but one scope decision remains: whether subtasks are
      existing linked tickets only, or whether embedded checklist items are also
      part of the first version.
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
    comment: >-
      Requesting scope confirmation in-ticket: should first version support only
      linked existing tickets as subtasks, or should inline checklist items be
      included now as well? Existing-ticket links are the smaller and cleaner
      first slice.
  - type: comment
    user: Guy
    date: '2026-05-06T09:18:44.135Z'
    comment: >-
      should first version support only linked existing tickets as subtasks, or
      should inline checklist items be included now as well? Existing-ticket
      links are the smaller and cleaner first slice. agreed
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T09:18:50.359Z'
priority: None
effort: None
implementationLink: ''
---
## Groomed Scope

Allow a ticket to reference child tickets as subtasks so larger work can be broken into smaller tracked tickets.

## Proposed First Version

- A ticket can have zero or more child ticket IDs
- The task view shows a `Subtasks` section with linked child tickets
- From the task view, the user can attach existing tickets as subtasks
- Subtasks display key metadata at a glance: title, status, assignee, priority

## Acceptance Criteria

- [ ] Tickets can store linked child ticket IDs
- [ ] The task view renders a subtasks section when child tickets exist
- [ ] Users can attach and detach linked tickets as subtasks from the task view
- [ ] Subtask links open the referenced ticket directly

## User Input Needed

- Should first version support only linked existing tickets, or also lightweight checklist subtasks created inline?

## Files Likely Affected

- `engine/src/index.ts`
- `portal/src/types.ts`
- `portal/src/components/TaskModal.tsx`
