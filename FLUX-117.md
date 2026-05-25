---
title: Persist comment read state across devices per user
status: Backlog
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
  - type: agent_session
    sessionId: a6a7bca7-4fe6-4b05-a67d-1ef7eaaca0bf
    startedAt: '2026-05-19T04:01:35.836Z'
    status: completed
    progress:
      - timestamp: '2026-05-19T04:01:51.216Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-19T04:01:58.796Z'
        message: >-
          The ticket file doesn't exist at the expected path. Let me check
          what's in the `.flux/` directory and look at the README.
        type: text
      - timestamp: '2026-05-19T04:02:21.366Z'
        message: >-
          Now I have a clear picture. I need to:

          1. Create the ticket file `.flux/FLUX-117.md` and move it to In
          Progress

          2. Remove `.flux/read-state.json` from `.gitignore`

          3. Add README documentation about read-state.json being committed


          Let me create the ticket and start implementing:
        type: text
      - timestamp: '2026-05-19T04:02:26.180Z'
        message: >-
          Now let me verify the `.gitignore` looks clean and add the README
          documentation:
        type: text
      - timestamp: '2026-05-19T04:02:36.216Z'
        message: Responding
        type: info
      - timestamp: '2026-05-19T04:02:38.933Z'
        message: >-
          Good, `.gitignore` is clean. Now let me add documentation to the
          README about `read-state.json`:
        type: text
      - timestamp: '2026-05-19T04:02:43.861Z'
        message: >-
          Now let me verify the changes look correct and update the ticket to
          Ready:
        type: text
      - timestamp: '2026-05-19T04:02:53.312Z'
        message: >-
          The `.gitignore` and `README.md` changes look correct. The
          `engine/src/agents/copilot.ts` change is pre-existing and unrelated.
          Let me move the ticket to Ready:
        type: text
      - timestamp: '2026-05-19T04:02:57.121Z'
        message: >-
          Done. FLUX-117 is now **Ready** for review.


          **Changes made:**

          1. **`.gitignore`** — Removed the `.flux/read-state.json` line so the
          file can be committed

          2. **`README.md`** — Added a "Read State" subsection under Config
          Reference explaining that `read-state.json` is committed to sync
          read/unread state across devices


          No engine code changes were needed — the existing Set-union merge
          strategy handles concurrent updates cleanly.
        type: text
    user: Copilot CLI
    date: '2026-05-19T04:01:35.836Z'
    outcome: Copilot CLI session ended with code 0.
    endedAt: '2026-05-19T04:02:57.121Z'
  - type: comment
    user: Copilot CLI
    date: '2026-05-19T04:02:57.121Z'
    comment: >-
      Done. FLUX-117 is now **Ready** for review.


      **Changes made:**

      1. **`.gitignore`** — Removed the `.flux/read-state.json` line so the file
      can be committed

      2. **`README.md`** — Added a "Read State" subsection under Config
      Reference explaining that `read-state.json` is committed to sync
      read/unread state across devices


      No engine code changes were needed — the existing Set-union merge strategy
      handles concurrent updates cleanly.
    id: c-2026-05-19t04-02-57-121z
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T05:36:26.598Z'
createdBy: Guy
updatedBy: Guy
order: 84
---

## Summary
Comment read/unread state is currently stored locally in `.flux/read-state.json` and gitignored. This prevents read state from syncing across devices for the same user. By committing this file to the repository, read state can travel with the repo seamlessly.

## Requirements

### 1. Sync Read State via Git
- Remove `.flux/read-state.json` from the project's `.gitignore`.
- Allow the file to be committed and pushed to the repository alongside normal ticket changes.
- Add documentation in `README.md` explaining that `read-state.json` is meant to be committed to propagate read states.

## Acceptance Criteria
- [ ] `.flux/read-state.json` is removed from `.gitignore`.
- [ ] The read state file can be committed and merged cleanly (existing engine logic already uses a Set-union merge).

## Likely Affected Areas
- `.gitignore`
- `.flux/README.md` (or main project README)

## Notes
- Guy moved this back to grooming, possibly to formalize the ticket structure. The proposed solution is simple and requires no engine code changes.

## Original Request
persist comment read state across devices per user
