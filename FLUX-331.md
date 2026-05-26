---
assignee: unassigned
tags:
  - mcp
  - bug
  - packaging
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-26T12:32:37.152Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 4c941b1b-5fb2-42f5-bedb-a482faac5206
    startedAt: '2026-05-26T12:32:38.235Z'
    status: completed
    progress:
      - timestamp: '2026-05-26T12:32:50.554Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:TaskGet,TaskUpdate'
            max_results: 2
      - timestamp: '2026-05-26T12:32:52.284Z'
        message: Reading .mcp.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.mcp.json'
      - timestamp: '2026-05-26T12:32:53.802Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T12:32:57.290Z'
        message: Reading init.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\init.ts'
      - timestamp: '2026-05-26T12:32:57.774Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/mcp*.ts
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-26T12:33:01.839Z'
        message: Reading mcp-server.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\mcp-server.ts'
      - timestamp: '2026-05-26T12:33:08.804Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T12:33:10.964Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/server.ts
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-26T12:33:14.538Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\index.ts'
      - timestamp: '2026-05-26T12:33:23.810Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T12:33:59.818Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/package.json
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-26T12:34:03.391Z'
        message: Reading package.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\package.json'
      - timestamp: '2026-05-26T12:34:07.713Z'
        message: Reading package-release.js
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\scripts\package-release.js'
      - timestamp: '2026-05-26T12:34:08.833Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T12:35:06.210Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:update_ticket,change_status'
            max_results: 2
      - timestamp: '2026-05-26T12:35:08.848Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T12:35:12.479Z'
        message: 'Running: cd C:/GitHub/EventHorizon && cat .mcp.json'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: 'cd C:/GitHub/EventHorizon && cat .mcp.json'
            description: Check MCP config
      - timestamp: '2026-05-26T12:35:17.315Z'
        message: 'Running: cd C:/GitHub/EventHorizon && curl -s http://localh...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              cd C:/GitHub/EventHorizon && curl -s
              http://localhost:3067/api/health 2>&1
            description: Check if engine is running
      - timestamp: '2026-05-26T12:35:23.855Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T12:35:35.408Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: |-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-331 \
                -H "Content-Type: application/json" \
                -d '{
                  "priority": "High",
                  "effort": "S",
                  "tags": ["mcp", "bug", "packaging"],
                  "body": "## Problem / Motivation\n\nCustomers using the packaged Windows exe (`event-horizon-win-v0.10.0.exe`) report that MCP tools never register in their agent (Claude Code). The root cause: the exe has a single entry point (`dist/index.js` → `index.ts`) that unconditionally starts the HTTP Express server on port 3067. It does **not** detect the `--mcp` flag and never routes to `mcp-server.ts`. Startup logs are printed to **stdout**, which corrupts the JSON-RPC framing — Claude Code sees log lines instead of a valid `initialize` response and the MCP channel fails silently.\n\nThe separate `mcp-server.ts` module (which correctly redirects `console.log → console.error` to keep stdout clean) is compiled to `dist/mcp-server.js` but is not reachable from the packaged binary because `pkg` only bundles the `bin` entry point (`dist/index.js`).\n\n## Implementation Plan\n\n1. **Add `--mcp` flag detection in `engine/src/index.ts`**: At the top of `index.ts`, before importing Express/routes, check `process.argv.includes(\"--mcp\")`. If true, dynamically import `./mcp-server.js` and call `startMcpServer()`, then return — skip the HTTP server entirely.\n2. **Verify stdout is clean in MCP mode**: `mcp-server.ts` already overrides `console.log → console.error` at line 29. Confirm that happens before any log output (workspace activation, doc loading) so no startup text reaches stdout.\n3. **Ensure `mcp-server.ts` is not a separate pkg entry**: The build already compiles it to `dist/mcp-server.js` and the `bin` is `dist/index.js`. The dynamic import approach means it is reachable without adding a second pkg binary.\n4. **Rebuild and smoke-test**: Run `npm run package:win` and test `event-horizon-win-*.exe --mcp --workspace <path>` by piping a minimal MCP `initialize` request on stdin and confirming a valid JSON-RPC response on stdout.\n5. **Update `.mcp.json` comment / docs if needed**: Current config already passes `--mcp` — no change needed if the fix is purely in `index.ts`."
                }' 2>&1
            description: 'Update FLUX-331 with groomed body, priority, effort, tags'
      - timestamp: '2026-05-26T12:35:38.856Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T12:35:39.971Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: |-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-331 \
                -H "Content-Type: application/json" \
                -d '{"status": "Todo"}' 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\"status\"), d.get(\"title\"))"
            description: Move FLUX-331 to Todo status
      - timestamp: '2026-05-26T12:35:53.871Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T12:35:54.483Z'
        message: >-
          FLUX-331 is groomed and moved to **Todo**. Here's what was captured:


          **Root cause identified:**

          - The packaged exe uses `dist/index.js` as its only entry point, which
          unconditionally starts the HTTP Express server — it never reads the
          `--mcp` flag

          - `mcp-server.ts` (which correctly routes stdout→stderr to keep the
          JSON-RPC channel clean) is compiled but unreachable from the binary

          - Result: startup logs flood stdout, corrupting the MCP `initialize`
          handshake


          **Ticket set to:**

          - Priority: **High**

          - Effort: **S**

          - Tags: `mcp`, `bug`, `packaging`


          **Implementation plan in body:**

          1. Add `--mcp` flag detection at the top of `index.ts` — if set,
          dynamically import `mcp-server.js` and call `startMcpServer()`, skip
          HTTP server

          2. Verify stdout stays clean (the `console.log` override in
          `mcp-server.ts:29` is already there)

          3. Confirm dynamic import keeps it within the single `pkg` binary (no
          second entry needed)

          4. Rebuild and smoke-test with a real `initialize` request on stdin

          5. Check docs/`.mcp.json` — current config already passes `--mcp`, no
          user-facing changes needed
    user: Claude Code
    date: '2026-05-26T12:32:38.235Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-26T12:35:54.484Z'
  - type: activity
    user: Agent
    date: '2026-05-26T12:35:35.759Z'
    comment: >-
      Updated description. Updated tags to mcp, bug, packaging. Changed priority
      from None to High. Changed effort from None to S.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-26T12:35:40.267Z'
  - type: agent_session
    sessionId: 12135593-df23-44dd-89d5-4010bc88f748
    startedAt: '2026-05-26T12:37:33.322Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-26T12:37:33.322Z'
