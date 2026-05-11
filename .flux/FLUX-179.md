---
assignee: Agent
tags: []
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T10:57:50.085Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-10T10:59:31.143Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-10T11:08:43.553Z'
    comment: Launched Claude Code session (9afa7c16).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T11:09:43.345Z'
  - type: comment
    user: Agent
    date: '2026-05-10T11:09:43.346Z'
    comment: >-
      Plan: (1) Rename vague/informal Done ticket titles to be
      release-note-quality. (2) Run npm run flux:release v0.3.0 to generate
      release notes and move tickets to Released. (3) Run npm run build from
      root. (4) Create GitHub release v0.3.0 via gh release create, uploading
      built binaries.
    id: c-2026-05-10t11-09-43-346z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T11:10:00.617Z'
  - type: comment
    user: Agent
    date: '2026-05-10T11:10:00.618Z'
    comment: >-
      Starting implementation: renaming vague Done ticket titles, then running
      release script, build, and GitHub release.
    id: c-2026-05-10t11-10-00-618z
  - type: activity
    user: Agent
    date: '2026-05-10T11:10:22.232Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-10T11:15:21.785Z'
  - type: comment
    user: Agent
    date: '2026-05-10T11:15:21.786Z'
    comment: >-
      Release v0.3.0 shipped. Renamed 10 vague Done ticket titles to be
      descriptive, ran flux:release v0.3.0 (14 tickets moved to Released), built
      fresh platform binaries, committed as d02d6fc, pushed to master, and
      created GitHub release at
      https://github.com/guybnd/Event-Horizon/releases/tag/v0.3.0 with macOS,
      Linux, and Windows binaries attached.
    id: c-2026-05-10t11-15-21-786z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T11:15:27.535Z'
    comment: >-
      Done. Here's the summary:


      **v0.3.0 released** —
      [https://github.com/guybnd/Event-Horizon/releases/tag/v0.3.0](https://github.com/guybnd/Event-Horizon/releases/tag/v0.3.0)


      - Renamed 10 vague ticket titles to be clean and descriptive before
      generating release notes

      - Ran `flux:release v0.3.0` — 14 tickets moved to Released

      - Rebuilt all platform binaries fresh (macOS, Linux, Windows)

      - Committed `d02d6fc` and pushed to master

      - GitHub release created with macOS, Linux, and Windows executables
      attached
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-11T05:55:56.931Z'
title: Make a new release incremental version 0.3
status: Released
createdBy: Guy
updatedBy: Agent
version: v0.3.1
releasedAt: '2026-05-11T05:55:56.931Z'
releaseDocPath: release-notes/v0.3.1
---
## Release v0.3.0

Ship the v0.3.0 release with descriptive ticket titles in the release notes, a production build, and a GitHub release upload.

### Steps

1. **Rename vague Done ticket titles** — update titles on Done tickets that are informal, contain typos, or read as user-complaint prose rather than feature/fix descriptions. Target tickets: FLUX-140, FLUX-142, FLUX-165, FLUX-166, FLUX-167, FLUX-170, FLUX-171, FLUX-175, FLUX-176, FLUX-177.

2. **Run the release script** — `npm run flux:release v0.3.0` from the engine directory. This gathers all Done tickets, writes `.docs/release-notes/v0.3.0.md`, and moves the tickets to Released.

3. **Build** — `npm run build` from the repo root to produce engine and portal production artifacts.

4. **Create GitHub release** — `gh release create v0.3.0 --title "v0.3.0" --notes-file .docs/release-notes/v0.3.0.md` and attach the built binaries from `engine/dist/`.

### Validation
- `.docs/release-notes/v0.3.0.md` exists and all ticket entries use clean, descriptive titles.
- GitHub release at guybnd/Event-Horizon shows v0.3.0 with attached artifacts.
