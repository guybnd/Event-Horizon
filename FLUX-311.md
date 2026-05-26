---
assignee: unassigned
tags:
  - feature
  - skills
  - agents
  - portal
priority: High
effort: XL
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T10:52:00.297Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 5a520436-1547-48ee-86d5-5d5958333b09
    startedAt: '2026-05-25T10:52:01.756Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T10:52:18.102Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T10:52:18.773Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:get_ticket,list_tickets,update_ticket,change_status,add_comment
            max_results: 5
      - timestamp: '2026-05-25T10:52:28.847Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-311
      - timestamp: '2026-05-25T10:52:32.164Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore skill infrastructure
            subagent_type: Explore
            prompt: >-
              I need to understand the existing skill system in this Event
              Horizon project. Specifically:


              1. What's in `.docs/skills/` and `.flux/skills/` — list files and
              read a few to understand the format

              2. How are skills currently installed? Look at
              `engine/src/skill-installer.ts` and
              `engine/src/workflow-installer.ts`

              3. How does the CLI spawn agents? Look for agent spawning logic —
              likely in engine/src/ or related files

              4. Check `.flux/config.json` for any skill-related configuration

              5. Look at `.claude/rules/` to understand how skills are loaded as
              rules/instructions for agents


              Search breadth: very thorough. Report back with a summary of the
              architecture.
      - timestamp: '2026-05-25T10:52:33.109Z'
        message: Delegating
        type: info
      - timestamp: '2026-05-25T10:52:34.312Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: .docs/skills/**/*
      - timestamp: '2026-05-25T10:52:34.761Z'
        message: 'Running: find /c/GitHub/EventHorizon/.claude/rules -type f ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/.claude/rules -type f 2>/dev/null |
              head -20
      - timestamp: '2026-05-25T10:52:34.923Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/**installer*.ts
      - timestamp: '2026-05-25T10:52:37.513Z'
        message: Reading event-horizon-release.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/.docs/skills/event-horizon-release.md
      - timestamp: '2026-05-25T10:52:47.248Z'
        message: 'Running: find /c/GitHub/EventHorizon/engine/src -name "*mcp...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/engine/src -name "*mcp*" -o -name
              "*agent*" 2>/dev/null | head -20
      - timestamp: '2026-05-25T10:52:47.327Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/**mcp*.ts
      - timestamp: '2026-05-25T10:52:48.121Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T10:52:49.943Z'
        message: Reading mcp-server.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/mcp-server.ts
      - timestamp: '2026-05-25T10:52:50.167Z'
        message: 'Running: ls -la /c/GitHub/EventHorizon/engine/src/agents/ 2...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: ls -la /c/GitHub/EventHorizon/engine/src/agents/ 2>/dev/null
      - timestamp: '2026-05-25T10:52:50.409Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/index.ts
      - timestamp: '2026-05-25T10:52:56.270Z'
        message: 'Running: grep -r "skill" /c/GitHub/EventHorizon/engine/src ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "skill" /c/GitHub/EventHorizon/engine/src --include="*.ts"
              | grep -i "load\|install\|get\|manifest" | head -20
      - timestamp: '2026-05-25T10:52:58.600Z'
        message: Reading skill.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/routes/skill.ts
      - timestamp: '2026-05-25T10:52:59.014Z'
        message: 'Running: grep -r "ProviderManifest\|manifest" /c/GitHub/Eve...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "ProviderManifest\|manifest"
              /c/GitHub/EventHorizon/engine/src/agents --include="*.ts" -A 3 -B
              1 | head -50
      - timestamp: '2026-05-25T10:53:03.118Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T10:53:07.884Z'
        message: Reading copilot.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/agents/copilot.ts
            offset: 1
            limit: 200
      - timestamp: '2026-05-25T10:53:13.861Z'
        message: 'Running: grep -r "appendPrompt" /c/GitHub/EventHorizon --in...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "appendPrompt" /c/GitHub/EventHorizon --include="*.ts"
              --include="*.tsx" | grep -v node_modules | head -30
      - timestamp: '2026-05-25T10:53:18.125Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T10:55:13.632Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore skill routes and store
            subagent_type: Explore
            prompt: >-
              I'm investigating how skills are managed in Event Horizon. I need
              to understand:


              1. Read `engine/src/routes/skill.ts` — what API endpoints exist
              for skills? Can you install from URLs?

              2. Look at the portal settings UI for skills — check
              `portal/src/components/settings/` for anything skill-related

              3. Is there any concept of a "skill store" or "skill marketplace"
              already? Search for "store", "marketplace", "install skill",
              "skill url" across the codebase

              4. How are third-party or custom skills handled? Look for any
              mechanism to add skills beyond the built-in Event Horizon ones

              5. Check if there's a skill schema/format definition anywhere


              Search breadth: very thorough. Focus on what exists TODAY for
              managing/installing skills vs. what's missing.
      - timestamp: '2026-05-25T10:55:16.877Z'
        message: Reading skill.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/routes/skill.ts
      - timestamp: '2026-05-25T10:55:17.153Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/components/settings/**
      - timestamp: '2026-05-25T10:55:18.169Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T10:55:21.293Z'
        message: Reading AgentSection.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /c/GitHub/EventHorizon/portal/src/components/settings/AgentSection.tsx
      - timestamp: '2026-05-25T10:55:21.600Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: skill
            type: ts
            output_mode: files_with_matches
            head_limit: 50
      - timestamp: '2026-05-25T10:55:25.954Z'
        message: Reading skill-installer.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/skill-installer.ts
      - timestamp: '2026-05-25T10:55:26.634Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: url|URL|fetch.*skill|remote.*skill
            type: ts
            head_limit: 0
      - timestamp: '2026-05-25T10:55:33.179Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T10:55:36.091Z'
        message: Reading api.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/src/api.ts
      - timestamp: '2026-05-25T10:55:36.567Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: skill.*path|skill.*source|remote|registry|download
            type: ts
            output_mode: content
            head_limit: 0
      - timestamp: '2026-05-25T10:55:43.099Z'
        message: 'Running: find /c/GitHub/EventHorizon/.docs/skills -type f -...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/.docs/skills -type f -name "*.md" |
              head -1 | xargs head -50
      - timestamp: '2026-05-25T10:55:43.564Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: download|fetch|import.*skill|load.*skill|add.*skill
            type: ts
            output_mode: files_with_matches
      - timestamp: '2026-05-25T10:55:48.178Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T10:55:50.536Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/agents/index.ts
      - timestamp: '2026-05-25T10:55:50.591Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/components/settings/**/*.tsx
      - timestamp: '2026-05-25T10:55:50.964Z'
        message: 'Running: find /c/GitHub/EventHorizon -name "*.schema.json" ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon -name "*.schema.json" -o -name
              "*skill*.json" | head -20
      - timestamp: '2026-05-25T10:55:56.679Z'
        message: Reading PreferencesSection.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /c/GitHub/EventHorizon/portal/src/components/settings/PreferencesSection.tsx
      - timestamp: '2026-05-25T10:55:57.259Z'
        message: 'Running: find /c/GitHub/EventHorizon -type f \( -name "*con...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon -type f \( -name "*config*.ts" -o
              -name "*config*.json" \) | grep -E "(skill|agent|plugin)" | head
              -20
      - timestamp: '2026-05-25T10:56:03.179Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T10:56:03.592Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: .flux/**
      - timestamp: '2026-05-25T10:56:03.792Z'
        message: 'Running: ls -la /c/GitHub/EventHorizon/.flux/'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: ls -la /c/GitHub/EventHorizon/.flux/
      - timestamp: '2026-05-25T10:56:18.189Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T10:56:40.403Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/.flux/config.json
      - timestamp: '2026-05-25T10:56:40.729Z'
        message: 'Running: ls -la /c/GitHub/EventHorizon/.flux/skills/'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: ls -la /c/GitHub/EventHorizon/.flux/skills/
      - timestamp: '2026-05-25T10:56:41.120Z'
        message: Reading event-horizon-copilot-instructions.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /c/GitHub/EventHorizon/.flux/skills/event-horizon-copilot-instructions.md
            limit: 100
      - timestamp: '2026-05-25T10:56:48.191Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T10:56:48.397Z'
        message: 'Running: find /c/GitHub/EventHorizon/.docs -name "*.md" -ty...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/.docs -name "*.md" -type f | xargs
              grep -l
              "custom\|extend\|plugin\|third.?party\|install.*skill\|add.*skill"
              2>/dev/null
      - timestamp: '2026-05-25T10:56:55.664Z'
        message: Reading workflow-install.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /c/GitHub/EventHorizon/.docs/event-horizon/workflow/workflow-install.md
      - timestamp: '2026-05-25T10:57:03.192Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T10:57:04.712Z'
        message: 'Running: grep -r "extend\|plugin\|custom.*skill\|add.*skill...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "extend\|plugin\|custom.*skill\|add.*skill"
              /c/GitHub/EventHorizon/.docs --include="*.md"
      - timestamp: '2026-05-25T10:57:11.989Z'
        message: Reading event-horizon-implementation.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /c/GitHub/EventHorizon/.docs/skills/event-horizon-implementation.md
            limit: 150
      - timestamp: '2026-05-25T10:57:18.193Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T10:57:23.539Z'
        message: 'Running: grep -r "custom\|extend\|plugin\|third.?party\|reg...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r
              "custom\|extend\|plugin\|third.?party\|registry\|marketplace\|store"
              /c/GitHub/EventHorizon/.flux --include="*.md" 2>/dev/null | head
              -30
      - timestamp: '2026-05-25T10:57:30.648Z'
        message: Reading event-horizon-orchestrator.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/.docs/skills/event-horizon-orchestrator.md
            limit: 200
      - timestamp: '2026-05-25T10:57:33.198Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T10:57:39.798Z'
        message: 'Running: grep -r "url\|URL\|fetch\|remote\|download" /c/Git...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "url\|URL\|fetch\|remote\|download"
              /c/GitHub/EventHorizon/engine/src/routes/skill.ts
              /c/GitHub/EventHorizon/engine/src/workflow-installer.ts
              /c/GitHub/EventHorizon/engine/src/skill-installer.ts 2>/dev/null
      - timestamp: '2026-05-25T10:57:48.206Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T10:58:26.181Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-311
            title: 'Skill Store: install, edit, and manage custom skills for agents'
            priority: Medium
            effort: L
            tags:
              - feature
              - skills
              - agents
            body: >-
              ## Problem / Motivation


              Currently, Event Horizon has 4 hardcoded skills (orchestrator,
              grooming, implementation, release) with no mechanism to add custom
              or third-party skills. Users want to extend agent behavior with
              domain-specific skills — e.g., a "code review" skill, a "testing"
              skill, or project-specific workflows — without modifying the core
              Event Horizon source.


              The existing `workflow-installer.ts` only handles built-in skills.
              There's no API for registering external skills, no URL-based
              installation, no UI for managing a skill library, and no way to
              assign custom skills to specific agent sessions.


              ## What's Needed


              A skill management system that allows users to:

              1. **Browse/discover** skills (local library + potentially remote
              sources)

              2. **Install from URLs** (raw markdown, gist, git repo)

              3. **Edit skills locally** in `.docs/skills/` with live reload

              4. **Assign skills to agents** — control which skills are included
              when spawning CLI sessions

              5. **Version and update** skills over time


              ## Open Questions (see Require Input comment)


              Architecture and scope decisions needed before implementation
              planning.
      - timestamp: '2026-05-25T10:58:33.227Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T10:58:55.033Z'
        message: >-
          Grooming complete. FLUX-311 is now in **Require Input** with 4
          architecture questions:


          1. **Scope** — local-only skill library vs. full remote registry

          2. **Assignment model** — per-ticket, per-status, global config, or
          layered

          3. **Skill format** — plain markdown with frontmatter vs. richer
          schema

          4. **UI scope** — dedicated Skills page vs. extending the existing
          Agent Section


          I've recommended starting local-first with layered assignment and
          simple markdown format. Once you answer in the ticket (or here), I'll
          finalize the implementation plan and move to Todo.
    user: Claude Code
    date: '2026-05-25T10:52:01.756Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T10:58:56.196Z'
  - type: activity
    user: Agent
    date: '2026-05-25T10:58:26.199Z'
    comment: >-
      Updated title. Updated description. Changed priority to Medium. Changed
      effort to L. Updated tags.
  - type: comment
    user: Agent
    comment: >-
      Several architecture decisions needed before planning implementation:


      1. **Scope of "skill store"** — Do you want:
         - (A) A local-only library where you author/edit skills in `.docs/skills/` and assign them to agent sessions, OR
         - (B) A full registry with remote URL installation (fetch from gists/repos/URLs), versioning, and potentially a community marketplace?
         
         Recommendation: Start with (A) — local skill library + assignment — and add URL import as a follow-up.

      2. **Skill assignment model** — How should skills be associated with
      agents?
         - (A) Per-ticket: assign skills when spawning a session (e.g., "use code-review skill for this ticket")
         - (B) Per-status: map skills to ticket statuses (like the current orchestrator routing table)
         - (C) Global config: define a default skill set in `.flux/config.json` that applies to all sessions
         - (D) All of the above with layering (global defaults + per-ticket overrides)

         Recommendation: (D) with global defaults as the primary UX.

      3. **Skill format** — Should custom skills follow the exact same format as
      built-in ones (markdown with YAML frontmatter + `<skill_module>`
      wrapping), or do you want a richer schema (JSON manifest, dependencies,
      required MCP tools, etc.)?

         Recommendation: Keep it simple — markdown with frontmatter (title, description, version, tags). The installer already handles framework-specific wrapping.

      4. **UI scope** — Do you want a dedicated "Skills" page in the portal
      settings, or just extend the existing Agent Section with skill management?


      Please answer these so I can produce a concrete implementation plan.
    date: '2026-05-25T10:58:42.879Z'
    id: c-2026-05-25t10-58-42-879z
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-25T10:58:42.879Z'
  - type: comment
    user: Guy
    date: '2026-05-25T11:22:48.737Z'
    comment: >-
      1. lets start with A


      2. we should have sort of a router when we pass each agent a command,
      telling it what available skills and isntructions are available so he can
      decide what to use


      3. lets do as you wish


      4. probably needss its own window, where we can manage the agent types and
      their prompts, and defaults per statuses and whats available per status,
      and the available skills.
    replyTo: c-2026-05-25t10-58-42-879z
    id: c-2026-05-25t11-22-48-711z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-25T11:22:48.737Z'
    comment: Response submitted
  - type: agent_session
    sessionId: e2bc2e88-8444-410e-ad9b-cd69718ced98
    startedAt: '2026-05-25T11:22:54.129Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T11:23:09.787Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket,update_ticket,change_status,add_comment'
            max_results: 4
      - timestamp: '2026-05-25T11:23:10.471Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T11:23:15.878Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Find MCP tools and docs
            subagent_type: Explore
            prompt: >-
              I need to find:

              1. The MCP tools available (get_ticket, update_ticket,
              change_status, etc.) - how they are invoked in this project

              2. The file `.docs/INDEX.md` 

              3. The file `.flux/FLUX-311.md`

              4. The file `.flux/config.json`

              5. The file `engine/src/skill-installer.ts`

              6. The directory `.docs/skills/` - what files are there


              Search in C:\GitHub\EventHorizon. Give me the full content of each
              file found.
      - timestamp: '2026-05-25T11:23:17.470Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '**/.docs/INDEX.md'
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-25T11:23:21.707Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\config.json'
      - timestamp: '2026-05-25T11:23:22.904Z'
        message: 'Running: ls -la /c/GitHub/EventHorizon/.docs/ 2>/dev/null |...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: ls -la /c/GitHub/EventHorizon/.docs/ 2>/dev/null | head -30
      - timestamp: '2026-05-25T11:23:25.474Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T11:23:27.098Z'
        message: Reading mcp-server.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.docs\event-horizon\mcp-server.md'
      - timestamp: '2026-05-25T11:23:27.856Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: get_ticket|update_ticket|change_status|create_ticket|finish_ticket
            path: 'C:\GitHub\EventHorizon\engine\src\mcp-server.ts'
            output_mode: content
            head_limit: 100
      - timestamp: '2026-05-25T11:23:30.354Z'
        message: 'Running: find /c/GitHub/EventHorizon -name "INDEX.md" -type...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: find /c/GitHub/EventHorizon -name "INDEX.md" -type f 2>/dev/null
      - timestamp: '2026-05-25T11:23:30.642Z'
        message: Reading mcp-server.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\mcp-server.ts'
            limit: 150
      - timestamp: '2026-05-25T11:23:36.449Z'
        message: 'Running: ls -la /c/GitHub/EventHorizon/.docs/skills/'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: ls -la /c/GitHub/EventHorizon/.docs/skills/
      - timestamp: '2026-05-25T11:23:40.480Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T11:25:41.126Z'
        message: Reading b4id9r22e.output
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              C:\Users\GUYRAZ~1\AppData\Local\Temp\claude\C--GitHub-EventHorizon\06bfd837-d580-4243-a2b3-43c157542410\tasks\b4id9r22e.output
      - timestamp: '2026-05-25T11:25:55.523Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T11:25:57.864Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__update_ticket,mcp__event-horizon__change_status,mcp__event-horizon__add_comment
            max_results: 4
      - timestamp: '2026-05-25T11:26:01.308Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-311
      - timestamp: '2026-05-25T11:26:01.766Z'
        message: Reading INDEX.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.docs\event-horizon\INDEX.md'
      - timestamp: '2026-05-25T11:26:08.954Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\agents\index.ts'
      - timestamp: '2026-05-25T11:26:10.524Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T11:26:15.090Z'
        message: Reading types.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\agents\types.ts'
      - timestamp: '2026-05-25T11:26:25.526Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T11:26:40.545Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T11:26:59.964Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-311
            priority: High
            effort: XL
            tags:
              - feature
              - skills
              - agents
              - portal
            body: >-
              ## Problem / Motivation


              Event Horizon has 4 hardcoded skills (orchestrator, grooming,
              implementation, release) baked into `.docs/skills/` and installed
              wholesale via `workflow-installer.ts`. There is no mechanism to
              add custom skills, no UI for managing a skill library, and no way
              to control which skills are available per status or agent type.
              Users want to extend agent behavior with domain-specific skills
              (code review, testing, project-specific workflows) without
              modifying core source.


              The current `buildInitialPrompt()` in
              `engine/src/agents/claude-code.ts` builds a static prompt with no
              skill awareness — agents get the same hardcoded instructions
              regardless of context.


              ## Implementation Plan


              ### 1. Skill Registry & Storage (Engine)


              **Files:** `engine/src/skill-store.ts` (new),
              `engine/src/routes/skills.ts` (new, replaces current `skill.ts`)


              - Define a `Skill` type: `{ id, title, description, version, tags,
              statuses: string[], source: 'builtin' | 'custom', enabled:
              boolean, filePath }`

              - On startup, scan `.docs/skills/*.md` and parse frontmatter to
              build an in-memory skill registry

              - Watch the directory for changes (live reload)

              - API endpoints:
                - `GET /api/skills` — list all skills (with filter by status, enabled, source)
                - `GET /api/skills/:id` — get skill content + metadata
                - `POST /api/skills` — create a custom skill (writes to `.docs/skills/`)
                - `PUT /api/skills/:id` — update skill content/metadata
                - `DELETE /api/skills/:id` — delete custom skill (prevent deleting builtins)
                - `PUT /api/skills/:id/toggle` — enable/disable

              ### 2. Skill Router (Engine)


              **Files:** `engine/src/skill-router.ts` (new), modify
              `engine/src/agents/claude-code.ts`


              - When spawning a session, the router resolves which skills apply
              based on:
                1. Ticket status (e.g., Grooming → grooming skill + any custom skills tagged for that status)
                2. Global defaults from config
                3. Per-agent-type overrides
              - Inject a **skill manifest** into the agent prompt: a summary
              block listing available skills with title + description so the
              agent can decide what to use

              - The full skill content is included for skills marked as "always
              inject" (like orchestrator), while others are listed as available
              references the agent can request via MCP tool


              ### 3. Agent Type Configuration (Engine + Config)


              **Files:** extend `.flux/config.json` schema,
              `engine/src/routes/agent-config.ts` (new)


              - Add an `agentTypes` section to config:
                ```json
                {
                  "agentTypes": {
                    "default": {
                      "prompt": "You are an Event Horizon agent...",
                      "defaultSkills": ["event-horizon-orchestrator"],
                      "skillsByStatus": {
                        "Grooming": ["event-horizon-grooming"],
                        "Todo": ["event-horizon-implementation"],
                        "In Progress": ["event-horizon-implementation"]
                      }
                    }
                  }
                }
                ```
              - API endpoints:
                - `GET /api/agent-config` — get agent type configurations
                - `PUT /api/agent-config` — update agent type configurations

              ### 4. Portal: Skills Management Page


              **Files:** `portal/src/components/skills/` (new directory)


              - **SkillsPage.tsx** — dedicated page accessible from nav/settings
                - List all skills (built-in greyed out / protected, custom editable)
                - Create new skill button → opens editor
                - Toggle enable/disable per skill
                - Edit skill content inline (markdown editor)
                - Show which statuses each skill is assigned to
              - **SkillEditor.tsx** — markdown editor with frontmatter form
              fields

              - **AgentConfigPanel.tsx** — manage agent types:
                - Default prompt template
                - Default skills (checkboxes)
                - Per-status skill assignment (drag/assign UI or multi-select per status column)
                - Available skills per status

              ### 5. Skill Format


              Skills remain as markdown files in `.docs/skills/` with enhanced
              frontmatter:


              ```markdown

              ---

              title: Code Review

              description: Guides agent through systematic code review

              version: 1.0.0

              tags: [review, quality]

              statuses: [In Progress, Ready]

              source: custom

              enabled: true

              inject: on-demand

              ---


              ## Phase: Code Review

              ...skill content...

              ```


              - `inject: always` — full content is always included in agent
              prompt when status matches

              - `inject: on-demand` — listed in manifest; agent can request via
              MCP tool if needed


              ### 6. MCP Tool for Skill Access


              **Files:** extend `engine/src/mcp-server.ts`


              - Add `get_available_skills` tool — returns the manifest of skills
              available for the current session

              - Add `read_skill` tool — returns full content of a specific skill
              by ID (for on-demand skills)


              ### Subtask Breakdown


              This should be split into subtasks:

              1. **Skill store + registry** (engine backend, API)

              2. **Skill router** (prompt injection logic)

              3. **Agent config schema** (config extension + API)

              4. **Portal skills page** (UI)

              5. **MCP skill tools** (get_available_skills, read_skill)

              6. **Migration** — update built-in skills with new frontmatter
              fields


              ### Dependencies & Order


              1 → 2 → 5 (backend first), 3 can parallel with 2, 4 depends on
              1+3, 6 is last.
      - timestamp: '2026-05-25T11:27:04.673Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-311
            newStatus: Todo
      - timestamp: '2026-05-25T11:27:10.551Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T11:27:13.460Z'
        message: >-
          Grooming complete. FLUX-311 is now in **Todo** with:


          - **Priority:** High

          - **Effort:** XL

          - **Tags:** feature, skills, agents, portal


          The implementation plan covers 6 work streams:

          1. Skill store & registry (engine backend + API)

          2. Skill router (resolves skills per status/agent-type, injects
          manifest into prompt)

          3. Agent type configuration (config schema + dedicated API)

          4. Portal skills management page (dedicated UI for browsing, creating,
          editing, toggling skills and configuring agent types per status)

          5. MCP tools (`get_available_skills`, `read_skill`) so agents can
          discover and load on-demand skills

          6. Migration of built-in skills to enhanced frontmatter


          This is an XL ticket — recommend splitting into subtasks before
          implementation begins.
    user: Claude Code
    date: '2026-05-25T11:22:54.129Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T11:27:14.614Z'
  - type: activity
    user: Agent
    date: '2026-05-25T11:26:59.986Z'
    comment: >-
      Updated description. Changed priority to High. Changed effort to XL.
      Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T11:27:04.687Z'
