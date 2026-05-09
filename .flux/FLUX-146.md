---
assignee: unassigned
tags:
  - distribution
  - devx
priority: Medium
effort: S
implementationLink: ac4b949
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T03:45:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T03:45:00.000Z'
    comment: >-
      Committed as ac4b949. Added dist:source script
      (engine/scripts/dist-source.js) that produces a clean
      event-horizon-source.zip stripped of all personal dev artifacts (FLUX-*.md
      tickets, read-state.json, .claude/, node_modules/, dist/). Also added
      dist:win, dist:all scripts, and .github/workflows/release.yml which
      auto-builds and attaches all three distribution zips to a GitHub Release
      on any v*.*.* tag push.
    id: c-2026-05-09t03-45-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T03:45:00.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T03:24:27.038Z'
  - type: activity
    user: Agent
    date: '2026-05-09T03:24:27.038Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T03:24:30.840Z'
    comment: >-
      ```text

      FLUX-146 is done. Commit `ac4b949` contains:


      - `engine/scripts/dist-source.js` — clean source zip script, strips all
      tickets, read-state, `.claude/`, `node_modules/`, etc.

      - `package.json` — `dist:source`, `dist:win`, `dist:all` scripts

      - `.github/workflows/release.yml` — auto-builds all three zips and
      attaches them to a GitHub Release on any `v*.*.*` tag push

      ```
title: add build script that does a clean build without dev artifacts
status: Done
createdBy: Guy
updatedBy: Agent
description: >-
  ## Summary


  Add a `dist:source` npm script (at root level) that produces a clean source
  distribution zip — `event-horizon-source.zip` — suitable for handing to end
  users. The zip must contain everything needed to run Event Horizon from
  source, but must strip all personal dev artifacts.


  ## What to include in the zip


  - `engine/` — full source (src/, scripts/, package.json, tsconfig if any)

  - `portal/` — full source (src/, public/, package.json, index.html,
  vite.config, tsconfig)

  - `package.json` — root workspace manifest

  - `package-lock.json` — for reproducible installs

  - `README.md` — user-facing docs

  - `.flux/config.json` — board config (column/tag/priority schema) so users get
  a sensible default board

  - `.flux/skills/` — agent workflow skill templates

  - `.flux/assets/` — if present

  - `.docs/` — all docs (skills, event-horizon, release-notes directories)


  ## What to exclude


  - `.flux/FLUX-*.md` — all personal ticket files

  - `.flux/read-state.json` — personal read-state

  - `.claude/` — dev AI config

  - `.github/`, `.vscode/`, `.idea/` — if present

  - `node_modules/` — user runs `npm install` after

  - `engine/dist/`, `portal/dist/` — build artifacts

  - `*.log`, `.DS_Store`, `.env`

  - `event-horizon-*.zip` — existing distribution zips


  ## Implementation plan


  1. Add `engine/scripts/dist-source.js` — a Node script that:
     - Defines the include/exclude rules above
     - Copies included files into a temp staging directory under `engine/dist-source/`
     - Writes a sanitised `.flux/config.json` to the staging dir (strip personal `users` array, reset to generic defaults: `[{"name": "User"}, {"name": "Agent"}]`)
     - Runs `zip -r event-horizon-source.zip dist-source/` at repo root (or uses Node `archiver` / inline zip — check if `archiver` is already available; if not, use the `zip` CLI which is available on macOS/Linux)
     - Cleans up the temp staging dir after zipping
  2. Add `"dist:source": "node engine/scripts/dist-source.js"` to root
  `package.json` scripts.

  3. Test: run `npm run dist:source`, unzip, verify tickets are absent and
  source files are present.


  ## Acceptance Criteria


  - [ ] `npm run dist:source` runs without error from the repo root

  - [ ] Output `event-horizon-source.zip` is created at repo root

  - [ ] Zip contains `engine/`, `portal/`, `package.json`, `README.md`,
  `.docs/`, `.flux/config.json`, `.flux/skills/`

  - [ ] Zip does NOT contain any `FLUX-*.md` ticket files

  - [ ] Zip does NOT contain `.flux/read-state.json`

  - [ ] Zip does NOT contain `node_modules/` or `dist/` directories

  - [ ] `.flux/config.json` inside the zip has users reset to `[{"name":
  "User"}, {"name": "Agent"}]`

  - [ ] Script is idempotent — reruns overwrite the previous zip cleanly
---
such as tickets etcc so when we provide a build zip to user it has a clean version without all the tickets and my non user facing stuff or docs etc.
