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
