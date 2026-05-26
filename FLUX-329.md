---
assignee: unassigned
tags:
  - engine
  - portal
  - reliability
  - validation
priority: High
effort: L
implementationLink: ''
subtasks:
  - FLUX-330
history:
  - type: activity
    user: Guy
    date: '2026-05-26T10:38:13.042Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 245fc159-6df7-4f6e-84b6-f9bee1985770
    startedAt: '2026-05-26T10:38:16.794Z'
    status: completed
    progress:
      - timestamp: '2026-05-26T10:38:31.171Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:get_ticket,list_tickets,update_ticket,change_status,add_comment,create_subtask,get_board_config
            max_results: 7
      - timestamp: '2026-05-26T10:38:32.811Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T10:38:43.358Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-329 2...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-329 2>/dev/null |
              head -200
            description: Get ticket FLUX-329 via REST API
      - timestamp: '2026-05-26T10:38:47.812Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T10:38:53.880Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            subagent_type: Explore
            description: Explore parse error handling
            prompt: >-
              I need to understand how Event Horizon handles parse errors in
              ticket markdown files. Look for:


              1. How tickets are parsed (look in `engine/src/` for
              markdown/frontmatter parsing logic)

              2. Any existing validation or schema validation logic for ticket
              frontmatter

              3. The portal's error display - look for "parse error" UI
              components in `portal/src/`

              4. Any existing auto-fix or repair logic


              Search broadly across both `engine/src/` and `portal/src/`
              directories. Look for keywords like "parse", "error",
              "validation", "schema", "repair", "fix", "corrupt". Also check for
              any error modal or error display component.
      - timestamp: '2026-05-26T10:38:55.314Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: 'engine/src/**/*.{ts,tsx,js,jsx}'
      - timestamp: '2026-05-26T10:39:02.276Z'
        message: Reading ParseErrorBanner.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\ParseErrorBanner.tsx'
      - timestamp: '2026-05-26T10:39:02.818Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T10:39:02.921Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: ParseError
            path: portal/src
            type: 'tsx,ts'
            output_mode: content
            head_limit: 50
      - timestamp: '2026-05-26T10:39:05.363Z'
        message: Reading api.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
      - timestamp: '2026-05-26T10:39:07.556Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: tasks/errors
            path: engine/src
            type: ts
            output_mode: content
      - timestamp: '2026-05-26T10:39:07.973Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\routes\tasks.ts'
      - timestamp: '2026-05-26T10:39:14.513Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: ParseErrorButton|ParseErrorBanner
            path: portal/src
            type: tsx
            output_mode: content
      - timestamp: '2026-05-26T10:39:17.828Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T10:39:18.753Z'
        message: Reading App.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\App.tsx'
            limit: 100
      - timestamp: '2026-05-26T10:39:28.578Z'
        message: 'Running: grep -n "fetchParseErrors\|parseErrors" "C:\GitHub...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -n "fetchParseErrors\|parseErrors"
              "C:\GitHub\EventHorizon\portal\src\AppContext.tsx" | head -30
      - timestamp: '2026-05-26T10:39:31.044Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 410
            limit: 50
      - timestamp: '2026-05-26T10:39:32.830Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T10:39:33.575Z'
        message: 'Running: grep -n "loadParseErrors" "C:\GitHub\EventHorizon\...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -n "loadParseErrors"
              "C:\GitHub\EventHorizon\portal\src\AppContext.tsx"
      - timestamp: '2026-05-26T10:39:36.461Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: repair|fix|auto-fix|recover
            path: engine/src
            type: ts
            output_mode: content
            head_limit: 50
      - timestamp: '2026-05-26T10:39:39.221Z'
        message: Reading patch-ticket.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\patch-ticket.ts'
      - timestamp: '2026-05-26T10:39:42.293Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: ConflictResolution|conflict
            path: portal/src
            type: tsx
            output_mode: files_with_matches
      - timestamp: '2026-05-26T10:39:45.008Z'
        message: Reading ConflictResolutionModal.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              C:\GitHub\EventHorizon\portal\src\components\ConflictResolutionModal.tsx
            limit: 80
      - timestamp: '2026-05-26T10:39:47.834Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T10:40:27.867Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-329 -...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-329 -X PUT -H
              "Content-Type: application/json" -d '{
                "title": "Parse error prevention: auto-fix and agent-friendly repair instructions",
                "priority": "High",
                "effort": "L",
                "tags": ["engine", "portal", "reliability", "validation"],
                "body": "## Problem / Motivation\n\nSince recent version updates, workspaces occasionally encounter parse errors in ticket files — e.g. `status_change` using `oldStatus/newStatus` instead of `from/to`, or missing required `title` field. These errors render tickets invisible on the board until manually fixed. Currently the ParseErrorButton modal shows the error but provides no actionable fix path — agents waste significant time researching file structure before they can repair a broken ticket.\n\n## Implementation Plan\n\n### Part 1: Auto-fix common schema violations on load\n\nAdd a `repairTicket()` pass in `engine/src/task-store.ts` that runs **before** validation when a ticket fails schema checks. Common auto-fixable issues:\n- `oldStatus`/`newStatus` → rename to `from`/`to` in history entries\n- Missing `title` → derive from filename (e.g. `FLUX-34.md` → `FLUX-34 (recovered)`)\n- `subtasks` containing inline objects with `id` → extract to string array\n- Malformed ISO dates → attempt to parse and re-format\n- Missing `type` on history entries that have enough shape to infer type\n\nThe repair should log what it fixed (append a history comment) and persist the corrected file. If repair fails, fall through to existing parse error flow.\n\n### Part 2: Copy-to-clipboard agent repair instructions in ParseErrorButton modal\n\nEnhance `portal/src/components/ParseErrorButton.tsx` to add a **\"Copy Fix Instructions\"** button per error that copies a pre-formatted prompt to clipboard containing:\n- The file path\n- The exact error message\n- The expected YAML frontmatter schema (field names, types, required fields)\n- A concrete example of correct structure\n- Step-by-step instructions for the agent to read the file, identify the issue, and write the fix\n\nThis eliminates the research phase agents currently endure.\n\n### Part 3 (subtask): Investigate how API/MCP writes corrupt ticket structure\n\nCreate a subtask to audit all write paths (PUT /api/tasks/:id, MCP tools) and identify how agents produce malformed YAML despite going through the API. Root-cause the recurring breakage.",
                "appendHistory": [
                  {
                    "type": "comment",
                    "user": "Agent",
                    "date": "2026-05-26T10:39:02.417Z",
                    "comment": "Groomed ticket: split into auto-fix engine logic (Part 1), copy-to-clipboard agent instructions in portal (Part 2), and investigation subtask (Part 3). Filled metadata — High priority due to recurring impact on all workspaces, L effort for the combined scope."
                  }
                ]
              }'
            description: Update FLUX-329 with groomed body and metadata
      - timestamp: '2026-05-26T10:40:32.853Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T10:40:37.522Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-329/s...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-329/subtasks -X POST
              -H "Content-Type: application/json" -d '{
                "title": "Investigate how API/MCP writes corrupt ticket YAML structure",
                "status": "Grooming",
                "priority": "Medium",
                "body": "## Problem / Motivation\n\nDespite agents using the official API and MCP tools (not editing files directly), tickets still end up with malformed YAML — e.g. `oldStatus/newStatus` instead of `from/to`, missing `title`, broken subtask arrays. This keeps recurring and needs a root-cause investigation.\n\n## Investigation Scope\n\n1. Audit all write paths in `engine/src/routes/tasks.ts` and MCP tool handlers — identify where user-supplied history entries bypass schema normalization\n2. Check if `appendHistory` accepts raw entries without validating/normalizing field names\n3. Check if any race conditions in file watching + concurrent writes can produce partial YAML\n4. Determine if the issue is agent-side (sending wrong field names) or engine-side (not normalizing input)\n5. Propose a fix: either strict input validation that rejects bad shapes, or automatic normalization on write"
              }'
            description: Create investigation subtask for FLUX-329
      - timestamp: '2026-05-26T10:40:42.993Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-329 -...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-329 -X PUT -H
              "Content-Type: application/json" -d '{
                "status": "Todo",
                "appendHistory": [
                  {
                    "type": "status_change",
                    "from": "Grooming",
                    "to": "Todo",
                    "user": "Agent",
                    "date": "2026-05-26T10:40:55.331Z"
                  }
                ]
              }'
            description: Move FLUX-329 status to Todo
      - timestamp: '2026-05-26T10:40:47.865Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T10:40:49.127Z'
        message: >-
          FLUX-329 is now groomed and moved to **Todo**. Here's a summary of
          what was done:


          **Title:** Parse error prevention: auto-fix and agent-friendly repair
          instructions


          **Metadata filled:**

          - Priority: High (recurring impact across all workspaces)

          - Effort: L (three-part scope)

          - Tags: engine, portal, reliability, validation


          **Implementation plan structured into 3 parts:**

          1. **Auto-fix engine logic** — Add `repairTicket()` in `task-store.ts`
          that normalizes common schema violations (oldStatus→from, missing
          title, inline subtasks, etc.) before validation fails

          2. **Copy-to-clipboard agent instructions** — Enhance the
          ParseErrorButton modal with a button that copies a complete,
          actionable repair prompt (schema, examples, steps) so agents don't
          waste time researching

          3. **Investigation subtask (FLUX-330 created)** — Audit API/MCP write
          paths to root-cause why agents produce malformed YAML despite using
          the official API
    user: Claude Code
    date: '2026-05-26T10:38:16.794Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-26T10:40:49.127Z'
  - type: activity
    user: Agent
    date: '2026-05-26T10:40:28.042Z'
    comment: >-
      Updated title. Updated description. Updated tags to engine, portal,
      reliability, validation. Changed priority from None to High. Changed
      effort from None to L.
  - type: comment
    user: Agent
    date: '2026-05-26T10:40:28.042Z'
    comment: >-
      Groomed ticket: split into auto-fix engine logic (Part 1),
      copy-to-clipboard agent instructions in portal (Part 2), and investigation
      subtask (Part 3). Filled metadata � High priority due to recurring impact
      on all workspaces, L effort for the combined scope.
    id: c-2026-05-26t10-40-28-042z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-26T10:40:43.144Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-26T10:40:43.144Z'
