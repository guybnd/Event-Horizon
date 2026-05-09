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
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T08:12:23.379Z'
    comment: >-
      Push failed with a 403 — the `guyanzu` credentials don't have access to
      `guybnd/Event-Horizon`. This is a GitHub auth issue on your machine (wrong
      account stored in the credential helper).


      A few options to fix this:

      1. **Re-authenticate** via `gh auth login` (GitHub CLI) and switch to the
      `guybnd` account

      2. **Use SSH** if you have an SSH key set up: `git remote set-url origin
      git@github.com:guybnd/Event-Horizon.git`

      3. **Update credentials** via macOS Keychain — remove the stored token for
      `github.com` and re-enter the right one


      The commit is ready locally (hash `44530b6`). What would you like to do?
  - type: comment
    user: Guy
    date: '2026-05-09T08:29:54.885Z'
    comment: try aagain
    id: c-2026-05-09t08-29-54-885z
  - type: activity
    user: Agent
    date: '2026-05-09T08:29:59.071Z'
    comment: Launched Claude Code session (0a588eeb).
  - type: activity
    user: Agent
    date: '2026-05-09T08:30:34.055Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-09T08:36:13.280Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:36:13.281Z'
    comment: >-
      Release v0.2.0 complete. Pushed to master, GitHub Release created at
      https://github.com/guybnd/Event-Horizon/releases/tag/v0.2.0 with Mac
      (event-horizon) and Windows (event-horizon.exe) binaries attached as
      release assets.
    id: c-2026-05-09t08-36-13-281z
  - type: status_change
    from: Done
    to: Archived
    user: Guy
    date: '2026-05-09T08:56:01.745Z'
title: do a release
status: Archived
createdBy: Guy
updatedBy: Guy
tokenMetadata:
  inputTokens: 7
  outputTokens: 1001
  costUSD: 0.128425
  costIsEstimated: false
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
