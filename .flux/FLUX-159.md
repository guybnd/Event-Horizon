---
title: Show corrupted ticket indicator in the portal UI
status: Todo
priority: Medium
effort: S
tags:
  - reliability
  - ui
createdBy: Agent
updatedBy: Agent
assignee: unassigned
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-09T08:10:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T08:10:00.000Z'
    comment: >-
      Created per FLUX-83 acceptance criteria. Originally raised by Guy in
      FLUX-83: add a view or indicator for corrupted ticket files so the user
      can instruct agent to fix or undo it.
    id: c-2026-05-09t08-10-00-000z
  - type: comment
    user: Agent
    date: '2026-05-09T07:43:06.110Z'
    comment: 'CLI test: patch-ticket correctly sets fields and appends history'
    id: c-2026-05-09t07-43-06-110z
  - type: comment
    user: Guy
    date: '2026-05-09T07:43:42.680Z'
    comment: >-
      this hsould be workplace agnostic not depend on just .flux what about a
      different project?

      or maybe im misunderstanding the workflow in this product
    id: c-2026-05-09t07-43-42-680z
  - type: activity
    user: Agent
    date: '2026-05-10T05:44:53.027Z'
    comment: Launched Claude Code session (d4dc4fa3).
  - type: activity
    user: Agent
    date: '2026-05-10T05:44:53.201Z'
    comment: Claude Code session ended with code 1.
  - type: activity
    user: Agent
    date: '2026-05-10T14:10:31.773Z'
    comment: Launched Claude Code session (edf2e10f).
  - type: activity
    user: Agent
    date: '2026-05-10T14:10:58.975Z'
    comment: Claude Code session stopped.
order: 159
---

## Summary

When a `.flux/*.md` ticket file has malformed YAML frontmatter the engine already logs `[FLUX VALIDATION ERROR]` to the terminal and drops the ticket from the cache. However the user gets no visual signal in the portal — the ticket silently disappears. This ticket adds a visible UI indicator so the user can see that a file is broken and take corrective action.

## Requirements

- The engine tracks which ticket files failed to parse (already done internally in `loadTask()`).
- Expose parse failures via a new API endpoint, e.g. `GET /api/tasks/errors`, returning `{ id, path, error }[]`.
- Add a UI indicator in the portal (board or backlog header banner, or dedicated error row) listing unparseable ticket filenames with the parse error message.
- The indicator clears automatically once the file is fixed and reloaded by the watcher.

## Likely Affected Areas

- `engine/src/index.ts`: maintain a `parseErrors` map alongside `tasksCache`; populate on `loadTask` failure; clear on success; expose via `GET /api/tasks/errors`
- `portal/src/`: add a banner or notification that reacts to `/api/tasks/errors`

## Acceptance Criteria

- [ ] Corrupted ticket file shows a visible warning in the portal with the filename and error
- [ ] Warning clears automatically when the file is fixed and the watcher reloads it
- [ ] No change to how valid tickets load or display
