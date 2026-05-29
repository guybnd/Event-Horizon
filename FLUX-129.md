---
title: Tray icon blank in system tray on Windows
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - bug
  - windows
  - engine
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Bug reported during FLUX-124 testing. The system tray icon is blank/empty
      on Windows despite the Go tray binary receiving a valid menu JSON payload
      with a base64-encoded PNG icon. Right-click menu works, but no icon is
      displayed. Multiple PNG formats were attempted (16x16 RGB, 32x32 RGBA,
      hardcoded known-good base64 from systray test suite) — all result in a
      blank tray icon. The tray binary receives the ready handshake and menu
      JSON correctly. Investigation needed into whether the systray Go binary
      requires a specific PNG format, size, or encoding that differs from what
      is currently sent.
    id: c-flux129-created
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-10T14:39:22.564Z'
  - type: agent_session
    sessionId: 90d4e81b-fdb3-4ef2-ba14-52f233643cdc
    startedAt: '2026-05-29T02:24:33.727Z'
    status: completed
    progress:
      - timestamp: '2026-05-29T02:24:48.177Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: event-horizon
            max_results: 10
      - timestamp: '2026-05-29T02:24:49.576Z'
        message: Working
        type: info
      - timestamp: '2026-05-29T02:24:51.753Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            subagent_type: Explore
            description: Find tray icon code
            prompt: >-
              Find all files related to the system tray implementation in
              C:\GitHub\EventHorizon. Look for files mentioning "tray",
              "systray", "icon", or system tray functionality. Search in
              engine/src/, any tray/ directory, and root-level files. I need to
              understand how the tray binary is spawned and how the icon PNG is
              passed to it. Report file paths and key code snippets showing icon
              handling.
      - timestamp: '2026-05-29T02:24:54.238Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '**/*tray*'
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-29T02:24:57.722Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\index.ts'
      - timestamp: '2026-05-29T02:25:00.851Z'
        message: 'Running: find "C:\GitHub\EventHorizon" -type f -name "*.ts"...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find "C:\GitHub\EventHorizon" -type f -name "*.ts" -o -name "*.js"
              | grep -E "(tray|icon)" | head -20
      - timestamp: '2026-05-29T02:25:04.583Z'
        message: Running command
        type: info
      - timestamp: '2026-05-29T02:25:06.110Z'
        message: Reading index.js
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\node_modules\systray\lib\index.js'
      - timestamp: '2026-05-29T02:25:06.521Z'
        message: 'Running: find "C:\GitHub\EventHorizon\node_modules\systray"...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find "C:\GitHub\EventHorizon\node_modules\systray" -type f \(
              -name "*.md" -o -name "*.txt" \) | head -10
      - timestamp: '2026-05-29T02:25:09.004Z'
        message: Reading package.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\node_modules\systray\package.json'
      - timestamp: '2026-05-29T02:25:09.442Z'
        message: 'Running: ls -la "C:\GitHub\EventHorizon\engine\dist\tray-ic...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              ls -la "C:\GitHub\EventHorizon\engine\dist\tray-icon.b64"
              2>/dev/null || echo "File not found"
      - timestamp: '2026-05-29T02:25:12.071Z'
        message: Reading tray-icon.b64
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\dist\tray-icon.b64'
      - timestamp: '2026-05-29T02:25:12.450Z'
        message: 'Running: grep -r "TRAY_ICON" "C:\GitHub\EventHorizon\engine...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "TRAY_ICON" "C:\GitHub\EventHorizon\engine\src"
              --include="*.ts" --include="*.js"
      - timestamp: '2026-05-29T02:25:18.248Z'
        message: Reading index.d.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\node_modules\systray\lib\index.d.ts'
      - timestamp: '2026-05-29T02:25:18.573Z'
        message: 'Running: grep -A 5 -B 5 "icon" "C:\GitHub\EventHorizon\READ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -A 5 -B 5 "icon" "C:\GitHub\EventHorizon\README.md" | head
              -30
      - timestamp: '2026-05-29T02:25:19.592Z'
        message: Running command
        type: info
      - timestamp: '2026-05-29T02:25:27.905Z'
        message: Reading package-release.js
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\scripts\package-release.js'
      - timestamp: '2026-05-29T02:25:34.605Z'
        message: Reading
        type: info
      - timestamp: '2026-05-29T02:25:54.654Z'
        message: Reading index.js
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\node_modules\systray\lib\index.js'
      - timestamp: '2026-05-29T02:25:54.686Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_board_config
          parameters: {}
      - timestamp: '2026-05-29T02:26:04.624Z'
        message: Working
        type: info
      - timestamp: '2026-05-29T02:26:08.921Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '**/systray/test/**'
            path: 'C:\GitHub\EventHorizon\node_modules'
      - timestamp: '2026-05-29T02:26:09.800Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\index.ts'
            offset: 140
            limit: 100
      - timestamp: '2026-05-29T02:26:14.251Z'
        message: Reading menu.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\node_modules\systray\test\menu.json'
            limit: 30
      - timestamp: '2026-05-29T02:26:15.740Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: icon|ico|png
            path: 'C:\GitHub\EventHorizon\node_modules\systray'
            glob: '*.{go,md,ts}'
            output_mode: content
            '-i': true
      - timestamp: '2026-05-29T02:26:19.632Z'
        message: Working
        type: info
      - timestamp: '2026-05-29T02:26:34.638Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-29T02:26:38.264Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-129
            priority: Medium
            effort: S
            tags:
              - bug
              - windows
              - engine
            body: >-
              ## Problem / Motivation


              The system tray icon displays as blank (invisible) on Windows. The
              tray binary starts correctly and the right-click menu works, but
              no icon is visible. This is a UX issue — users cannot locate the
              tray entry without knowing to look for a blank space.


              **Root cause:** The `systray` Go binary expects `.ico` format
              icons on Windows but `.png` on macOS/Linux (documented in the
              systray README: "you should using .png icon in macOS/Linux, but
              .ico format in windows"). The current implementation passes a
              base64-encoded PNG on all platforms (`engine/src/index.ts:189`),
              which is why it renders blank only on Windows.


              ## Implementation Plan


              1. **Generate an ICO version** of the tray icon (32×32, 16×16
              multi-resolution ICO from the existing PNG source). Store as a
              base64 constant alongside the existing PNG constant.

              2. **Platform-branch the icon field** in `initTray()`
              (`engine/src/index.ts:193`): use the ICO base64 string when
              `process.platform === 'win32'`, otherwise use the existing PNG
              string.

              3. **Validate** by running the engine on Windows and confirming
              the icon appears in the system tray.


              Key file: `engine/src/index.ts` (lines 189–202) — the
              `TRAY_ICON_PNG` constant and `menu` object construction.
      - timestamp: '2026-05-29T02:26:42.142Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-129
            newStatus: Todo
      - timestamp: '2026-05-29T02:26:48.370Z'
        message: >-
          Grooming complete. FLUX-129 is now in **Todo** with filled metadata
          and a concrete plan.


          **Summary:** The root cause is documented in the systray README itself
          — the Go binary expects ICO format on Windows, but the code passes PNG
          on all platforms. The fix is small (effort: S): add a base64 ICO
          constant and branch on `process.platform` when setting the `icon`
          field in the menu object.
    user: Claude Code
    date: '2026-05-29T02:24:33.727Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-29T02:26:49.529Z'
  - type: activity
    user: Agent
    date: '2026-05-29T02:26:38.274Z'
    comment: Updated description. Changed priority to Medium. Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-29T02:26:42.148Z'
order: 0
id: FLUX-129
tokenMetadata:
  inputTokens: 235646
  outputTokens: 3018
  costUSD: 0.495445
  costIsEstimated: false
  cacheReadTokens: 201625
  cacheCreationTokens: 30072
---
## Problem / Motivation

The system tray icon displays as blank (invisible) on Windows. The tray binary starts correctly and the right-click menu works, but no icon is visible. This is a UX issue — users cannot locate the tray entry without knowing to look for a blank space.

**Root cause:** The `systray` Go binary expects `.ico` format icons on Windows but `.png` on macOS/Linux (documented in the systray README: "you should using .png icon in macOS/Linux, but .ico format in windows"). The current implementation passes a base64-encoded PNG on all platforms (`engine/src/index.ts:189`), which is why it renders blank only on Windows.

## Implementation Plan

1. **Generate an ICO version** of the tray icon (32×32, 16×16 multi-resolution ICO from the existing PNG source). Store as a base64 constant alongside the existing PNG constant.
2. **Platform-branch the icon field** in `initTray()` (`engine/src/index.ts:193`): use the ICO base64 string when `process.platform === 'win32'`, otherwise use the existing PNG string.
3. **Validate** by running the engine on Windows and confirming the icon appears in the system tray.

Key file: `engine/src/index.ts` (lines 189–202) — the `TRAY_ICON_PNG` constant and `menu` object construction.
