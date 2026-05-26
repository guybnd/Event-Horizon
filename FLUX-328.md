---
title: Project initialization should provide basic SKILLS setup
status: Todo
priority: Medium
assignee: unassigned
tags:
  - engine
  - installer
createdBy: Guy
updatedBy: Agent
effort: S
history:
  - type: activity
    user: Guy
    date: '2026-05-26T02:24:19.105Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: f50e44fb-9420-4848-81e1-954a73c1beee
    startedAt: '2026-05-26T10:38:23.765Z'
    status: completed
    progress:
      - timestamp: '2026-05-26T10:38:35.402Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket,update_ticket,change_status,list_tickets'
            max_results: 4
      - timestamp: '2026-05-26T10:38:39.197Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T10:38:44.767Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-328 |...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-328 | python -m
              json.tool 2>/dev/null || curl -s
              http://localhost:3067/api/tasks/FLUX-328
            description: Read FLUX-328 ticket via REST API
      - timestamp: '2026-05-26T10:38:49.495Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore initialization workflow
            subagent_type: Explore
            prompt: >-
              I need to understand how project initialization works in this
              Event Horizon project, specifically around skills setup. 


              Look for:

              1. The initialization/installer workflow - likely in
              `engine/src/workflow-installer.ts` and
              `engine/src/skill-installer.ts`

              2. What skills files exist in `.flux/skills/` (bootstrap
              templates)

              3. What skills source files exist in `.docs/skills/`

              4. Any "init" or "initialize" or "setup" related code in the
              engine

              5. The config at `.flux/config.json`


              Search breadth: very thorough. Report the file paths found, what
              each does, and how skills are currently set up during
              initialization.
      - timestamp: '2026-05-26T10:38:53.103Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '**/*installer*.ts'
      - timestamp: '2026-05-26T10:38:53.644Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\config.json'
      - timestamp: '2026-05-26T10:38:54.043Z'
        message: 'Running: find "C:\GitHub\EventHorizon" -type f -name "*init...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find "C:\GitHub\EventHorizon" -type f -name "*init*" -o -name
              "*setup*" | grep -E "\.(ts|js|json)$" | head -20
      - timestamp: '2026-05-26T10:38:54.197Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T10:38:57.275Z'
        message: Reading init.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\init.ts'
      - timestamp: '2026-05-26T10:39:03.261Z'
        message: 'Running: find "C:\GitHub\EventHorizon\engine\src" -type f -...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find "C:\GitHub\EventHorizon\engine\src" -type f -name "*.ts" |
              grep -E "(docs-seeder|mcp-server|patch-ticket)" | head -10
      - timestamp: '2026-05-26T10:39:03.537Z'
        message: Reading docs-seeder.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\docs-seeder.ts'
            limit: 150
      - timestamp: '2026-05-26T10:39:06.412Z'
        message: 'Running: grep -r "skillSourcePaths\|SKILL_MODULES\|\.docs.*...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "skillSourcePaths\|SKILL_MODULES\|\.docs.*skills"
              "C:\GitHub\EventHorizon\engine\src" --include="*.ts" | head -20
      - timestamp: '2026-05-26T10:39:09.200Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T10:39:10.542Z'
        message: Reading package.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\package.json'
            limit: 80
      - timestamp: '2026-05-26T10:39:11.042Z'
        message: 'Running: grep -r "workspaceWorkflow\|installWorkspace" "C:\...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "workspaceWorkflow\|installWorkspace"
              "C:\GitHub\EventHorizon" --include="*.ts" --include="*.tsx" | head
              -20
      - timestamp: '2026-05-26T10:39:24.209Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T10:40:44.292Z'
        message: Reading bootstrap.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\bootstrap.ts'
            limit: 100
      - timestamp: '2026-05-26T10:40:52.262Z'
        message: 'Running: grep -n "installWorkspaceSkill\|fetchSkillStatus" ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -n "installWorkspaceSkill\|fetchSkillStatus"
              "C:\GitHub\EventHorizon\portal\src\api.ts"
      - timestamp: '2026-05-26T10:40:52.559Z'
        message: Reading api.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
            offset: 200
            limit: 50
      - timestamp: '2026-05-26T10:40:54.218Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T10:41:24.128Z'
        message: Reading init.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\init.ts'
      - timestamp: '2026-05-26T10:41:24.226Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T10:41:31.545Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: .docs/skills/*.md
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-26T10:41:36.333Z'
        message: Reading workspace.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\workspace.ts'
            limit: 60
      - timestamp: '2026-05-26T10:41:39.227Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T10:41:39.992Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: resolveSkillSourceRoot
            output_mode: content
            path: 'C:\GitHub\EventHorizon\engine\src\workspace.ts'
      - timestamp: '2026-05-26T10:41:43.915Z'
        message: Reading workspace.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\workspace.ts'
            offset: 135
            limit: 20
      - timestamp: '2026-05-26T10:41:54.227Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T10:42:04.460Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: |-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-328 \
                -H "Content-Type: application/json" \
                -d '{
                  "priority": "Medium",
                  "effort": "S",
                  "tags": ["engine", "installer"],
                  "body": "## Problem / Motivation\n\nWhen initializing a new project via `npx event-horizon init`, the resulting workspace has no skills source files. The `.docs/skills/` directory (containing the 4 phase skill modules) and `.flux/skills/` directory (containing the copilot instructions template) are not scaffolded into the target project.\n\nThis means:\n1. The onboarding wizard / bootstrap cannot install skills from within the new project (it relies on `resolveSkillSourceRoot()` pointing back to the Event Horizon source).\n2. Users who want to customize skills for their project have no local editable source.\n3. The skill installation step in the onboarding wizard fails if the engine is running from a different location than the EH source root.\n\nProviding basic skills files out of the box ensures new projects are self-contained and immediately functional for the agent workflow.\n\n## Implementation Plan\n\n1. **In `engine/src/init.ts`**, after the `.docs/` scaffolding step, copy the 4 skill source files from the embedded EH root into the target `.docs/skills/` directory:\n   - `event-horizon-orchestrator.md`\n   - `event-horizon-grooming.md`\n   - `event-horizon-implementation.md`\n   - `event-horizon-release.md`\n\n2. **Also copy** the bootstrap instruction template into `.flux/skills/`:\n   - `event-horizon-copilot-instructions.md`\n\n3. **Use the same pattern** as the existing EH docs copy (lines 174–184 in `init.ts`): resolve the embedded source path, check existence, copy non-fatally, log success.\n\n4. **Skip if already exists** (consistent with `.docs/` handling) — don'\''t overwrite user customizations unless `--force` is set.\n\n5. **Update the post-init guidance** to mention that skills are installed and point to the Settings → Agent Workflow for framework-specific installation."
                }'
            description: Update FLUX-328 with groomed metadata and implementation plan
      - timestamp: '2026-05-26T10:42:09.229Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T10:42:11.774Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: |-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-328 \
                -H "Content-Type: application/json" \
                -d '{
                  "status": "Todo",
                  "appendHistory": [
                    {
                      "type": "status_change",
                      "from": "Grooming",
                      "to": "Todo",
                      "user": "Agent",
                      "date": "'"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"'"
                    },
                    {
                      "type": "comment",
                      "user": "Agent",
                      "date": "'"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"'",
                      "comment": "Grooming complete. Scope is small (S effort) — copy 5 files during init using the same pattern as the existing EH docs copy. No unresolved questions."
                    }
                  ]
                }' | python -m json.tool 2>/dev/null | head -20
            description: Move FLUX-328 from Grooming to Todo
      - timestamp: '2026-05-26T10:42:24.229Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T10:42:31.221Z'
        message: >-
          Grooming complete. FLUX-328 is now in **Todo** with:


          - **Priority:** Medium

          - **Effort:** S (small — copy 5 files using an existing pattern)

          - **Tags:** engine, installer


          **Implementation plan summary:** During `npx event-horizon init`, copy
          the 4 skill source modules
          (`.docs/skills/event-horizon-{orchestrator,grooming,implementation,release}.md`)
          and the copilot instructions template
          (`.flux/skills/event-horizon-copilot-instructions.md`) into the target
          workspace, using the same non-fatal copy pattern already used for EH
          docs. Skip if files already exist (unless `--force`).
    user: Claude Code
    date: '2026-05-26T10:38:23.765Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-26T10:42:31.221Z'
  - type: activity
    user: Agent
    date: '2026-05-26T10:42:04.631Z'
    comment: Updated description. Changed effort from None to S.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-26T10:42:12.030Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-26T10:42:12.030Z'
  - type: comment
    user: Agent
    date: '2026-05-26T10:42:12.030Z'
    comment: >-
      Grooming complete. Scope is small (S effort) � copy 5 files during init
      using the same pattern as the existing EH docs copy. No unresolved
      questions.
    id: c-2026-05-26t10-42-12-030z
  - type: agent_session
    sessionId: ce1f2ab9-f96f-4258-995d-b85b7658d92d
    startedAt: '2026-05-26T10:44:01.270Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-26T10:44:01.270Z'
tokenMetadata:
  inputTokens: 494419
  outputTokens: 3388
  costUSD: 0.584765
  costIsEstimated: false
  cacheReadTokens: 470553
  cacheCreationTokens: 23189
id: FLUX-328
---
## Problem / Motivation

When initializing a new project via `npx event-horizon init`, the resulting workspace has no skills source files. The `.docs/skills/` directory (containing the 4 phase skill modules) and `.flux/skills/` directory (containing the copilot instructions template) are not scaffolded into the target project.

This means:
1. The onboarding wizard / bootstrap cannot install skills from within the new project (it relies on `resolveSkillSourceRoot()` pointing back to the Event Horizon source).
2. Users who want to customize skills for their project have no local editable source.
3. The skill installation step in the onboarding wizard fails if the engine is running from a different location than the EH source root.

Providing basic skills files out of the box ensures new projects are self-contained and immediately functional for the agent workflow.

## Implementation Plan

1. **In `engine/src/init.ts`**, after the `.docs/` scaffolding step, copy the 4 skill source files from the embedded EH root into the target `.docs/skills/` directory:
   - `event-horizon-orchestrator.md`
   - `event-horizon-grooming.md`
   - `event-horizon-implementation.md`
   - `event-horizon-release.md`

2. **Also copy** the bootstrap instruction template into `.flux/skills/`:
   - `event-horizon-copilot-instructions.md`

3. **Use the same pattern** as the existing EH docs copy (lines 174�184 in `init.ts`): resolve the embedded source path, check existence, copy non-fatally, log success.

4. **Skip if already exists** (consistent with `.docs/` handling) � don't overwrite user customizations unless `--force` is set.

5. **Update the post-init guidance** to mention that skills are installed and point to the Settings ? Agent Workflow for framework-specific installation.
