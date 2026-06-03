---
priority: High
effort: M
tags:
  - testing
  - engine
  - reliability
assignee: unassigned
id: FLUX-350
title: 'Engine: expand test coverage for storage integrity'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:32.871Z'
    comment: Created ticket.
---
## Problem

Only two test files in `engine/`. The exact subsystems that have caused real bugs — atomic writes, history normalization, parse-error recovery, sync-watcher conflict handling — have at most one test file each. For a tool whose core promise is "your data is safe in your repo," this is the highest-leverage place to invest.

## Plan

- Add vitest suites for:
  - `task-store.ts`: atomic write race, corrupt-read fallback, agent-session re-injection.
  - `history.ts`: normalization, creation-activity dedupe, field-change summarization.
  - `schema.ts`: each validation rule with a positive + negative case.
  - `sync-watcher.ts`: conflict detection, debounce + max-wait, error classification.
- Add a smoke test that boots the engine, creates a ticket via REST, mutates via MCP, and asserts they converge.
- Acceptance: coverage report shows the four files above above 80%.
