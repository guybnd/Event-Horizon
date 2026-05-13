---
title: Fix orphan branch git sync - prevent ticket ID collisions and data loss
status: Todo
priority: High
assignee: unassigned
tags:
  - bug
  - git
  - reliability
  - architecture
createdBy: Guy
updatedBy: Agent
effort: L
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-13T19:45:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T03:50:01.354Z'
    comment: Launched Claude Code session (f7efc393).
  - type: activity
    user: Agent
    date: '2026-05-13T03:50:23.766Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-13T03:54:10.096Z'
    comment: Launched Claude Code session (3b525079).
  - type: activity
    user: Agent
    date: '2026-05-13T03:54:45.138Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-13T03:56:24.367Z'
    comment: Launched Claude Code session (4d0cffc3).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-13T03:59:38.669Z'
  - type: comment
    user: Agent
    date: '2026-05-13T03:59:38.670Z'
    comment: >-
      Grooming complete. Implementation plan written to ticket body. Ready for
      pickup.
    id: c-2026-05-13t03-59-38-670z
  - type: activity
    user: Agent
    date: '2026-05-13T03:59:42.502Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-13T04:00:11.895Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-13T04:00:42.871Z'
    comment: Launched Claude Code session (fd985e94).
---

## Problem

The git sync for orphan branch (flux-data) has multiple critical issues that cause:

1. **Missing tickets from other instances** - Changes pushed from other instances never pull locally
2. **Branch divergence** - Local and remote branches diverge silently, blocking future syncs
3. **Ticket ID collisions** - Multiple instances create tickets with same IDs but different content
4. **Silent data loss** - When sync fails, no warning is shown to user

### What Happened (2026-05-13)

User reported not receiving tickets FLUX-218 through FLUX-226 from another instance. Investigation revealed:

- Local branch had 6 commits ahead of remote
- Remote had 1 commit with "missing tickets FLUX-218 through FLUX-226"
- Branches had diverged at commit 0653be4
- Both instances independently created FLUX-218 and FLUX-219 with completely different content
- Sync was silently failing with no user notification

## Root Causes

### 1. Push-Only Sync (FIXED)

`engine/src/sync-watcher.ts` only pushed changes, never fetched/pulled from remote:

```typescript
// Old code - push only, no pull
await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync']);
await execFileAsync('git', ['-C', workspaceRoot, 'push', 'origin', 'flux-data']).catch(() => {
  // push is best-effort — no remote is fine
});
```

This meant:
- Instance A pushes ticket FLUX-220 ✓
- Instance B never pulls, creates own FLUX-220 ✗
- Branches diverge
- Push silently fails

### 2. Ticket ID Allocation Only Checks Local State

`engine/src/routes/tasks.ts` lines 34-40:

```typescript
let maxId = 0;
Object.keys(tasksCache).forEach((key) => {
  if (key.startsWith(`${pKey}-`)) {
    const num = parseInt(key.replace(`${pKey}-`, ''), 10);
    if (!isNaN(num) && num > maxId) maxId = num;
  }
});
const nextId = `${pKey}-${maxId + 1}`;
```

**Problem**: Only looks at `tasksCache` (local state), not remote. If remote has FLUX-220 but local hasn't pulled yet, both instances create FLUX-220.

### 3. No Conflict Detection or User Notification

When sync fails or branches diverge, there's no:
- UI notification
- Conflict resolution prompt
- Warning about potential data loss

## Fixes Applied (2026-05-13)

### ✅ Added Pull Logic to Sync

Updated `sync-watcher.ts:runSync()` to:
1. Fetch from remote before committing
2. Check if local/remote have diverged
3. If diverged, reset local to remote (remote = source of truth)
4. Then commit and push local changes

**Behavior now**:
- Fast-forward pull if possible
- Reset to remote if diverged (prevents data loss)
- Better error logging

### ✅ Resolved Current Divergence

Reset local flux-data to match remote (source of truth). User now has all tickets including FLUX-218 through FLUX-228.

## What Still Needs Implementation

### 🔴 Priority 1: Prevent Ticket ID Collisions

**Problem**: Multiple instances can still create same ticket ID before sync happens.