title: 'Skill Store: install, edit, and manage custom skills for agents'
status: Todo
createdBy: Guy
updatedBy: Guy
tokenMetadata:
  inputTokens: 517473
  outputTokens: 6053
  costUSD: 1.354282
  costIsEstimated: false
  cacheReadTokens: 432240
  cacheCreationTokens: 85205
order: 3
parentId: FLUX-281
---
## Problem / Motivation

Event Horizon has 4 hardcoded skills (orchestrator, grooming, implementation, release) baked into `.docs/skills/` and installed wholesale via `workflow-installer.ts`. There is no mechanism to add custom skills, no UI for managing a skill library, and no way to control which skills are available per status or agent type. Users want to extend agent behavior with domain-specific skills (code review, testing, project-specific workflows) without modifying core source.

The current `buildInitialPrompt()` in `engine/src/agents/claude-code.ts` builds a static prompt with no skill awareness — agents get the same hardcoded instructions regardless of context.

## Implementation Plan

### 1. Skill Registry & Storage (Engine)

**Files:** `engine/src/skill-store.ts` (new), `engine/src/routes/skills.ts` (new, replaces current `skill.ts`)

- Define a `Skill` type: `{ id, title, description, version, tags, statuses: string[], source: 'builtin' | 'custom', enabled: boolean, filePath }`
- On startup, scan `.docs/skills/*.md` and parse frontmatter to build an in-memory skill registry
- Watch the directory for changes (live reload)
- API endpoints:
  - `GET /api/skills` — list all skills (with filter by status, enabled, source)
  - `GET /api/skills/:id` — get skill content + metadata
  - `POST /api/skills` — create a custom skill (writes to `.docs/skills/`)
  - `PUT /api/skills/:id` — update skill content/metadata
  - `DELETE /api/skills/:id` — delete custom skill (prevent deleting builtins)
  - `PUT /api/skills/:id/toggle` — enable/disable

