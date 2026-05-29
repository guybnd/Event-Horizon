---
title: FLUX-292 (recovered)
history:
  - type: activity
    user: System
    date: '2026-05-29T00:53:44.653Z'
    comment: >-
      Auto-repaired ticket: Recovered missing title from filename → "FLUX-292
      (recovered)"
---
---
id: FLUX-292
title: Agent should be able to create branch for each feature working on
status: Grooming
priority: Medium
effort: L
assignee: unassigned
tags:
  - feature
  - engine
  - agent-workflow
  - git
  - mcp
createdBy: Guy
updatedBy: Agent
history:
  - type: agent_session
    sessionId: 8d407d15-bffa-4860-a2eb-841295854a7e
    startedAt: '2026-05-25T04:38:42.614Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T04:38:55.181Z'
        message: Reading FLUX-292.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-292.md'
      - timestamp: '2026-05-25T04:38:56.832Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: branch
            path: 'C:\GitHub\EventHorizon'
            glob: '*.{ts,tsx}'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T04:38:58.064Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T04:39:09.084Z'
        message: 'Running: ls "C:\GitHub\EventHorizon\.flux\" | grep -i 292'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: 'ls "C:\GitHub\EventHorizon\.flux\" | grep -i 292'
            description: Check if FLUX-292 exists in the .flux directory
      - timestamp: '2026-05-25T04:39:13.067Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T04:39:16.420Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\routes\tasks.ts'
      - timestamp: '2026-05-25T04:39:20.989Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: branch|worktree
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T04:39:24.719Z'
        message: Reading schema.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\schema.ts'
      - timestamp: '2026-05-25T04:39:25.983Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: implementationLink|branch
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T04:39:28.073Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T04:39:30.392Z'
        message: Reading types.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\types.ts'
      - timestamp: '2026-05-25T04:39:35.877Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: branch|featureBranch|feature.branch
            path: 'C:\GitHub\EventHorizon\engine\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T04:39:39.878Z'
        message: Reading TaskCard.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\TaskCard.tsx'
            limit: 80
      - timestamp: '2026-05-25T04:39:43.086Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T04:39:47.695Z'
        message: Reading FLUX-291.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-291.md'
      - timestamp: '2026-05-25T04:39:48.357Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: .docs/**/*.md
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-25T04:39:51.583Z'
        message: Reading ticket-model.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              C:\GitHub\EventHorizon\.docs\event-horizon\architecture\ticket-model.md
      - timestamp: '2026-05-25T04:39:55.750Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-292 2...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-292 2>/dev/null ||
              echo "ENGINE_NOT_REACHABLE"
            description: Check if engine is running and if FLUX-292 exists
      - timestamp: '2026-05-25T04:39:58.089Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T04:40:13.091Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T04:40:26.074Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: |-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-292 \
                -H "Content-Type: application/json" \
                -d "$(cat <<'EOF'
              {
                "updatedBy": "Agent",
                "priority": "Medium",
                "effort": "L",
                "tags": ["feature", "engine", "portal"],
                "body": "## Problem / Motivation\n\nAgents currently work directly on the active branch (usually `master`). When multiple agents handle separate tickets concurrently, their changes can conflict or pollute commit history. There is no mechanism to isolate work per ticket, track which branch corresponds to which ticket, or display this association in the UI.\n\nAdding per-ticket feature branches lets agents work in isolation, makes concurrent ticket execution safer, and gives users visibility into where each feature lives in git.\n\n## Implementation Plan\n\n### Part 1: Schema — add `branch` field to ticket frontmatter\n\n- Add optional `branch` field (string) to the ticket model in `portal/src/types.ts`.\n- The engine schema validator (`engine/src/schema.ts`) should accept but not require this field.\n- The field stores a branch name like `flux/FLUX-292-agent-branch-per-ticket`.\n\n### Part 2: Engine — branch lifecycle management\n\nAdd a new module `engine/src/branch-manager.ts` with:\n\n1. **`createTicketBranch(ticketId, baseBranch?)`** — creates `flux/<TICKET-ID>-<slugified-title>` from the given base (default: current branch). Stores the branch name on the ticket via `PUT /api/tasks/:id`. Uses `git checkout -b` or `git worktree add` depending on whether the caller needs isolation.\n2. **`switchToTicketBranch(ticketId)`** — checks out the ticket's branch. Verifies it exists first.\n3. **`getTicketBranch(ticketId)`** — returns the stored branch name from the ticket frontmatter.\n4. **`deleteTicketBranch(ticketId)`** — cleans up after merge/close. Only deletes if the branch has been merged.\n\nExpose via new API routes:\n- `POST /api/tasks/:id/branch` — create and associate a branch.\n- `DELETE /api/tasks/:id/branch` — remove branch association (and optionally delete the git branch).\n- `GET /api/tasks/:id/branch` — return branch info (name, exists, ahead/behind counts).\n\n### Part 3: Agent workflow integration\n\nModify the implementation skill workflow:\n- When an agent moves a ticket to `In Progress`, automatically create a feature branch if one doesn't already exist.\n- Agent commits go to the ticket's branch rather than the main branch.\n- On `finish <ticket>`, the branch info is preserved in the ticket for reference (merge strategy is left to the user — no auto-merge to master).\n\n### Part 4: Portal UI — display branch in card and full view\n\n**TaskCard.tsx:**\n- Show a small branch badge (git-branch icon + truncated branch name) below the ticket title when `task.branch` is set.\n- Clicking the badge copies the branch name to clipboard.\n\n**MetadataPanel.tsx (full view / popup):**\n- Add a \"Branch\" field row (similar to Implementation Link) showing the branch name.\n- Include a \"Create Branch\" button when no branch is set and ticket is in a workable status (Todo, In Progress).\n- Show branch status indicators (exists/deleted, ahead/behind main).\n\n**TaskModal.tsx:**\n- Display the branch name in the header area next to implementation link.\n- Add copy-to-clipboard action.\n\n### Part 5: Naming convention and safety\n\n- Branch naming: `flux/<TICKET-ID>-<slugified-title>` (max 60 chars for the slug portion).\n- Never auto-delete branches that have unmerged commits.\n- If a branch already exists (e.g., user-created), associate it without recreating.\n- The feature works in both in-repo and orphan storage modes — it operates on the main repo's git, not the flux-data worktree.\n\n### Non-goals for v1\n\n- Auto-merging branches back to main (users handle PR/merge workflow).\n- Multi-worktree parallel agent execution (future ticket).\n- Branch protection rules or PR creation.\n",
                "appendHistory": [
                  {
                    "type": "comment",
                    "user": "Agent",
                    "comment": "Groomed ticket. Added implementation plan covering schema, engine branch manager, agent workflow integration, and portal UI surfaces. Effort: L — touches schema, engine API, agent workflow, and multiple portal components. No blocking questions; the design extends the existing implementationLink pattern and uses standard git operations."
                  }
                ]
              }
              EOF
              )"
            description: Update FLUX-292 with groomed metadata and implementation plan
      - timestamp: '2026-05-25T04:40:28.097Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T04:40:30.511Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: |-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-292 \
                -H "Content-Type: application/json" \
                -d "$(cat <<'EOF'
              {
                "updatedBy": "Agent",
                "status": "Todo"
              }
              EOF
              )"
            description: Move FLUX-292 status from Grooming to Todo
      - timestamp: '2026-05-25T04:40:37.007Z'
        message: >-
          FLUX-292 is groomed and moved to `Todo`. Here's the summary of what
          was done:


          **Metadata filled:**

          - Priority: Medium

          - Effort: L (touches schema, engine API, agent workflow, and multiple
          portal components)

          - Tags: feature, engine, portal


          **Body rewritten with:**

          - **Problem/Motivation**: Agents currently work on the active branch
          with no isolation per ticket. Concurrent agent work risks conflicts
          and polluted history. No way to track which branch belongs to which
          ticket.

          - **Implementation Plan** (5 parts):
            1. Schema — add optional `branch` string field to ticket frontmatter
            2. Engine — new `branch-manager.ts` module with create/switch/get/delete operations + REST API routes
            3. Agent workflow — auto-create branch on `In Progress`, commits go to ticket branch
            4. Portal UI — branch badge on cards, branch field in metadata panel and modal
            5. Naming convention (`flux/<ID>-<slug>`) and safety rules

          No blocking questions — the design extends the existing
          `implementationLink` pattern. Status moved to **Todo**.
    user: Claude Code
    date: '2026-05-25T04:38:42.614Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T04:40:37.007Z'
  - type: comment
    user: Agent
    comment: >-
      Groomed ticket. Added implementation plan covering schema, engine branch
      manager, agent workflow integration, and portal UI surfaces. Effort: L �
      touches schema, engine API, agent workflow, and multiple portal
      components. No blocking questions; the design extends the existing
      implementationLink pattern and uses standard git operations.
    date: '2026-05-25T04:40:26.378Z'
    id: c-2026-05-25t04-40-26-378z
  - type: comment
    user: Guy
    date: '2026-05-25T05:35:43.496Z'
    comment: consider MCP workfglow
    replyTo: c-2026-05-25t04-40-26-378z
    id: c-2026-05-25t05-35-43-493z
  - type: agent_session
    sessionId: 1509e66a-d8c9-44f5-ab92-1a64c9254a72
    startedAt: '2026-05-29T00:50:02.212Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-29T00:50:02.212Z'
  - type: activity
    user: Unknown
    date: '2026-05-29T00:50:03.754Z'
    comment: Created ticket.
  - type: activity
    user: System
    date: '2026-05-29T00:50:03.754Z'
    comment: >-
      Auto-repaired ticket: Recovered missing title from filename → "FLUX-292
      (recovered)"
  - type: activity
    user: Agent
    date: '2026-05-29T00:51:45.878Z'
    comment: >-
      Updated title. Updated description. Updated tags to feature, engine,
      agent-workflow, git, mcp. Changed priority from None to Medium. Changed
      effort from None to L.
  - type: comment
    user: Agent
    comment: >-
      Re-groomed ticket after recovery. Key change from previous grooming:
      incorporated MCP tools as the primary branch management interface (per
      Guy's feedback), added Part 3 for MCP tool definitions following existing
      mcp-server.ts patterns. Effort: L � touches schema, engine module, MCP
      server, agent workflow skill, and portal UI.
    date: '2026-05-29T00:51:45.878Z'
    id: c-2026-05-29t00-51-45-878z
priority: Medium
effort: L
tags:
  - feature
  - engine
  - agent-workflow
  - git
  - mcp
updatedBy: Agent
---
## Problem / Motivation

Agents currently work directly on the active branch (usually `master`). When multiple agents handle separate tickets concurrently, their changes can conflict or pollute commit history. There is no mechanism to isolate work per ticket, track which branch corresponds to which ticket, or display this association in the UI.

Adding per-ticket feature branches lets agents work in isolation, makes concurrent ticket execution safer, and gives users visibility into where each feature lives in git.

## Implementation Plan

### Part 1: Schema � add `branch` field to ticket frontmatter

- Add optional `branch` field (string) to the ticket model in `portal/src/types.ts`.
- The engine schema validator (`engine/src/schema.ts`) should accept but not require this field.
- The field stores a branch name like `flux/FLUX-292-agent-branch-per-ticket`.

### Part 2: Engine � branch lifecycle management

Add a new module `engine/src/branch-manager.ts` with:

1. **`createTicketBranch(ticketId, baseBranch?)`** � creates `flux/<TICKET-ID>-<slugified-title>` from the given base (default: current branch). Stores the branch name on the ticket via the task store. Uses `git checkout -b`.
2. **`switchToTicketBranch(ticketId)`** � checks out the ticket's branch. Verifies it exists first.
3. **`getTicketBranch(ticketId)`** � returns the stored branch name from the ticket frontmatter.
4. **`deleteTicketBranch(ticketId)`** � cleans up after merge/close. Only deletes if the branch has been merged.

Expose via REST API routes (fallback):
- `POST /api/tasks/:id/branch` � create and associate a branch.
- `DELETE /api/tasks/:id/branch` � remove branch association (and optionally delete the git branch).
- `GET /api/tasks/:id/branch` � return branch info (name, exists, ahead/behind counts).

### Part 3: MCP tools for branch management

Add new MCP tools to `engine/src/mcp-server.ts` following the existing pattern:

- **`create_branch`** � creates and associates a feature branch with a ticket. Params: `ticketId`, `baseBranch?`. Calls `createTicketBranch()` internally.
- **`switch_branch`** � checks out the ticket's branch. Params: `ticketId`.
- **`get_branch`** � returns branch info (name, exists, ahead/behind). Params: `ticketId`.
- **`delete_branch`** � removes branch association and optionally deletes the git branch. Params: `ticketId`, `force?`.

This lets agents manage branches natively through the MCP protocol, consistent with how they already manage ticket status and comments.

### Part 4: Agent workflow integration

Modify the implementation skill (`.claude/rules/event-horizon.md`):

- When an agent moves a ticket to `In Progress`, it should use `create_branch` MCP tool to create a feature branch if one doesn't already exist.
- Agent commits go to the ticket's branch rather than the main branch.
- On `finish <ticket>`, the branch info is preserved in the ticket for reference (merge strategy is left to the user � no auto-merge to master).
- Add `create_branch` and `switch_branch` to the MCP tool table in the orchestrator skill.

### Part 5: Portal UI � display branch in card and full view

**TaskCard.tsx:**
- Show a small branch badge (git-branch icon + truncated branch name) below the ticket title when `task.branch` is set.
- Clicking the badge copies the branch name to clipboard.

**MetadataPanel.tsx (full view / popup):**
- Add a "Branch" field row showing the branch name.
- Include a "Create Branch" button when no branch is set and ticket is in a workable status.
- Show branch status indicators (exists/deleted, ahead/behind main).

**TaskModal.tsx:**
- Display the branch name in the header area next to implementation link.
- Add copy-to-clipboard action.

### Part 6: Naming convention and safety

- Branch naming: `flux/<TICKET-ID>-<slugified-title>` (max 60 chars for the slug portion).
- Never auto-delete branches that have unmerged commits.
- If a branch already exists (e.g., user-created), associate it without recreating.
- The feature works in both in-repo and orphan storage modes � it operates on the main repo's git, not the flux-data worktree.

### Non-goals for v1

- Auto-merging branches back to main (users handle PR/merge workflow).
- Multi-worktree parallel agent execution (future ticket).
- Branch protection rules or PR creation.
