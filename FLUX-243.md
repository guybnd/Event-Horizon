---
priority: High
effort: M
assignee: Agent
tags:
  - bugfix
  - sync
implementationLink: e47b50f36bf6f76ddb32a8bb2e36f56f96aca817
id: FLUX-243
title: 'Fix sync race condition: re-fetch before push'
status: Done
createdBy: Unknown
updatedBy: Unknown
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T11:57:54.861Z'
    comment: Created ticket.
---
## Problem
Sync was failing with push rejection error: `cannot lock ref 'refs/heads/flux-data': is at fd99a9811... but expected 4c7bbdfeac...`

This race condition occurred when:
1. Sync fetches remote at time T1
2. Sync merges local changes at time T2
3. Another process pushes to remote between T2 and T3
4. Sync tries to push at time T3 ? fails because remote moved forward

## Root Cause
The sync workflow had a race condition window between merge (line 231) and push (line 252). If another commit landed on the remote during this window, the push would fail.

## Solution
Added pre-push verification in `sync-watcher.ts`:
1. Re-fetch remote right before pushing
2. Compare local HEAD vs origin/flux-data
3. If remote moved forward ? retry entire sync from beginning
4. If still in sync ? proceed with push

## Validation
- Manual testing: sync completes successfully
- Race condition window eliminated
- Failed pushes now automatically retry instead of erroring

## Files Changed
- `engine/src/sync-watcher.ts`: Added pre-push fetch and retry logic
