---
assignee: Agent
actor: Guy
title: Fix TypeScript compilation errors blocking build and tests
status: Grooming
priority: None
createdBy: Unknown
updatedBy: Guy
tags: []
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T12:41:41.934Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-14T08:46:27.384Z'
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-14T08:46:30.152Z'
order: 6
---
Multiple TypeScript errors prevent tsc --noEmit from passing. These include missing dependencies, type mismatches from strict mode, and property access issues.

High Priority:
- Missing vitest dependency (tests cannot run)
- skill-installer.ts missing import extension
- task-store.ts property access errors on tags

Medium Priority:
- Multiple exactOptionalPropertyTypes violations in claude-code.ts, session-store.ts, workflow-installer.ts, workspace.ts
- string | undefined type mismatches

Context:
Code runs fine with tsx in dev mode, but tsc fails, blocking CI builds and test execution.
