---
id: FLUX-26
title: fix edit view of description in fullscreen mode
status: Done
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
			Fixed the fullscreen description editor so it now expands to a usable
			height in the main content pane instead of collapsing to a tiny field.
---
## Groomed Scope

Fix the full-screen ticket editor so entering description edit mode uses the available full-view space instead of collapsing into a small editor pane.

## Acceptance Criteria

- [x] In full-view mode, editing the description expands to the main content area
- [x] The editor remains readable on desktop without looking like a modal inside a modal
- [x] Saving or canceling returns cleanly to rendered full-view mode

## Files Likely Affected

- `portal/src/components/TaskModal.tsx`
