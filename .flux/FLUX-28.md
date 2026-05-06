---
id: FLUX-28
title: add field for 'story points' or 'intensity'
status: Grooming
priority: None
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags: []
history:
	- type: comment
		user: Agent
		date: '2026-05-06T19:20:00.000Z'
		comment: >-
			Re-groomed as a sizing-field ticket. The main remaining decision is the
			naming and scale: classic story points, T-shirt sizes, or a custom agent
			intensity scale.
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
