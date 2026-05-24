---
title: Hide cmd.exe console windows for git/powershell child processes on Windows
status: In Progress
implementationLink: a4339e4
priority: Medium
effort: XS
assignee: Agent
tags:
  - engine
  - bug
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-24T00:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-24T00:00:00.000Z'
    comment: >
      On Windows, every resync and agent action flashes 3+ cmd.exe popups that
      interrupt the user. Root cause: `execFile`/`execFileAsync` calls for `git`
      and `powershell.exe` in storage-sync.ts, sync-watcher.ts, routes/tasks.ts,
      and routes/workspace.ts spawn child processes without `windowsHide: true`,
      so a console window briefly appears for each one. Agent spawns already
      pass `windowsHide: true` correctly. Plan: add `{ windowsHide: true }` to
      every `execFile`/`execFileAsync` call in those four files (centralizing
      through the existing `git()` helper in storage-sync.ts where it exists).
    id: c-2026-05-24t00-00-00-000z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-24T00:00:00.000Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-24T00:01:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-24T00:01:00.000Z'
    comment: >
      Added windowsHide:true to all child_process spawns for git and powershell
      across 4 files. Centralized via wrapper helpers in sync-watcher.ts and
      routes/tasks.ts; single-line fix in storage-sync.ts and
      routes/workspace.ts. Engine builds clean. Commit: a4339e4.
    id: c-2026-05-24t00-01-00-000z
  - type: status_change
    from: Done
    to: Ready
    user: Guy
    date: '2026-05-24T13:19:23.337Z'
  - type: comment
    user: Guy
    date: '2026-05-24T13:19:49.983Z'
    comment: i still get some popup views when i launch an agent for example
    id: c-2026-05-24t13-19-49-980z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-24T13:19:55.822Z'
  - type: agent_session
    sessionId: 6eaea6a5-f94a-4c1f-a013-fea81a2bfc66
    startedAt: '2026-05-24T13:19:55.846Z'
    status: active
    progress: []
    user: Gemini CLI
    date: '2026-05-24T13:19:55.846Z'
order: 0
subtasks: []
---

## Problem / Motivation

On Windows, every Flux resync and agent action causes 3+ `cmd.exe` console windows to briefly flash on screen, stealing focus and interrupting the user. The cause is `child_process.execFile` calls for `git` and `powershell.exe` that don't set `windowsHide: true`. Node's default on Windows is to show a console window for child processes, even short-lived ones.

Agent spawns (`claude-code.ts`, `gemini.ts`, `copilot.ts`) already pass `windowsHide: true`. The remaining offenders are the git plumbing for storage sync and the powershell folder picker / PATH writer.

## Implementation plan

1. `engine/src/storage-sync.ts` — extend the existing `git(cwd, args)` helper to pass `{ cwd, windowsHide: true }`. All callers route through this helper, so one edit covers the whole file.
2. `engine/src/sync-watcher.ts` — add `{ windowsHide: true }` to every `execFileAsync('git', ...)` call (15 sites).
3. `engine/src/routes/tasks.ts` — add `{ windowsHide: true }` to the two `execFileAsync('git', ...)` calls in `getMaxIdFromRemote`.
4. `engine/src/routes/workspace.ts` — add `{ windowsHide: true }` to the `powershell.exe` calls in `spawnFolderPicker` (folder browser) and `handlePathSetup` (PATH writer).
5. Build the engine to verify TypeScript still compiles.

## Acceptance Criteria

- [ ] Resync triggers no visible cmd.exe popups on Windows.
- [ ] Agent reply / new agent run triggers no popups.
- [ ] Folder picker still functions (the dialog itself is a Windows Forms dialog, not a console — only the host powershell process is hidden).
- [ ] Engine builds without TypeScript errors.
