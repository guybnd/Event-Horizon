---
id: FLUX-290
title: "Engine: prevent chokidar double-load on self-writes"
status: Grooming
priority: Medium
effort: S
assignee: unassigned
tags:
  - bug
  - engine
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-25T12:00:00.000Z'
    comment: >-
      Created ticket. When loadTask normalizes history or subtasks it writes the
      file back, chokidar fires again, and loadTask re-reads/re-parses/re-validates
      the same file needlessly. At scale with active agents this doubles the
      per-edit work.
---

## Problem / Motivation

`loadTask` in `engine/src/task-store.ts` writes back normalized content when `normalizedHistory.changed || subtasksNormalized`. This triggers chokidar's `change` event, which calls `loadTask` again on the same file. The second pass finds nothing to normalize (`changed: false`) but still performs a full stat + readFile + YAML parse + normalize + validate pipeline — all wasted work.

With the new schema validator (FLUX-289), this redundant second pass is slightly more expensive.

## Implementation Plan

Track recently-written file paths in a `Set<string>` with a short TTL or single-fire guard. When `loadTask` is about to write back a normalized file, add the path to the set. On the next chokidar-triggered `loadTask` call for that path, skip re-loading and remove from the set.

```typescript
const recentEngineWrites = new Set<string>();

// Before fs.writeFile in loadTask:
recentEngineWrites.add(filePath);
await fs.writeFile(filePath, normalizedContent, 'utf-8');

// At the top of loadTask:
if (recentEngineWrites.delete(filePath)) return;
```

Same pattern applies to `updateTaskWithHistory` and `updateAgentSession` writes.
