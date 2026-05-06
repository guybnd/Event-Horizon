---
id: FLUX-26
title: fix edit view of description in fullscreen mode
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

Fix the full-screen ticket editor so entering description edit mode uses the available full-view space instead of collapsing into a small editor pane.

## Acceptance Criteria

- [ ] In full-view mode, editing the description expands to the main content area
- [ ] The editor remains readable on desktop without looking like a modal inside a modal
- [ ] Saving or canceling returns cleanly to rendered full-view mode

## Files Likely Affected

- `portal/src/components/TaskModal.tsx`
