---
assignee: unassigned
tags:
  - bug
  - workflow
  - mvp
priority: Medium
effort: S
implementationLink: 7c63adfbaff730d1a724f5b6c0867bd2f9a38a83
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:12:38.491Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: In Progress
    user: GitHub Copilot
    date: '2026-05-07T06:55:00.000Z'
  - type: activity
    user: GitHub Copilot
    date: '2026-05-07T07:05:00.000Z'
    comment: >-
      Added `autoRegisterUnknownTags` into engine `api/tasks` endpoints (POST
      and PUT) to update `config.json` dynamically when a ticket contains new
      tags, satisfying all logic requirements.
  - type: status_change
    from: In Progress
    to: Ready
    user: GitHub Copilot
    date: '2026-05-07T07:05:01.000Z'
  - type: activity
    user: GitHub Copilot
    date: '2026-05-07T07:15:00.000Z'
    comment: >-
      Finalization triggered. Included startup watcher scan hook as requested
      via comments. Committing and closing.
  - type: status_change
    from: Ready
    to: Done
    user: GitHub Copilot
    date: '2026-05-07T07:15:01.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.981Z'
id: FLUX-68
title: Auto-register unknown tags into project settings
status: Released
createdBy: Guy
updatedBy: GitHub Copilot
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.981Z'
releaseDocPath: release-notes/v0.1.0
---
## Summary

When an agent (or manual edit) assigns tags to a ticket that don't exist in
`.flux/config.json`, those tags silently become invisible to filters, sorting,
and the Settings tag manager. The engine should auto-register unknown tags into
the project config so they are immediately usable across the portal.

## Requirements

### 1. Detect unknown tags on ticket save
- When a ticket is created or updated via the engine API, compare the ticket's `tags` array against the configured tags in `config.json`
- Identify any tags that exist on the ticket but are not registered in `config.json`

### 2. Auto-register new tags into config
- For each unknown tag, append it to the `tags` array in `config.json` with a default neutral color scheme
- Persist the updated config so the new tags appear immediately in Settings, filters, and sort options
- Do not duplicate tags that already exist in config (case-insensitive match)

### 3. Keep existing tags untouched
- Do not modify color, name, or order of tags that are already registered
- Only append new entries — never remove or reorder existing ones
- The auto-registration should be idempotent (saving the same ticket twice doesn't create duplicates)

## Acceptance Criteria

- [ ] Saving a ticket with an unregistered tag auto-adds that tag to `config.json`
- [ ] Newly registered tags appear in the filter/sort dropdowns without manual Settings edits
- [ ] Newly registered tags get a sensible default color
- [ ] Already-registered tags are not duplicated or modified
- [ ] The behavior works for both `POST /api/tasks` and `PUT /api/tasks/:id`

## Likely Affected Areas

- `engine/src/index.ts` (task create and update handlers)
- `.flux/config.json` (schema — no changes, just runtime writes)

## Notes

- This could also apply to other entity types (priorities, users) in the future, but tags are the immediate pain point
- A similar pattern could be useful for statuses if agents ever set non-configured statuses

## Original Request
when agent adds nonexisting tags they do not get added to project settings, therefore they are unrecognized by filters and sorting etc.
