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
    date: '2026-05-26T13:00:03.657Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-26T13:00:15.573Z'
    comment: Updated description.
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-26T13:00:22.252Z'
  - type: agent_session
    sessionId: 420ab78f-7492-4360-af0a-3818384d05e4
    startedAt: '2026-05-26T13:07:20.663Z'
    status: completed
    progress:
      - timestamp: '2026-05-26T13:07:32.828Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:TaskCreate'
            max_results: 1
      - timestamp: '2026-05-26T13:07:36.158Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T13:07:43.332Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Get ticket FLUX-332 details
            subagent_type: Explore
            prompt: >-
              Use the get_ticket MCP tool to read ticket FLUX-332 from the Event
              Horizon ticket system. Return the full ticket content including
              frontmatter and body.
      - timestamp: '2026-05-26T13:07:44.738Z'
        message: 'Running: git log --oneline -20 && echo "---" && git status ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              git log --oneline -20 && echo "---" && git status && echo "---" &&
              ls .flux/*.md | head -20
            description: 'Check recent commits, git status, and flux tickets'
      - timestamp: '2026-05-26T13:07:51.179Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:07:56.808Z'
        message: 'Running: cat package.json 2>/dev/null | python -c "import s...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              cat package.json 2>/dev/null | python -c "import sys,json;
              d=json.load(sys.stdin); print(d.get('version','not found'))" &&
              echo "---engine---" && cat engine/package.json 2>/dev/null |
              python -c "import sys,json; d=json.load(sys.stdin);
              print(d.get('version','not found'))" 2>/dev/null || echo "no
              engine/package.json"
            description: Check current package versions
      - timestamp: '2026-05-26T13:08:06.180Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:08:17.807Z'
        message: 'Running: git tag -l | sort -V | tail -10'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git tag -l | sort -V | tail -10
            description: List git tags sorted by version
      - timestamp: '2026-05-26T13:08:21.189Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:08:28.757Z'
        message: 'Running: git show 76ff621 --stat && echo "---" && git show ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git show 76ff621 --stat && echo "---" && git show 76ff621
            description: Show details of the commit since v0.10.0
      - timestamp: '2026-05-26T13:08:36.197Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:08:48.452Z'
        message: Working
        type: tool
        data:
          toolName: TaskCreate
          parameters:
            subject: Create v0.10.1 release notes
            description: >-
              Write .docs/release-notes/v0.10.1.md covering the single commit
              since v0.10.0
      - timestamp: '2026-05-26T13:08:51.198Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T13:08:57.792Z'
        message: Working
        type: tool
        data:
          toolName: TaskUpdate
          parameters:
            taskId: '1'
            status: in_progress
            activeForm: Creating v0.10.1 release notes
      - timestamp: '2026-05-26T13:09:01.696Z'
        message: 'Running: grep -l ''status: Done'' .flux/*.md 2>/dev/null'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: 'grep -l ''status: Done'' .flux/*.md 2>/dev/null'
            description: Find Done tickets
      - timestamp: '2026-05-26T13:09:06.213Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:09:28.103Z'
        message: Reading release.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\release.ts'
      - timestamp: '2026-05-26T13:09:36.224Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T13:10:09.398Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-332 -H
              "Content-Type: application/json" -d '{"status": "In Progress"}'
              2>/dev/null || echo "API not reachable"
            description: Move FLUX-332 to In Progress via REST API
      - timestamp: '2026-05-26T13:10:13.749Z'
        message: 'Running: cd engine && npm run flux:release v0.10.1 2>&1'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: 'cd engine && npm run flux:release v0.10.1 2>&1'
            description: >-
              Run flux:release v0.10.1 to generate release notes and update
              tickets
            timeout: 30000
      - timestamp: '2026-05-26T13:10:20.465Z'
        message: 'Running: ls .flux-store/*.md 2>/dev/null | head -20 && echo...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              ls .flux-store/*.md 2>/dev/null | head -20 && echo "---" && grep
              -l 'status: Done' .flux-store/*.md 2>/dev/null
            description: Check .flux-store for Done tickets
      - timestamp: '2026-05-26T13:10:21.256Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:10:45.901Z'
        message: 'Running: ls /c/GitHub/EventHorizon/.flux/*.md | wc -l && gr...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              ls /c/GitHub/EventHorizon/.flux/*.md | wc -l && grep -l 'status:
              Done' /c/GitHub/EventHorizon/.flux/*.md 2>/dev/null
            description: Check Done tickets in correct .flux directory
      - timestamp: '2026-05-26T13:10:51.271Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:11:09.928Z'
        message: 'Running: head -20 /c/GitHub/EventHorizon/.flux/FLUX-274.md'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: head -20 /c/GitHub/EventHorizon/.flux/FLUX-274.md
            description: Read a Done ticket frontmatter
      - timestamp: '2026-05-26T13:11:21.298Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:11:25.075Z'
        message: 'Running: ls /c/GitHub/EventHorizon/.flux-store/ 2>/dev/null...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              ls /c/GitHub/EventHorizon/.flux-store/ 2>/dev/null | head -20 ||
              echo "not found"
            description: Check .flux-store at repo root
      - timestamp: '2026-05-26T13:11:29.412Z'
        message: 'Running: grep -l ''status: Done'' /c/GitHub/EventHorizon/.flu...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -l 'status: Done' /c/GitHub/EventHorizon/.flux-store/*.md
              2>/dev/null | head -20
            description: Find Done tickets in .flux-store
      - timestamp: '2026-05-26T13:11:36.314Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:11:39.992Z'
        message: 'Running: cat /c/GitHub/EventHorizon/.flux/config.json'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: cat /c/GitHub/EventHorizon/.flux/config.json
            description: Read .flux/config.json
      - timestamp: '2026-05-26T13:11:51.316Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:11:52.339Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-332 2...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-332 2>/dev/null |
              grep -o '"_path":"[^"]*"'
            description: Check engine workspace path
      - timestamp: '2026-05-26T13:12:06.327Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:12:21.330Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T13:12:32.275Z'
        message: Writing v0.10.1.md
        type: tool
        data:
          toolName: Write
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.docs\release-notes\v0.10.1.md'
            content: >
              ---

              title: Release v0.10.1

              ---

              ## Release v0.10.1


              ### Highlights


              MCP executable mode, ticket auto-repair on load, and a "Copy Fix
              Instructions" button for parse errors.


              ### Features


              **MCP Executable Mode**

              - `.mcp.json` now targets the compiled Windows executable with an
              `--mcp` flag instead of `npx tsx`

              - Engine detects `--mcp` flag at startup and redirects stdout to
              stderr before any module loads, preventing JSON-RPC frame
              corruption

              - `mcp-server.ts` auto-start guard: only fires when the file is
              the direct entry point, not when imported as a module

              - MCP and HTTP server modes are fully separated — the same
              compiled binary handles both


              **Ticket Auto-Repair on Load**

              - `task-store.ts` now attempts to repair common schema violations
              before failing validation:
                - `oldStatus`/`newStatus` → `from`/`to` rename for `status_change` history entries
                - Missing or unrecognized `type` inferred from entry shape (from/to → status_change, comment field → comment, sessionId → agent_session)
                - Malformed or missing `date` values repaired or replaced with current timestamp
                - Missing `user` field defaulted to `"Unknown"`
                - Inline subtask objects with `id` fields extracted to string IDs
                - Missing `title` derived from filename
              - Repaired tickets are written back to disk and a repair log is
              added to history

              - Only falls back to a parse error if auto-repair is insufficient


              **Parse Error — Copy Fix Instructions**

              - Parse error modal now includes a "Copy Fix Instructions" button
              per broken ticket

              - Copies a structured prompt with the file path, error
              description, expected YAML schema, and step-by-step fix
              instructions — ready to paste into an agent


              ### Improvements


              - `init.ts` copies `.docs/skills/` and `.flux/skills/` into new
              workspaces on init, making projects self-contained for the agent
              workflow without needing the EH source root


              ### Technical


              - `engine/src/index.ts`: MCP mode guard + conditional server
              startup

              - `engine/src/mcp-server.ts`: entry-point detection via
              `import.meta.url`

              - `engine/src/task-store.ts`: `repairTicket()` function,
              `repairingPaths` guard to prevent watch-loop re-entry

              - `engine/src/init.ts`: skill dir copy on workspace init

              - `portal/src/components/ParseErrorButton.tsx`:
              `buildFixInstructions()`, copy-to-clipboard button with check/copy
              icon toggle

              - `.mcp.json`: updated to use compiled exe path
      - timestamp: '2026-05-26T13:12:35.365Z'
        message: 'Running: cat /c/GitHub/EventHorizon/.docs/release-notes/v0....'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: cat /c/GitHub/EventHorizon/.docs/release-notes/v0.10.1.md
            description: 'Read existing v0.10.1 release notes (generated by flux:release)'
      - timestamp: '2026-05-26T13:12:36.340Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:12:42.749Z'
        message: Writing v0.10.1.md
        type: tool
        data:
          toolName: Write
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.docs\release-notes\v0.10.1.md'
            content: >
              ---

              title: Release v0.10.1

              ---

              ## Release v0.10.1


              ### Highlights


              MCP executable mode, ticket auto-repair on load, and a "Copy Fix
              Instructions" button for parse errors.


              ### Features


              **MCP Executable Mode**

              - `.mcp.json` now targets the compiled Windows executable with an
              `--mcp` flag instead of `npx tsx`

              - Engine detects `--mcp` flag at startup and redirects stdout to
              stderr before any module loads, preventing JSON-RPC frame
              corruption

              - `mcp-server.ts` auto-start guard: only fires when the file is
              the direct entry point, not when imported as a module

              - MCP and HTTP server modes are fully separated — the same
              compiled binary handles both


              **Ticket Auto-Repair on Load**

              - `task-store.ts` now attempts to repair common schema violations
              before failing validation:
                - `oldStatus`/`newStatus` → `from`/`to` rename for `status_change` history entries
                - Missing or unrecognized `type` inferred from entry shape (from/to → status_change, comment field → comment, sessionId → agent_session)
                - Malformed or missing `date` values repaired or replaced with current timestamp
                - Missing `user` field defaulted to `"Unknown"`
                - Inline subtask objects with `id` fields extracted to string IDs
                - Missing `title` derived from filename
              - Repaired tickets are written back to disk and a repair log is
              added to history

              - Only falls back to a parse error if auto-repair is insufficient


              **Parse Error — Copy Fix Instructions**

              - Parse error modal now includes a "Copy Fix Instructions" button
              per broken ticket

              - Copies a structured prompt with the file path, error
              description, expected YAML schema, and step-by-step fix
              instructions — ready to paste into an agent


              ### Improvements


              - `init.ts` copies `.docs/skills/` and `.flux/skills/` into new
              workspaces on init, making projects self-contained for the agent
              workflow without needing the EH source root


              ### Technical


              - `engine/src/index.ts`: MCP mode guard + conditional server
              startup

              - `engine/src/mcp-server.ts`: entry-point detection via
              `import.meta.url`

              - `engine/src/task-store.ts`: `repairTicket()` function,
              `repairingPaths` guard to prevent watch-loop re-entry

              - `engine/src/init.ts`: skill dir copy on workspace init

              - `portal/src/components/ParseErrorButton.tsx`:
              `buildFixInstructions()`, copy-to-clipboard button with check/copy
              icon toggle

              - `.mcp.json`: updated to use compiled exe path
      - timestamp: '2026-05-26T13:12:45.708Z'
        message: Reading package.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\package.json'
      - timestamp: '2026-05-26T13:12:48.511Z'
        message: Editing package.json
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\engine\package.json'
            old_string: '  "version": "0.8.0",'
            new_string: '  "version": "0.10.1",'
      - timestamp: '2026-05-26T13:12:51.348Z'
        message: Editing
        type: info
      - timestamp: '2026-05-26T13:12:52.572Z'
        message: 'Running: git -C /c/GitHub/EventHorizon status'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git -C /c/GitHub/EventHorizon status
            description: Check git status
      - timestamp: '2026-05-26T13:13:06.373Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T13:13:11.309Z'
        message: Working
        type: tool
        data:
          toolName: AskUserQuestion
          parameters:
            questions:
              - question: >-
                  Ready to push the release commit and tag v0.10.1 to origin?
                  This will trigger the GitHub Actions release workflow (builds
                  macOS + Windows executables and creates a GitHub Release).
                header: Push release
                options:
                  - label: Push now
                    description: git push && git push origin v0.10.1
                  - label: Skip push
                    description: Leave the commit and tag local only
                multiSelect: false
      - timestamp: '2026-05-26T13:13:15.713Z'
        message: >-
          Ready to push the release commit and tag `v0.10.1` to origin? This
          will trigger the GitHub Actions workflow that builds the macOS and
          Windows executables and creates a GitHub Release.


          - `git push` — push the release commit

          - `git push origin v0.10.1` — push the tag (triggers CI)
    user: Claude Code
    date: '2026-05-26T13:07:20.663Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-26T13:13:15.713Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-26T13:10:09.666Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Guy
    date: '2026-05-28T04:16:59.419Z'
title: Do release v0.10.1
status: Done
createdBy: Guy
updatedBy: Guy
order: 0
tokenMetadata:
  inputTokens: 2076093
  outputTokens: 13622
  costUSD: 1.050138
  costIsEstimated: false
  cacheReadTokens: 2017378
  cacheCreationTokens: 55810
---
with github actions release and proper changelog etc.
