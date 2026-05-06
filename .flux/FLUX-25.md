---
id: FLUX-25
title: add commit \ PR field to ticket fields
status: Todo
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
---
## Groomed Scope

Add a single optional field on a ticket for the primary implementation link so we can attach either a commit URL or a PR URL.

## Proposed Field

- `implementationLink: string`
- Stored as a normal ticket/frontmatter field
- Editable in the ticket modal

## Acceptance Criteria

- [ ] Tickets can store an optional implementation link
- [ ] The ticket editor exposes this field in a clear place
- [ ] Existing tickets without a link continue to work unchanged
- [ ] The link is visible and clickable when present

## Files Likely Affected

- `engine/src/index.ts`
- `portal/src/types.ts`
- `portal/src/components/TaskModal.tsx`
