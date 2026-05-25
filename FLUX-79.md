---
title: Auto-open browser on launch and add CLI flags
status: Backlog
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - feature
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:55:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T06:55:00.000Z'
    comment: >-
      Split from FLUX-18. Covers the polish layer: auto-open browser, --port
      flag, --no-browser flag, and graceful git detection.
    id: c-2026-05-07t06-55-00-000z-flux-79
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T06:17:07.388Z'
order: 79
---
## Summary

After the engine starts listening, automatically open the portal in the user's
default browser. Add CLI flags for common overrides: `--no-browser` to suppress
auto-open, `--port` to change the listening port. Also add graceful git
detection so git-dependent features degrade cleanly when git is not installed.

## Requirements

### 1. Auto-open browser
- After the engine starts listening, open `http://localhost:<port>` in the default browser
- Use platform-specific commands: `start` (Windows), `open` (macOS), `xdg-open` (Linux)
- Only auto-open when serving the portal (static serving mode), not in API-only dev mode

### 2. CLI flags
- `--no-browser` — suppress auto-open for headless/CI usage
- `--port <number>` — override the default port (3001)
- Parse flags using a lightweight approach (manual argv parsing or `minimist`)

### 3. Graceful git detection
- On startup, check if `git` is available on PATH
- If git is not found, log a clear message and disable git-dependent features
- Never crash on missing git — degrade gracefully

## Acceptance Criteria

- [ ] Engine auto-opens the browser on startup when serving the portal
- [ ] `--no-browser` suppresses the auto-open
- [ ] `--port 4000` changes the listening port
- [ ] Missing git logs a clear message and disables git features without crashing
- [ ] Auto-open only triggers in static-serving mode, not pure dev mode

## Likely Affected Areas

- `engine/src/index.ts` — startup sequence, CLI arg parsing

## Parent

- Subtask of FLUX-18
