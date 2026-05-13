---
priority: Medium
effort: XS
assignee: Agent
tags:
  - bugfix
  - windows
title: 'Fix npm prefix lookup: use execSync instead of execFileSync'
status: Done
createdBy: Unknown
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T12:07:25.729Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T12:07:39.678Z'
    comment: Updated implementation link.
  - type: comment
    user: Agent
    comment: >-
      Implementation complete. Changed execFileSync to execSync in
      claude-code.ts for simpler, more robust npm prefix detection. Commit:
      e1d78d5
    date: '2026-05-13T12:07:39.678Z'
    id: c-2026-05-13t12-07-39-678z
implementationLink: e1d78d5f8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e
---
## Problem
The code was using `execFileSync('npm.cmd', ['prefix', '-g'])` to find the global npm prefix on Windows. This is unnecessarily complex and may fail in some shell environments.

## Solution
Changed to `execSync('npm prefix -g')` which:
- Simpler and more direct
- Works across all platforms (Windows, Mac, Linux)
- Handles shell resolution automatically
- More robust for different npm installation types

## Files Changed
- `engine/src/agents/claude-code.ts`: Updated two occurrences (lines 278 and 435)
  - In `startCliSession()` for initial session spawn
  - In `sendCliSessionInput()` for reply handling