**Solutions** (pick one):

#### Option A: Check Remote Before Allocating ID (Recommended)

```typescript
// In POST /api/tasks handler
async function getNextTicketId(projectKey: string): Promise<string> {
  // 1. Get max from local cache
  let maxId = getMaxIdFromCache(projectKey);
  
  // 2. If in orphan mode, also check remote
  if (isOrphanMode()) {
    try {
      const remoteMax = await getMaxIdFromRemote(projectKey);
      maxId = Math.max(maxId, remoteMax);
    } catch (err) {
      // Network failure - use local max + warn user
      console.warn('Could not check remote for max ticket ID');
    }
  }
  
  return `${projectKey}-${maxId + 1}`;
}

async function getMaxIdFromRemote(projectKey: string): Promise<number> {
  const storeDir = getFluxStoreDir();
  await execFileAsync('git', ['-C', storeDir, 'fetch', 'origin', 'flux-data']);
  const { stdout } = await execFileAsync('git', ['ls-tree', 'origin/flux-data', '--name-only']);
  
  let maxId = 0;
  stdout.split('\n').forEach(file => {
    if (file.startsWith(`${projectKey}-`) && file.endsWith('.md')) {
      const num = parseInt(file.replace(`${projectKey}-`, '').replace('.md', ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });
  return maxId;
}
```

**Pros**: Simple, backward compatible
**Cons**: Requires network call on ticket creation, slight delay

#### Option B: Instance-Specific ID Ranges

Assign each instance a range:
- Instance 1: FLUX-1000 to FLUX-1999
- Instance 2: FLUX-2000 to FLUX-2999

**Pros**: No collision possible
**Cons**: Complex config, IDs not sequential

#### Option C: Use UUIDs or Timestamp-Based IDs

Replace `FLUX-123` with `FLUX-2026051312345678-abc`

**Pros**: Guaranteed unique
**Cons**: Breaking change, harder to read

### 🟡 Priority 2: Conflict Resolution UI

When sync detects local changes would be lost:

1. Pause sync
2. Show modal: "Ticket FLUX-220 exists in remote with different content. What should we do?"
   - "Use remote version (discard local)"
   - "Rename local to FLUX-229"
   - "Show diff and let me merge"
3. Apply user choice
4. Continue sync

**API endpoint**: `POST /api/storage/resolve-conflicts`

**Frontend**: Add conflict resolution modal in portal

### 🟡 Priority 3: Sync Status Indicator

Show sync state in UI:
- 🟢 Synced
- 🟡 Syncing...
- 🔴 Sync failed (branches diverged)
- ⚠️ Offline (no remote)

Add to portal header or as toast notification.

### 🟢 Priority 4: Pre-Sync Pull on App Start

In `engine/src/storage-sync.ts:attachWorktreeIfPresent()`, add:

```typescript
// After attaching worktree, pull latest
try {
  await git(storeDir, ['pull', '--ff-only', 'origin', 'flux-data']);
  console.log('[storage-sync] Pulled latest flux-data on startup');
} catch (err) {
  console.log('[storage-sync] Could not pull on startup:', err.message);
}
```

This ensures fresh data when opening the app.

## Testing Plan

1. **Two instances test**:
   - Open Event Horizon on two machines
   - Create ticket on Instance A
   - Wait for sync (30s default)
   - Verify ticket appears on Instance B within sync interval

2. **Collision test**:
   - Disconnect Instance B from network
   - Create tickets on both instances
   - Reconnect Instance B
   - Verify collision is detected and handled

3. **Conflict resolution test**:
   - Edit same ticket on both instances while offline
   - Reconnect
   - Verify conflict UI appears
   - Test each resolution option

## Success Criteria

- ✅ Tickets from other instances sync within 30-60 seconds
- ✅ No silent sync failures
- ✅ No ticket ID collisions
- ✅ User is notified of conflicts
- ✅ Data loss is prevented

## Related

- Implementation: `engine/src/sync-watcher.ts`
- Implementation: `engine/src/routes/tasks.ts`
- Implementation: `engine/src/storage-sync.ts`
- Docs: `.docs/event-horizon-orphan-mode.md`
