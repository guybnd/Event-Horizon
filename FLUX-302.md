---
assignee: unassigned
tags:
  - feature
  - portal
  - agent-integration
  - ux
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T06:07:10.074Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: bf19b4e6-08ac-4c9b-991c-903293ceb130
    startedAt: '2026-05-25T06:07:12.849Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T06:07:28.252Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__get_board_config,mcp__event-horizon__update_ticket,mcp__event-horizon__change_status,mcp__event-horizon__add_comment
            max_results: 5
      - timestamp: '2026-05-25T06:07:28.472Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T06:07:31.656Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-302
      - timestamp: '2026-05-25T06:07:43.473Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T06:07:53.054Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore installer and MCP setup
            subagent_type: Explore
            prompt: >-
              I need to understand what Event Horizon installs for agent
              integrations. Look at:

              1. `engine/src/workflow-installer.ts` - what does it install and
              where?

              2. `engine/src/skill-installer.ts` - what skills does it install?

              3. Any existing health-check or status endpoints in the engine API

              4. The portal's existing notification or status UI components


              Report: what gets installed per agent, what files/configs are
              created, and whether there's any existing health/status
              infrastructure. Be thorough - check for multiple agent types
              (Claude, Gemini, Copilot). Keep report under 300 words.
      - timestamp: '2026-05-25T06:07:55.061Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/workflow-installer.ts
      - timestamp: '2026-05-25T06:07:57.558Z'
        message: Reading workflow-installer.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:/GitHub/EventHorizon/engine/src/workflow-installer.ts'
      - timestamp: '2026-05-25T06:07:58.066Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/**/*notification*.tsx
      - timestamp: '2026-05-25T06:07:58.473Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T06:08:01.259Z'
        message: 'Running: find /c/GitHub/EventHorizon/portal/src -name "*Not...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/portal/src -name "*Notification*" -o
              -name "*Status*" -o -name "*Alert*" 2>/dev/null | head -20
      - timestamp: '2026-05-25T06:08:04.685Z'
        message: Reading sync-watcher.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:/GitHub/EventHorizon/engine/src/sync-watcher.ts'
      - timestamp: '2026-05-25T06:08:13.484Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T06:08:28.484Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T06:08:33.645Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-302
            title: >-
              Agent health notification panel — surface MCP, skills, and
              instructions installation status
            priority: Medium
            effort: M
            tags:
              - feature
              - portal
              - agent-integration
              - ux
            body: >-
              ## Problem / Motivation


              When a user sets up Event Horizon with an agent (Claude, Gemini,
              Copilot, etc.), there's no visibility into whether the
              installation is healthy — are skills files present and up-to-date?
              Is the MCP config pointing to the right server? Are instructions
              installed? If something breaks (e.g. a file gets deleted, MCP
              config is stale after an engine path change), the agent silently
              degrades with no feedback to the user.


              A notification/health panel would surface warnings proactively so
              users can fix issues before they hit a broken workflow.


              ## What Gets Checked (per agent framework)


              Each agent framework installs up to 3 categories:

              1. **Skills files** — the concatenated or modular skill markdown
              files (e.g. `.claude/rules/event-horizon.md`)

              2. **MCP configuration** — agent-specific MCP config pointing to
              `engine/src/mcp-server.ts` (e.g. `.mcp.json`,
              `.github/copilot/mcp.json`)

              3. **Instructions file** — top-level instructions reference (e.g.
              `.github/copilot-instructions.md`, `.gemini/instructions.md`)


              Health checks could verify: file exists, content hash matches
              source, MCP server entry is present and path resolves.


              ## Open Design Questions


              See Require Input comment for questions that need answers before
              implementation planning.
      - timestamp: '2026-05-25T06:08:43.498Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T06:08:52.814Z'
        message: >-
          FLUX-302 is now in **Require Input**. I've:


          1. Cleaned up the title to be descriptive

          2. Set metadata: Medium priority, M effort, tagged with `feature`,
          `portal`, `agent-integration`, `ux`

          3. Rewrote the body with problem/motivation and scope of what gets
          checked per agent

          4. Moved to Require Input with 4 concrete design questions (each with
          a default proposal)


          The key decisions needed are: where the panel lives in the UI, whether
          checks are automatic or on-demand, severity levels, and whether it
          should offer a one-click "Reinstall" fix action. Defaults are proposed
          so you can just approve or override.
    user: Claude Code
    date: '2026-05-25T06:07:12.849Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T06:08:55.950Z'
  - type: activity
    user: Agent
    date: '2026-05-25T06:08:33.657Z'
    comment: >-
      Updated title. Updated description. Changed priority to Medium. Changed
      effort to M. Updated tags.
  - type: comment
    user: Agent
    comment: >-
      Grooming identified the scope. Need answers on these design questions
      before finalizing the plan:


      1. **Where should the health panel live in the UI?**
         - Option A: A new "Notifications" bell icon in the top bar that shows a dropdown with warnings/errors (like GitHub notifications)
         - Option B: A dedicated section in the existing Settings > Agents panel that shows per-agent health status inline
         - Option C: Both — persistent status in Settings, but surface critical warnings as a badge/toast in the main UI
         - Default proposal: **Option C** — warnings are useless if you only see them when you visit Settings.

      2. **Should the health check run automatically or on-demand?**
         - Option A: Run on engine startup + periodically (every 5 min)
         - Option B: Run on engine startup + when user opens the panel
         - Option C: Real-time file watcher (fs.watch on installed paths)
         - Default proposal: **Option B** — startup + on-demand. File watchers add complexity and most issues are stable (not flapping).

      3. **What severity levels?**
         - Proposal: `error` (MCP config missing/unreachable — agent can't function), `warning` (skills outdated/hash mismatch — agent works but with stale instructions), `info` (everything healthy).

      4. **Should the panel support a "fix" action (re-install) or just
      inform?**
         - Default proposal: Show a "Reinstall" button per-agent that triggers the existing workflow-installer. Low effort since the installer already exists.
    date: '2026-05-25T06:08:45.737Z'
    id: c-2026-05-25t06-08-45-737z
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-25T06:08:45.737Z'
  - type: comment
    user: Guy
    date: '2026-05-25T06:13:25.320Z'
    comment: >-
      1. we have a pill box for the 'prompt' in yellow, we can convert it to a
      notification box. it can be adrop down panel that shows cards. for example
      each new ticket that needs input or is ready can spawn as a card there
      that clicking it takes us to it. 


      2. considering 1, lets rethink this?


      3. high level errors for skills and MCP not integrated in a agent that
      ran, yellow prompts for tickets requiring review or input, green
      notifciation for stuff that went into done. anything else you can think
      of?


      4. yes lets support actions generically here so we can elaborate on this
      further later
    replyTo: c-2026-05-25t06-08-45-737z
    id: c-2026-05-25t06-13-25-317z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-25T06:13:25.320Z'
    comment: Response submitted
title: >-
  Agent health notification panel — surface MCP, skills, and instructions
  installation status
status: Grooming
createdBy: Guy
updatedBy: Guy
tokenMetadata:
  inputTokens: 153201
  outputTokens: 2787
  costUSD: 0.286995
  costIsEstimated: false
  cacheReadTokens: 141333
  cacheCreationTokens: 11858
---
## Problem / Motivation

When a user sets up Event Horizon with an agent (Claude, Gemini, Copilot, etc.), there's no visibility into whether the installation is healthy — are skills files present and up-to-date? Is the MCP config pointing to the right server? Are instructions installed? If something breaks (e.g. a file gets deleted, MCP config is stale after an engine path change), the agent silently degrades with no feedback to the user.

A notification/health panel would surface warnings proactively so users can fix issues before they hit a broken workflow.

## What Gets Checked (per agent framework)

Each agent framework installs up to 3 categories:
1. **Skills files** — the concatenated or modular skill markdown files (e.g. `.claude/rules/event-horizon.md`)
2. **MCP configuration** — agent-specific MCP config pointing to `engine/src/mcp-server.ts` (e.g. `.mcp.json`, `.github/copilot/mcp.json`)
3. **Instructions file** — top-level instructions reference (e.g. `.github/copilot-instructions.md`, `.gemini/instructions.md`)

Health checks could verify: file exists, content hash matches source, MCP server entry is present and path resolves.

## Open Design Questions

See Require Input comment for questions that need answers before implementation planning.
