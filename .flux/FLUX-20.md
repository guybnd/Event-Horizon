---
id: FLUX-20
title: add subtasks to tickets
status: Grooming
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags: []
history:
	- type: comment
		user: Agent
		date: '2026-05-06T19:20:00.000Z'
		comment: >-
			Re-groomed this into a parent/child ticket relationship proposal. This
			is close to ready, but one scope decision remains: whether subtasks are
			existing linked tickets only, or whether embedded checklist items are
			also part of the first version.
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
