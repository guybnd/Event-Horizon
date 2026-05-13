---
title: Deep dive into Windows compatibility
status: In Progress
priority: High
assignee: Agent
tags:
  - bug
  - agent
  - integration
createdBy: Guy
updatedBy: Agent
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-13T04:07:28.775Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T04:07:30.942Z'
    comment: Launched Claude Code session (0bdaf651).
  - type: activity
    user: Agent
    date: '2026-05-13T04:11:30.479Z'
    comment: >-
      Updated description. Changed assignee from unassigned to Agent. Updated
      tags to bug, agent, integration. Changed priority from None to High.
      Changed effort from None to M.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-13T04:11:34.633Z'
  - type: comment
    user: Agent
    date: '2026-05-13T04:11:44.334Z'
    comment: >-
      Grooming complete. FLUX-238 is now in **Todo**.


      Key issues found:


      **Critical (blocks Windows operation):**


      1. **Claude Code CLI spawn** (`claude-code.ts:267,394`) — On Windows,
      `claude` is installed as `claude.cmd`. Spawning it without shell support
      fails silently. Fix: spawn as `cmd.exe /c claude [args]` with `shell:
      false` so args are passed as an array (no shell quoting issues). *(Now
      superseded by FLUX-237 direct .exe approach)*


      2. **`checkBinaryInstalled` string exec** (`claude-code.ts:10`) — Uses
      string-based `execSync` with `where`/`which`. Should use `execFileSync`
      with array args for safety.


      3. **PowerShell command injection** (`workspace.ts:115`) — `binaryDir` is
      interpolated directly into a PowerShell one-liner. A path with a single
      quote (e.g. `C:\Users\Guy''s PC`) will break it. Needs escaping.


      **Medium (degrades experience):**

      - `kdialog` fallback uses `process.env.HOME` (not set on Windows) — should
      use `os.homedir()`

      - Build scripts (`dist-source.js`, `package-release.js`) use the `zip` CLI
      and shell features — macOS-only, need documentation


      The plan in the ticket body walks through each fix with the exact code
      change needed.
    id: c-2026-05-13t04-11-44-334z
  - type: status_change
    from: Todo
    to: Ready
    user: Guy
    date: '2026-05-13T06:55:35.825Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-13T06:55:40.899Z'
  - type: activity
    user: Agent
    date: '2026-05-13T06:55:40.910Z'
    comment: Launched Claude Code session (a1a8b7f7).
order: 1
---

## Overview

Full audit and fix of Windows compatibility issues in the Event Horizon engine. This ticket covers remaining issues after FLUX-229 (EINVAL fix) and FLUX-237 (direct .exe spawn).

## Remaining Issues

### 1. `checkBinaryInstalled` — use execFileSync (claude-code.ts:11)

Currently uses string-based `execSync('where claude')`. Should use `execFileSync` with array args:

```typescript
execFileSync(process.platform === 'win32' ? 'where' : 'which', [binaryName], { stdio: 'ignore' });
```

### 2. PowerShell injection in workspace.ts (~line 115)

`binaryDir` is interpolated directly into a PowerShell string. A path containing `'` will break the command. Escape single quotes before interpolation:

```typescript
const safeBinaryDir = binaryDir.replace(/'/g, "''");
```

### 3. `kdialog` fallback uses `process.env.HOME`

`process.env.HOME` is not set on Windows — use `os.homedir()` instead.

### 4. Build scripts are macOS-only

`dist-source.js` and `package-release.js` use `zip` CLI. Add comments or guards noting macOS-only requirement, or document in README.

## Validation

- [ ] TypeScript compiles cleanly after each change
- [ ] Engine starts and loads tickets on Mac (no regression)
- [ ] Windows smoke-test if available
