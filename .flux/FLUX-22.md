---
id: FLUX-22
title: editable fields in kanban card
status: Todo
priority: Medium
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

Support inline editing for the fields already visible on the kanban card so quick changes do not require opening the ticket modal.

## First Version Fields

- Title
- Assignee
- Priority
- Tags

Status is already editable elsewhere and can stay out of scope for this ticket if needed.

## Acceptance Criteria

- [ ] Each visible card field can be edited inline from the board
- [ ] Inline controls do not accidentally open the full ticket modal
- [ ] Saving an inline edit persists immediately and refreshes the board state
- [ ] Inline editing works without breaking drag-and-drop interactions

## Files Likely Affected

- `portal/src/components/TaskCard.tsx`
- `portal/src/api.ts`