title: 'Parse error prevention: auto-fix and agent-friendly repair instructions'
status: Todo
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 221044
  outputTokens: 2736
  costUSD: 0.58786
  costIsEstimated: false
  cacheReadTokens: 187673
  cacheCreationTokens: 33359
id: FLUX-329
---
## Problem / Motivation

Since recent version updates, workspaces occasionally encounter parse errors in ticket files � e.g. `status_change` using `oldStatus/newStatus` instead of `from/to`, or missing required `title` field. These errors render tickets invisible on the board until manually fixed. Currently the ParseErrorButton modal shows the error but provides no actionable fix path � agents waste significant time researching file structure before they can repair a broken ticket.

## Implementation Plan

### Part 1: Auto-fix common schema violations on load

Add a `repairTicket()` pass in `engine/src/task-store.ts` that runs **before** validation when a ticket fails schema checks. Common auto-fixable issues:
- `oldStatus`/`newStatus` ? rename to `from`/`to` in history entries
- Missing `title` ? derive from filename (e.g. `FLUX-34.md` ? `FLUX-34 (recovered)`)
- `subtasks` containing inline objects with `id` ? extract to string array
- Malformed ISO dates ? attempt to parse and re-format
- Missing `type` on history entries that have enough shape to infer type

The repair should log what it fixed (append a history comment) and persist the corrected file. If repair fails, fall through to existing parse error flow.

### Part 2: Copy-to-clipboard agent repair instructions in ParseErrorButton modal

Enhance `portal/src/components/ParseErrorButton.tsx` to add a **"Copy Fix Instructions"** button per error that copies a pre-formatted prompt to clipboard containing:
- The file path
- The exact error message
- The expected YAML frontmatter schema (field names, types, required fields)
- A concrete example of correct structure
- Step-by-step instructions for the agent to read the file, identify the issue, and write the fix

This eliminates the research phase agents currently endure.

### Part 3 (subtask): Investigate how API/MCP writes corrupt ticket structure

Create a subtask to audit all write paths (PUT /api/tasks/:id, MCP tools) and identify how agents produce malformed YAML despite going through the API. Root-cause the recurring breakage.
