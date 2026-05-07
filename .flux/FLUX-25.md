---
id: FLUX-25
title: add commit \ PR field to ticket fields
status: Released
priority: None
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags: []
history:
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-06T19:20:00.000Z'
  - type: status_change
    from: Todo
    to: Done
    user: Agent
    date: '2026-05-06T22:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T22:00:00.000Z'
    comment: >-
      Implemented `implementationLink` in the ticket model and modal editor,
      with clickable display when present.
    id: c-2026-05-06t22-00-00-000z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.927Z'
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.927Z'
releaseDocPath: release-notes/v0.1.0
---
## Groomed Scope

Add a single optional field on a ticket for the primary implementation link so we can attach either a commit URL or a PR URL.

## Proposed Field

- `implementationLink: string`
- Stored as a normal ticket/frontmatter field
- Editable in the ticket modal

## Acceptance Criteria

- [x] Tickets can store an optional implementation link
- [x] The ticket editor exposes this field in a clear place
- [x] Existing tickets without a link continue to work unchanged
- [x] The link is visible and clickable when present

## Files Likely Affected

- `engine/src/index.ts`
- `portal/src/types.ts`
- `portal/src/components/TaskModal.tsx`
