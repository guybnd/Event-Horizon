---
assignee: Agent
actor: Guy
id: FLUX-247
title: Fix TypeScript compilation errors blocking build and tests
status: Grooming
priority: None
createdBy: Unknown
updatedBy: Unknown
tags: []
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T12:41:36.097Z'
    comment: Created ticket.
---
Multiple TypeScript errors prevent `tsc --noEmit` from passing. These include missing dependencies, type mismatches from strict mode, and property access issues.

**High Priority:**
- Missing vitest dependency (tests cannot run)
- skill-installer.ts missing import extension
- task-store.ts property access errors on tags

**Medium Priority:**
- Multiple exactOptionalPropertyTypes violations in claude-code.ts, session-store.ts, workflow-installer.ts, workspace.ts
- string | undefined type mismatches

**Context:**
Code runs fine with tsx in dev mode, but tsc fails, blocking CI builds and test execution.