title: help verify this bug of why MCP not working for some customers
status: Todo
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 684973
  outputTokens: 8624
  costUSD: 0.509207
  costIsEstimated: false
  cacheReadTokens: 635150
  cacheCreationTokens: 48442
id: FLUX-331
---
## Problem / Motivation

Customers using the packaged Windows exe (`event-horizon-win-v0.10.0.exe`) report that MCP tools never register in their agent (Claude Code). The root cause: the exe has a single entry point (`dist/index.js` ? `index.ts`) that unconditionally starts the HTTP Express server on port 3067. It does **not** detect the `--mcp` flag and never routes to `mcp-server.ts`. Startup logs are printed to **stdout**, which corrupts the JSON-RPC framing � Claude Code sees log lines instead of a valid `initialize` response and the MCP channel fails silently.

The separate `mcp-server.ts` module (which correctly redirects `console.log ? console.error` to keep stdout clean) is compiled to `dist/mcp-server.js` but is not reachable from the packaged binary because `pkg` only bundles the `bin` entry point (`dist/index.js`).

## Implementation Plan

1. **Add `--mcp` flag detection in `engine/src/index.ts`**: At the top of `index.ts`, before importing Express/routes, check `process.argv.includes("--mcp")`. If true, dynamically import `./mcp-server.js` and call `startMcpServer()`, then return � skip the HTTP server entirely.
2. **Verify stdout is clean in MCP mode**: `mcp-server.ts` already overrides `console.log ? console.error` at line 29. Confirm that happens before any log output (workspace activation, doc loading) so no startup text reaches stdout.
3. **Ensure `mcp-server.ts` is not a separate pkg entry**: The build already compiles it to `dist/mcp-server.js` and the `bin` is `dist/index.js`. The dynamic import approach means it is reachable without adding a second pkg binary.
4. **Rebuild and smoke-test**: Run `npm run package:win` and test `event-horizon-win-*.exe --mcp --workspace <path>` by piping a minimal MCP `initialize` request on stdin and confirming a valid JSON-RPC response on stdout.
5. **Update `.mcp.json` comment / docs if needed**: Current config already passes `--mcp` � no change needed if the fix is purely in `index.ts`.
