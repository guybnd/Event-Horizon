---
title: Deep dive into Windows compatibility
status: Done
priority: High
assignee: Agent
tags:
  - bug
  - agent
  - integration
createdBy: Guy
updatedBy: Guy
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
  - type: comment
    user: Agent
    comment: >-
      ## Code Review — FLUX-238


      The four targeted fixes are correct. No arguing with the mechanics.


      ### What is fine


      - `checkBinaryInstalled`: switching to `execFileSync` with array args is
      exactly right.

      - `kdialog` fallback: `os.homedir()` over `process.env.HOME` — yes,
      obviously.

      - PowerShell injection: escaping `'` → `''` is the correct PS quoting. The
      fix works.

      - Build script comments: adequate. They do the job.


      ### What is wrong


      **1. `execSync` still used at lines 278 and 435 for `npm prefix -g`.**


      You fixed the one instance of string-based exec in `checkBinaryInstalled`
      and called it done. But two calls to `execSync('npm prefix -g', ...)` are
      still right there in the same file. String commands, not array-safe,
      running on Windows in the very code path that locates `claude.exe`. The
      ticket principle "use execFileSync with array args" applies to ALL
      shell-invoking calls in this file, not just the one explicitly called out.
      You half-fixed the problem.


      **2. `snippet` at line 104 still injects `binaryDir` unescaped.**


      You correctly escaped `binaryDir` before executing the PowerShell command
      at line 115. But the `snippet` string returned to the client at line 104
      uses the raw unescaped `binaryDir`. This is the instructional snippet
      shown to the user to paste into PowerShell themselves. A path with a
      single quote in it will produce a broken snippet. The ticket called out
      this injection risk. You fixed the server-side execution path and left the
      user-facing snippet broken.


      **3. Commit message is garbage.**


      `Update claude-code.ts` tells me nothing. This commit includes null-byte
      stripping in the prompt builder AND the execFileSync fix — two distinct
      behaviours. A message that would survive a git log skim: `Fix
      checkBinaryInstalled to use execFileSync; strip null bytes from spawn
      args`. What was committed is the kind of message that makes archaeology
      painful six months later.


      ### Verdict


      Items 1 and 2 are real bugs, not style nits. The `npm prefix` calls need
      `execFileSync` or a documented justification for why they are exempt. The
      instructional snippet needs the same escaping as the exec path. Fix these
      before this closes.
    date: '2026-05-13T06:58:07.776Z'
    id: c-2026-05-13t06-58-07-776z
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T06:58:14.500Z'
    comment: >-
      Review posted. Ticket stays **In Progress**.


      Here's the verdict I left on the ticket:


      **Passes:**

      - `checkBinaryInstalled` → `execFileSync` — correct fix

      - `kdialog` `os.homedir()` — obviously right

      - PowerShell `'` → `''` escaping — works correctly

      - Build script macOS-only comments — fine


      **Bugs found:**


      1. **`execSync('npm prefix -g')` still at lines 278 and 435** — Two more
      string-based shell calls in the same file, in the Windows code path that
      locates `claude.exe`. The ticket's stated fix principle wasn't applied
      uniformly. Half a fix.


      2. **`snippet` at line 104 still has unescaped `binaryDir`** — The
      execution path got escaped at line 115, but the instructional snippet
      returned to the client for the user to paste into PowerShell is still raw.
      Same injection bug, different surface, not fixed.


      3. **Commit message `Update claude-code.ts`** — Completely uninformative
      for a commit that touches two separate behaviours (execFileSync fix +
      null-byte stripping).
  - type: activity
    user: Agent
    date: '2026-05-13T06:58:14.501Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-13T06:59:31.774Z'
    comment: Launched Claude Code session (5a2fa502).
  - type: activity
    user: Agent
    date: '2026-05-13T07:00:07.791Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-13T07:00:23.594Z'
    comment: Launched Claude Code session (e412ff30).
  - type: activity
    user: Agent
    date: '2026-05-13T07:05:36.843Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Done
    user: Guy
    date: '2026-05-13T07:33:50.968Z'
order: 4
tokenMetadata:
  inputTokens: 395655
  outputTokens: 7502
  costUSD: 0.339478
  costIsEstimated: false
  cacheReadTokens: 364732
  cacheCreationTokens: 29384
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
