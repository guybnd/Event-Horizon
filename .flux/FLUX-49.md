---
id: FLUX-49
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
  - type: comment
    user: Agent
    date: '2026-05-07T11:17:16.4021201+10:00'
    comment: >-
      Captured from the request to go through all completed tickets and check
      whether more shipped behavior should be promoted into the docs set. The
      current docs cover architecture and workflow basics, but the done tickets
      still contain durable behavior around ticket hierarchy, ordering,
      priorities, filtering, and user-input interaction that should be easier
      to discover without reading ticket history.
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
effort: S
implementationLink: ''
subtasks: []
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

- [ ] Completed tickets have been reviewed for durable doc gaps
- [ ] The docs set includes the highest-value missing shipped behaviors
- [ ] The updated docs still parse through the live docs API

## Likely Affected Areas

- `.docs/`
- `README.md`

## Dependencies

- Follow-up to FLUX-47