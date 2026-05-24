---
title: Implement Git-Atomic Task Syncing
status: Backlog
priority: Medium
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - git
  - workflow
history:
  - type: activity
    user: Guy
    date: '2026-05-06T12:05:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-06T12:05:00.000Z'
    comment: >-
      Captured from Guy's request. This ticket covers keeping ticket state and
      code changes in lockstep at the git layer so a task's completion status is
      committed atomically with the implementation it represents.
    id: c-2026-05-06t12-05-00-000z
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-24T13:26:53.360Z'
effort: L
implementationLink: ''
order: 0
subtasks: []
---
## Groomed Scope

Implement a git-aware workflow so `.flux` ticket status changes stay bundled with
the associated code changes, especially when work is moved to `Done`.

## Requirements

### 1. Detect task-state transitions that need git coordination
- Monitor relevant `.flux` ticket files for status transitions
- Identify when a ticket moves into a completion state such as `Done`
- Associate the ticket state change with the working tree changes for that task

### 2. Assist or enforce atomic commits
- When a ticket moves to `Done`, prompt the user or workflow to stage related changes
- Include the ticket ID in the generated or suggested commit message automatically
- Prevent silent drift where the code is committed without the ticket update, or vice versa

### 3. Handle git history rewrites safely
- Detect when a `git checkout`, `git reset`, or similar operation removes the code change that justified the ticket status update
- Revert or reconcile the ticket state so the board reflects repository reality again
- Avoid corrupting unrelated ticket files during that reconciliation

## Acceptance Criteria

- [ ] Ticket status transitions to `Done` can trigger a git-aware commit flow
- [ ] Commit messages automatically include the ticket ID
- [ ] Ticket and code changes can be staged and committed together through the workflow
- [ ] Ticket status is reconciled when git history changes invalidate the completion state
- [ ] The feature does not rewrite unrelated ticket files or unrelated commits

## Likely Affected Areas

- `engine/src/index.ts`
- `engine/src/` git integration helpers or hooks
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/Settings.tsx`
- `.flux/skills/event-horizon-agent.md`

## Notes

- This may require defining whether the feature is advisory, enforced, or configurable
- Reconciliation after git reset should be careful about uncommitted local work
