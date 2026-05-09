---
assignee: Agent
tags:
  - task
  - distribution
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T08:10:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-09T08:10:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:10:00.000Z'
    comment: >-
      Plan: run flux:release 0.2.0, review release notes, build Mac and Windows
      packages, commit and push.
    id: c-2026-05-09t08-10-00-000z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-09T08:08:58.413Z'
  - type: activity
    user: Agent
    date: '2026-05-09T08:08:58.413Z'
    comment: >-
      Updated description. Changed assignee from unassigned to Agent. Updated
      tags to task, distribution. Changed effort from None to S.
title: do a release
status: In Progress
createdBy: Guy
updatedBy: Agent
---
## Release v0.2.0

**Version:** 0.2.0  
**Scope:** All tickets currently in Done status  
**Builds:** Mac (x64) and Windows (x64) — no Linux

### Steps

1. Run `npm run flux:release 0.2.0` in `engine/` to generate release notes and move Done tickets to Released
2. Review generated release notes at `.docs/release-notes/0.2.0.md` — polish if needed
3. Create a git commit for the release files and ticket updates
4. Run `npm run package:mac` from repo root for the Mac binary
5. Run `npm run package:win` from repo root for the Windows binary
6. Push all changes (release doc, ticket updates, binaries) to the git repo
7. Close FLUX-151 as Done

### Validation
- Release notes exist at `.docs/release-notes/0.2.0.md`
- All previously-Done tickets now show status Released
- Mac binary: `engine/dist/event-horizon-macos`
- Windows binary: `engine/dist/event-horizon.exe`
- Changes committed and pushed to master
