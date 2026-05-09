---
title: Fix init default config and embed skill files in binary
status: Released
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - bug
  - distribution
priority: High
effort: S
implementationLink: 3f2c84c
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Reported two issues — archiveStatus not defaulted in init config, and
      skill source files not packaged into the binary.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed and implemented. Two related bugs both surfaced during binary
      distribution testing.

      Bug 1: `buildDefaultConfig` in `init.ts` did not include `archiveStatus:
      'Archived'` or an `Archived` column. The engine `configCache` fallback
      also lacked `archiveStatus`. Users with a fresh `init` workspace saw the
      Settings page showing all three workflow statuses (Archive, Require Input,
      Ready For Merge) as "Missing" even though the columns named "Require
      Input" and "Ready" existed.

      Bug 2: `workflow-installer.ts` resolves skill source files from
      `sourceRoot/.docs/skills/` and `sourceRoot/.flux/skills/`. When the binary
      runs against a user project, `sourceRoot = REPO_ROOT` (the user's
      workspace) — those files don't exist there, so skill install would fail
      silently.

      Plan: 1. Add `Archived` column + `archiveStatus: 'Archived'` to
      `buildDefaultConfig` in init.ts. 2. Add `archiveStatus: 'Archived'` to
      engine `configCache` default so existing workspaces missing the field get
      the correct fallback. 3. Stage `.docs/skills/` and `.flux/skills/` into
      `engine/dist/` during build. 4. Add those paths to `pkg.assets` so they
      are embedded in the binary. 5. Add `resolveSkillSourceRoot()` to index.ts
      — returns `__dirname` in pkg mode, EH repo root in dev/compiled mode. 6.
      Use `resolveSkillSourceRoot()` instead of `REPO_ROOT` as `sourceRoot` in
      `/api/skill/status` and `/api/skill/install`.
    id: c-2026-05-08-plan
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Implementation complete. All six skill files stage into engine/dist during
      build and are embedded in the binary. init.ts now writes Archived column +
      archiveStatus field. configCache default includes archiveStatus. Full
      build verified — portal assets + skill assets all staged correctly. No TS
      errors.
    id: c-2026-05-08-done
  - type: comment
    user: Guy
    date: '2026-05-08T06:53:34.411Z'
    comment: >-
      should we not include the whole ort most of the docs repository for the
      how to use the project and product?
    replyTo: c-2026-05-08-done
    id: c-2026-05-08t06-53-34-411z
  - type: status_change
    from: Ready
    to: Grooming
    user: Guy
    date: '2026-05-08T06:53:34.411Z'
    comment: Returned to work
  - type: comment
    user: Agent
    date: '2026-05-08T17:00:00.000Z'
    comment: >-
      Scope extended per Guy's question about docs: now also embeds
      `.docs/event-horizon/` tree (installation, architecture, workflow guides)
      in the binary and seeds it into new projects on `init`. Changes: build.js
      adds `.docs/event-horizon/` to staged assets; package.json adds
      `dist/.docs/event-horizon/**/*` to pkg.assets; init.ts copies embedded EH
      docs into `.docs/event-horizon/` in the new project so they appear in the
      Docs screen immediately. Binary rebuilt at 51MB and verified — all 14 EH
      doc files present in dist. Moving to Ready.
    id: c-2026-05-08-docs-scope
  - type: comment
    user: Agent
    date: '2026-05-08T17:30:00.000Z'
    comment: >-
      Completed. archiveStatus in init config + skills/EH docs embedded in
      binary and seeded on init. User confirmed.
    id: c-flux121-done
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.337Z'
order: 0
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.337Z'
releaseDocPath: release-notes/0.2.0
---

## Problem / Motivation

Two bugs that would prevent a clean user experience when installing Event Horizon into a new project:

1. **Missing `archiveStatus` in init config**: Running `event-horizon init` creates a `.flux/config.json` that includes `requireInputStatus` and `readyForMergeStatus` but omits `archiveStatus` and the corresponding `Archived` column. The Settings page shows all three workflow status slots as "Missing", requiring manual reconfiguration.

2. **Skill files not embedded in the binary**: The skill installer reads template source files from `sourceRoot/.docs/skills/` and `sourceRoot/.flux/skills/`. When the packaged binary runs against a user's project, those files don't exist there — they only live in the EH source repository. The "Install Workflow Skill" button in Settings would fail.

## Implementation

- `engine/src/init.ts`: Add `{ name: 'Archived' }` column + `archiveStatus: 'Archived'` to `buildDefaultConfig`.
- `engine/src/index.ts`: Add `archiveStatus: 'Archived'` to `configCache` defaults. Add `resolveSkillSourceRoot()`. Use it for skill API endpoints.
- `engine/scripts/build.js`: Stage `.docs/skills/` → `engine/dist/.docs/skills/` and `.flux/skills/` → `engine/dist/.flux/skills/`.
- `engine/package.json`: Add `dist/.docs/skills/**/*` and `dist/.flux/skills/**/*` to `pkg.assets`.
