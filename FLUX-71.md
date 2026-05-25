---
assignee: unassigned
tags:
  - workflow
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: GitHub Copilot
    date: '2026-05-07T06:45:00.000Z'
    comment: Created ticket.
  - type: activity
    user: GitHub Copilot
    date: '2026-05-07T06:45:00.000Z'
    comment: Created ticket. Split out from FLUX-70.
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T07:33:44.315Z'
title: Create commit backfill mechanism for missing implementationLinks
status: Backlog
createdBy: GitHub Copilot
updatedBy: Guy
---
## Summary

Currently, many tickets that were completed in the past lack an `implementationLink` because of past workflow issues with commit tracking. We need a mechanism (like a script, command, or agent skill) that retroactively scans "Done" tickets with an empty `implementationLink` and populates them by looking at the git history for the corresponding ticket ID.

## Requirements

- Scan all `.flux/*.md` files with `status: Done` and `implementationLink: ''`.
- For each missing ticket, run a check against the local git repo (e.g., `git log --grep="FLUX-XX"`) to find the latest matching commit.
- If exactly one (or the latest) suitable commit is found, update the ticket's `implementationLink` with the hash.
- Do not overwrite any existing `implementationLink` values.
- Must be runnable manually or exposed as an admin endpoint/skill.

## Original Context
Split from FLUX-70. The primary ticket finishing instructions were fixed, but we need this utility to clean up the board history. 
