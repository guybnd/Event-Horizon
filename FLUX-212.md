---
priority: Medium
effort: XS
assignee: Agent
tags:
  - bug
  - backend
  - engine
createdBy: Agent
title: Fix read-state.json not migrating to orphan branch
status: Done
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-12T00:00:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T00:00:01.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-12T00:00:02.000Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-12T00:00:03.000Z'
  - type: comment
    user: Agent
    date: '2026-05-12T00:00:03.000Z'
    comment: >-
      read-state.json was pointing to .flux/ (getFluxDir) instead of
      getActiveFluxDir(), so it stayed in the main repo even after orphan mode
      migration. Fixed getReadStateFile() in workspace.ts to use
      getActiveFluxDir(). Updated migrateToOrphan and restoreToInRepo in
      storage-sync.ts to move the file in both directions, and added
      .flux/read-state.json to the gitignore block written during migration and
      cleaned up during restore.
    id: c-fix-read-state
id: FLUX-212
---

## Bug: read-state.json not included in orphan mode migration

`getReadStateFile()` in `engine/src/workspace.ts` was hardcoded to `getFluxDir()` instead of `getActiveFluxDir()`, so in orphan mode the read-state file continued to be read from and written to `.flux/read-state.json` in the main repo rather than `.flux-store/read-state.json` on the orphan branch.

### Root cause

```ts
// Before
export function getReadStateFile() { return path.join(getFluxDir(), 'read-state.json'); }

// After
export function getReadStateFile() { return path.join(getActiveFluxDir(), 'read-state.json'); }
```

### Additional fixes

- `migrateToOrphan`: copy + delete `read-state.json` alongside `config.json`
- `restoreToInRepo`: copy `read-state.json` back alongside `config.json`
- `.gitignore` additions in `migrateToOrphan` now include `.flux/read-state.json`
- Cleanup pattern in `restoreToInRepo` now strips `.flux/read-state.json` from the gitignore block
