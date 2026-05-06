---
id: FLUX-35
title: Separate Permanent State from Agent Reasoning
status: Todo
priority: Medium
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - architecture
  - logs
history:
  - type: comment
    user: Agent
    date: '2026-05-06T12:08:00.000Z'
    comment: >-
      Captured from Guy's request. This ticket separates durable ticket state
      from verbose agent reasoning so the repository stays readable without
      losing operational traceability.
    id: c-2026-05-06t12-08-00-000z
effort: None
implementationLink: ''
---
## Groomed Scope

Split long-form agent reasoning and transient trace output away from committed
ticket state. Ticket markdown should remain concise and durable, while deeper
reasoning can live in a log channel that the UI merges back into a single view.

## Requirements

### 1. Create a non-committed log surface
- Add a `.flux/logs/` directory for transient or verbose agent traces
- Ensure `.gitignore` excludes those log files from normal commits
- Define a naming scheme that maps log files back to ticket IDs

### 2. Separate durable and transient data
- Keep high-level summaries, decisions, and user-facing comments in the ticket `.md` file
- Redirect verbose thought traces or internal reasoning into the log file instead
- Preserve enough metadata to correlate the log and ticket safely

### 3. Merge the views in the portal
- Update the Web UI to present ticket state and logs as one coherent experience
- Distinguish permanent history from transient trace content visually
- Handle missing or pruned log files without breaking the ticket view

## Acceptance Criteria

- [ ] `.flux/logs/` exists and is ignored by git
- [ ] Verbose agent reasoning can be written to log files instead of ticket markdown
- [ ] Ticket markdown remains focused on durable, user-facing state
- [ ] The portal renders ticket state and log content together in a coherent view
- [ ] Missing log files are handled gracefully

## Likely Affected Areas

- `.gitignore`
- `engine/src/index.ts`
- `portal/src/components/TaskModal.tsx`
- `portal/src/types.ts`
- Agent workflow documentation and logging helpers

## Notes

- This ticket should be careful not to promise private chain-of-thought exposure; the feature should focus on operational traces and summaries
- Log retention and pruning policy may need a follow-up ticket
