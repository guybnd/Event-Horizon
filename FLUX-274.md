---
id: FLUX-274
title: 'Fix: Agents not persisting ticket updates after session completion'
status: Released
priority: High
effort: M
assignee: unassigned
tags:
  - engine
  - bug-fix
  - agents
createdBy: Guy
updatedBy: Agent
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2025-05-18T13:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2025-05-18T13:00:00.000Z'
    comment: Ticket created
  - type: status_change
    from: Grooming
    to: Done
    user: Guy
    date: '2025-05-18T13:40:00.000Z'
  - type: comment
    user: Copilot
    date: '2025-05-18T13:40:00.000Z'
    comment: >-
      Fixed 4 root causes preventing agents from persisting ticket changes: (1)
      Skill files used abstract language without telling agents to edit .flux
      files. (2) Engine wrote progress to ticket files during active sessions
      causing contention. (3) buildInitialPrompt had no Grooming case — agents
      got generic "report progress" instructions. (4)
      updateAgentSession/updateTaskWithHistory used stale cached data,
      overwriting agent file edits.
    id: c-2025-05-18t13-40-00-000z
  - type: agent_session
    sessionId: 3f92a981-9155-4743-b080-4958559d2f7b
    startedAt: '2026-05-18T15:22:42.251Z'
    status: failed
    progress: []
    user: Gemini CLI
    date: '2026-05-18T15:22:42.251Z'
    outcome: Gemini CLI session ended with code 1.
    endedAt: '2026-05-18T15:22:43.627Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-25T09:54:03.246Z'
version: v0.8.0
releasedAt: '2026-05-25T09:54:03.246Z'
releaseDocPath: release-notes/v0.8.0
---

## Problem

After launching agent sessions (Gemini, Claude, Copilot) to groom or implement tickets, the agents would complete their work but the ticket file would never reflect the changes. Status wouldn't update, body wouldn't be rewritten, and no summary comment was saved.

## Root Causes

### 1. Skill files lacked explicit persistence instructions
The orchestrator/grooming/implementation skill files used abstract language like "Move to Todo" without telling agents to physically edit the `.flux/<id>.md` file.

### 2. Engine wrote to ticket files during active sessions
The engine flushed session progress to the ticket file every ~1s (output flush) and every 15s (heartbeat). Agents detected the file changing and backed off from editing.

### 3. No Grooming case in buildInitialPrompt
The `buildInitialPrompt()` function only handled `In Progress`, `Todo`, and `Ready` statuses. Grooming tickets fell through to a generic "Respond with progress updates" message that didn't instruct the agent to do anything.

### 4. task-store overwrote agent file edits with stale cache
`updateAgentSession()` and `updateTaskWithHistory()` destructured `body` and `frontmatter` from the in-memory cache, then only selectively re-read `history` from disk. When writing back, they clobbered the agent's status changes, body rewrites, and metadata updates.

## Fix

- **Commits**: c04d489, ad10b6c, c666bd0, 305ae79, 814f64a
- **Files changed**: 
  - `engine/src/agents/gemini.ts`, `copilot.ts`, `claude-code.ts` — deferred progress writes, added Grooming prompt, added session-end comment
  - `engine/src/task-store.ts` — re-read full file from disk before updating
  - `engine/src/workspace.ts` — Node.js v26 __dirname fix
  - `.docs/skills/*.md` — explicit file-editing instructions
  - `.github/skills/`, `.gemini/skills/`, `.claude/rules/` — propagated skill updates
