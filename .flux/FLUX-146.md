---
assignee: unassigned
tags:
  - distribution
  - devx
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T03:25:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T03:25:00.000Z'
    comment: >-
      Expanded build system to cover all three distribution targets:


      **`dist:win`** added to root `package.json` — runs `package:win` (full
      build + pkg Windows exe) then zips to `event-horizon-windows.zip`.


      **`dist:all`** added to root `package.json` — runs all three in sequence:
      `dist:source`, `dist:mac`, `dist:win`.


      **`.github/workflows/release.yml`** — GitHub Actions workflow that
      triggers on any `v*.*.*` tag push. Runs on `macos-latest` (macOS runner
      cross-compiles the Windows exe via pkg without needing a Windows runner).
      Steps: `npm ci` → `dist:source` → `dist:mac` → `dist:win` → creates a
      GitHub Release with all three zips attached and auto-generated release
      notes.


      **Release process:** push a version tag (e.g. `git tag v1.1.0 && git push
      origin v1.1.0`) → Actions runs automatically → release appears on GitHub
      with all three artifacts attached.


      Ready for review. Say `finish FLUX-146` to commit and close.
    id: c-2026-05-09t03-25-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T03:25:00.000Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T03:22:10.202Z'
  - type: comment
    user: Claude Code
    date: '2026-05-09T03:22:18.413Z'
    comment: >-
      ```text

      Here's what was added:


      **`package.json` — two new scripts:**

      - `dist:win` — builds the Windows exe via `pkg` and zips it to
      `event-horizon-windows.zip`

      - `dist:all` — runs all three in sequence: `dist:source` → `dist:mac` →
      `dist:win`


      **`.github/workflows/release.yml` — GitHub Actions release workflow:**

      - Triggers automatically on any `v*.*.*` tag push

      - Runs on `macos-latest` — the macOS runner cross-compiles the Windows exe
      via `pkg`, so no Windows runner needed

      - Produces all three zips and attaches them to a GitHub Release with
      auto-generated notes


      **Release process:**

      ```bash

      git tag v1.1.0

      git push origin v1.1.0

      ```

      That's it — Actions picks it up, builds everything, and the release
      appears on GitHub with all three files.


      Ticket is back in `Ready`. Say `finish FLUX-146` when you want me to
      commit and close.

      ```
    id: c-2026-05-09t03-22-18-413z
  - type: activity
    user: Agent
    date: '2026-05-09T03:23:23.612Z'
    comment: Launched Claude Code session (d56a0aea).
title: add build script that does a clean build without dev artifacts
status: Ready
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
