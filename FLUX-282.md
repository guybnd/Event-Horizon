---
title: 'Research CLI capabilities and arguments for Claude, Gemini, and Copilot'
status: In Progress
priority: High
effort: M
assignee: unassigned
tags:
  - feature
  - multi-agent
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Auto-created from inline subtask of FLUX-281.
  - type: activity
    user: Guy
    date: '2026-05-25T11:26:38.217Z'
    comment: Updated description.
  - type: agent_session
    sessionId: 22d1c2ce-e739-40cb-963b-7895f57f59cb
    startedAt: '2026-05-25T11:26:56.403Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T11:26:56.403Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T11:27:08.297Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T11:27:29.758Z'
implementationLink: ''
subtasks: []
id: FLUX-282
---
Subtask of FLUX-281.

Research execution arguments and best practices for injecting specialized instruction sets (System Prompts) into Claude CLI, Gemini CLI, and Copilot CLI. Establish a method to isolate context so that "Reviewer" agents don't hallucinate implementation details, and "Implementer" agents get precisely groomed specs. Or how a sub agent can 'wait' until he gets input or a result from a different sub agent.
