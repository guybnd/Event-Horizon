---
title: persist comment read state across devices per user
status: Grooming
assignee: unassigned
tags:
  - feature
  - ux
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T17:05:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T17:05:00.000Z'
    comment: >-
      Groomed. Currently .flux/read-state.json is gitignored so it stays
      engine-local. This means a user on a second machine (different git clone)
      starts with no read state. Fix: remove .flux/read-state.json from
      .gitignore so it is committed and travels with the repo. The engine's PUT
      /api/read-state already uses a Set-union merge so concurrent commits from
      two machines will produce additive (not conflicting) diffs in almost all
      cases. The only real conflict scenario is two users both reading the same
      ticket on different branches simultaneously — standard git merge resolves
      this trivially since both sides add IDs. No code changes needed; the only
      change is removing the gitignore line.
    id: c-flux117-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T17:05:00.000Z'
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-08T04:14:33.318Z'
createdBy: Guy
updatedBy: Guy
order: 84
---

## Problem / Motivation

Comment read/unread state is stored in `.flux/read-state.json` on the engine
host. Because the file is gitignored it never leaves the local machine —
a user opening the board from a second device (different git clone) always
sees all comments as unread. For teams or individuals who work across machines
this defeats the purpose of the read-state feature.

## Implementation Plan

1. Remove `.flux/read-state.json` from `.gitignore`.
2. Commit `read-state.json` alongside normal ticket changes (it will auto-appear
   in the working tree after the first mark-read action).
3. Optionally add a note to `README.md` explaining that `read-state.json` is a
   per-user sidecar that should be committed to propagate read state across clones.

## Validation

- Mark a comment as read on machine A, commit and push.
- Pull on machine B, reload the portal — the same comment should show as read.
