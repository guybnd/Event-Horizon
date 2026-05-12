---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T08:26:02.067Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T10:26:59.166Z'
    comment: Launched Claude Code session (fc738183).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-10T10:29:25.615Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:29:25.615Z'
    comment: >-
      Grooming complete. Plan: update 3001→3067 and 5173→5167 in:
      engine/src/index.ts (3 spots), engine/src/index.js (1 spot),
      engine/src/init.ts (1 spot), portal/vite.config.ts (1 spot), README.md (3
      spots), .docs/ (3 files), .flux/skills/event-horizon-agent.md,
      .docs/skills/event-horizon-orchestrator.md, .github/skills/ (2 files),
      engine/.event-horizon/skills/. Also update settings.local.json allowlist
      curl URLs. Skip engine/dist (generated) and .flux/FLUX-*.md tickets
      (historical). Effort: XS.
    id: c-2026-05-10t10-29-25-615z
  - type: activity
    user: Agent
    date: '2026-05-10T10:29:32.652Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-10T10:40:51.752Z'
    comment: Launched Claude Code session (99500cfd).
  - type: activity
    user: Agent
    date: '2026-05-10T10:42:47.516Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T10:42:55.240Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:42:55.241Z'
    comment: >-
      Implementation complete. Changed default ports from 3001→3067 (engine) and
      5173→5167 (portal dev server) across: engine/src/index.ts (already done),
      engine/src/index.js, engine/src/init.ts, portal/vite.config.ts (added
      port:5167 + proxy target was already 3067), README.md (3 refs),
      .docs/event-horizon/configuration.md,
      .docs/event-horizon/architecture/overview.md,
      .docs/event-horizon/installation.md,
      .docs/skills/event-horizon-orchestrator.md,
      .github/skills/event-horizon/orchestrator.md,
      .github/skills/event-horizon/SKILL.md,
      engine/.event-horizon/skills/event-horizon.md,
      .flux/skills/event-horizon-agent.md, .claude/rules/event-horizon.md,
      .claude/settings.local.json (all curl allowlist entries). Verified no
      localhost:3001 or localhost:5173 references remain outside historical
      ticket files and node_modules/dist.
    id: c-2026-05-10t10-42-55-241z
  - type: activity
    user: Agent
    date: '2026-05-10T10:43:00.131Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-10T10:44:26.528Z'
    comment: they still dont have same width
    id: c-2026-05-10t10-44-26-524z
  - type: activity
    user: Agent
    date: '2026-05-10T10:46:28.539Z'
    comment: Launched Claude Code session (1469341a).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T10:46:54.645Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:46:54.646Z'
    comment: >-
      Commit 872720b. Changed default ports from 3001→3067 (engine) and
      5173→5167 (portal) across engine/src/index.js, engine/src/init.ts,
      portal/vite.config.ts, README.md, all .docs/ pages, and all skill file
      copies. No localhost:3001 or localhost:5173 refs remain outside historical
      ticket files.
    id: c-2026-05-10t10-46-54-646z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:46:56.568Z'
    comment: >-
      FLUX-175 is done. Commit `872720b` — default ports are now `3067` (engine)
      and `5167` (portal) across all config files, docs, and skill copies.
  - type: activity
    user: Agent
    date: '2026-05-10T11:10:22.232Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.937Z'
title: Change default dev server ports to 3067 (engine) and 5167 (portal)
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 802401
  outputTokens: 7829
  costUSD: 0.449305
  costIsEstimated: false
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.937Z'
releaseDocPath: release-notes/v0.3.0
---
and engine.. 3001 and 5173 are too common. we shold have 3067 and 5167 as default. need to update the config files, docs, readme, etc. think if i missed something too.
session)

      - **README.md** — 3 references updated (`3001`→`3067`, `5173`→`5167`)

      - **`.docs/` docs** — configuration.md, architecture/overview.md,
      installation.md

      - **All skill file copies** — `.docs/skills/`, `.github/skills/`,
      `engine/.event-horizon/skills/`, `.flux/skills/`, `.claude/rules/`

      - **`.claude/settings.local.json`** — all curl allowlist entries updated


      Ticket FLUX-175 is now `Ready`.
title: Change default dev server ports to 3067 (engine) and 5167 (portal)
status: Ready
createdBy: Guy
updatedBy: Agent
---
and engine.. 3001 and 5173 are too common. we shold have 3067 and 5167 as default. need to update the config files, docs, readme, etc. think if i missed something too.