### 2. Skill Router (Engine)

**Files:** `engine/src/skill-router.ts` (new), modify `engine/src/agents/claude-code.ts`

- When spawning a session, the router resolves which skills apply based on:
  1. Ticket status (e.g., Grooming → grooming skill + any custom skills tagged for that status)
  2. Global defaults from config
  3. Per-agent-type overrides
- Inject a **skill manifest** into the agent prompt: a summary block listing available skills with title + description so the agent can decide what to use
- The full skill content is included for skills marked as "always inject" (like orchestrator), while others are listed as available references the agent can request via MCP tool

### 3. Agent Type Configuration (Engine + Config)

**Files:** extend `.flux/config.json` schema, `engine/src/routes/agent-config.ts` (new)

- Add an `agentTypes` section to config:
  ```json
  {
    "agentTypes": {
      "default": {
        "prompt": "You are an Event Horizon agent...",
        "defaultSkills": ["event-horizon-orchestrator"],
        "skillsByStatus": {
          "Grooming": ["event-horizon-grooming"],
          "Todo": ["event-horizon-implementation"],
          "In Progress": ["event-horizon-implementation"]
        }
      }
    }
  }
  ```
- API endpoints:
  - `GET /api/agent-config` — get agent type configurations
  - `PUT /api/agent-config` — update agent type configurations

