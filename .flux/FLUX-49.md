---
title: expand docs coverage from completed tickets
status: In Progress
priority: Medium
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - docs
  - task
history:
  - type: activity
    user: Guy
    date: '2026-05-07T01:17:16.402Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T11:17:16.4021201+10:00'
    comment: >-
      Captured from the request to go through all completed tickets and check
      whether more shipped behavior should be promoted into the docs set. The
      current docs cover architecture and workflow basics, but the done tickets
      still contain durable behavior around ticket hierarchy, ordering,
      priorities, filtering, and user-input interaction that should be easier to
      discover without reading ticket history.
    id: c-2026-05-07t11-17-16-4021201-10-00
  - type: comment
    user: Agent
    date: '2026-05-07T11:17:40.2104551+10:00'
    comment: >-
      Plan: review the completed tickets that define durable ticket-model and
      interaction behavior, fold the highest-value gaps into focused docs pages
      under `.docs/`, then validate the updated docs through the live docs API.
    id: c-2026-05-07t11-17-40-2104551-10-00
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T11:17:40.2104551+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T11:21:06.1165199+10:00'
    comment: >-
      Reviewed the completed ticket set for durable doc gaps and promoted the
      highest-value missing behavior into the docs tree. Added a Ticket Model
      page covering priority, effort, order, implementation links, hierarchy,
      and activity semantics; added a Ticket Interactions page covering shared
      search/filter behavior, Require Input response flow, deep-linkable ticket
      views, and triage cues; and updated the project overview so the new pages
      are discoverable. Validated with a live `GET /api/docs` check confirming
      the new pages parse through the engine. Commit: `497d16c` (`Document
      ticket model and interaction flows`).
    id: c-2026-05-07t11-21-06-1165199-10-00
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T11:21:06.1165199+10:00'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-07T01:23:43.972Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Guy
    date: '2026-05-07T01:43:36.139Z'
  - type: comment
    user: Agent
    date: '2026-05-07T01:53:52.3296579Z'
    comment: >-
      Follow-up docs gap: the docs set still explains the repo and workflow more
      than it explains the docs system itself. Reopening this ticket to add a
      dedicated docs-workspace page covering the `.docs` file model, sidebar and
      editor behavior, permissions, wiki linking, and the main code touchpoints,
      then linking that page into the existing overview docs.
    id: c-2026-05-07t01-53-52-3296579z
  - type: status_change
    from: Done
    to: In Progress
    user: Agent
    date: '2026-05-07T01:53:52.3296579Z'
effort: S
implementationLink: 497d16c
subtasks: []
order: 8
---
## Summary

Review completed tickets and extend the docs set with any durable project
behavior or workflow detail that is still missing from `.docs/`.

## Requirements

### 1. Mine completed tickets for doc-worthy behavior
- Read the relevant done tickets, not just the existing docs
- Focus on durable behavior that future contributors or agents need to know

### 2. Extend docs where the gaps are real
- Add or update docs pages for missing ticket model, interaction, or setup
  behavior
- Keep the docs focused on how the system works, not raw ticket history

### 3. Keep the documentation set coherent
- Prefer fitting new material into the existing `.docs/` structure unless a new
  page is clearly justified
- Reuse README only for repo-level entry points or setup notes

## Acceptance Criteria

- [x] Completed tickets have been reviewed for durable doc gaps
- [x] The docs set includes the highest-value missing shipped behaviors
- [x] The updated docs still parse through the live docs API

## Likely Affected Areas

- `.docs/`
- `README.md`

## Dependencies

- Follow-up to FLUX-47