### 4. Portal: Skills Management Page

**Files:** `portal/src/components/skills/` (new directory)

- **SkillsPage.tsx** — dedicated page accessible from nav/settings
  - List all skills (built-in greyed out / protected, custom editable)
  - Create new skill button → opens editor
  - Toggle enable/disable per skill
  - Edit skill content inline (markdown editor)
  - Show which statuses each skill is assigned to
- **SkillEditor.tsx** — markdown editor with frontmatter form fields
- **AgentConfigPanel.tsx** — manage agent types:
  - Default prompt template
  - Default skills (checkboxes)
  - Per-status skill assignment (drag/assign UI or multi-select per status column)
  - Available skills per status

### 5. Skill Format

Skills remain as markdown files in `.docs/skills/` with enhanced frontmatter:

```markdown
---
title: Code Review
description: Guides agent through systematic code review
version: 1.0.0
tags: [review, quality]
statuses: [In Progress, Ready]
source: custom
enabled: true
inject: on-demand
---

## Phase: Code Review
...skill content...
```

- `inject: always` — full content is always included in agent prompt when status matches
- `inject: on-demand` — listed in manifest; agent can request via MCP tool if needed

### 6. MCP Tool for Skill Access

**Files:** extend `engine/src/mcp-server.ts`

- Add `get_available_skills` tool — returns the manifest of skills available for the current session
- Add `read_skill` tool — returns full content of a specific skill by ID (for on-demand skills)

### Subtask Breakdown

This should be split into subtasks:
1. **Skill store + registry** (engine backend, API)
2. **Skill router** (prompt injection logic)
3. **Agent config schema** (config extension + API)
4. **Portal skills page** (UI)
5. **MCP skill tools** (get_available_skills, read_skill)
6. **Migration** — update built-in skills with new frontmatter fields

### Dependencies & Order

1 → 2 → 5 (backend first), 3 can parallel with 2, 4 depends on 1+3, 6 is last.
