---
assignee: unassigned
tags:
  - bug
priority: Medium
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T02:34:51.949Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T03:30:27.744Z'
    comment: Launched Claude Code session (06d20c71).
  - type: activity
    user: Agent
    date: '2026-05-11T03:38:41.545Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Guy
    date: '2026-05-11T03:42:31.445Z'
    comment: Changed priority from None to High.
  - type: activity
    user: Agent
    date: '2026-05-11T03:46:26.721Z'
    comment: >-
      Updated description. Changed priority from High to Medium. Changed effort
      from None to XS.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T03:46:37.511Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T03:46:48.498Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T03:47:46.967Z'
  - type: comment
    user: Agent
    date: '2026-05-11T03:47:46.968Z'
    comment: >-
      Fixed in useTaskForm.ts: added syncedTaskIdRef that tracks when the form
      state has been fully synced from modalTask. isDirty is now suppressed
      until syncedTaskIdRef.current === modalTask?.id, preventing false-dirty
      flashes on ticket open. TypeScript clean, no behaviour change for normal
      edit flows.
    id: c-2026-05-11t03-47-46-968z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T03:48:05.676Z'
    comment: >-
      FLUX-189 is in **Ready** status. Here's what was done:


      **Root cause**: `TaskModal` is never unmounted — it persists across opens.
      When a new ticket opens, `useTaskForm` runs with old state values (from
      the previous ticket) while `originalPayload` immediately recomputes from
      the new `modalTask`. This made `isDirty = true` on every ticket open
      before the `useEffect` had a chance to sync the state.


      **Fix** (`portal/src/hooks/useTaskForm.ts`): Added `syncedTaskIdRef` that
      gets set at the end of the `useEffect` after all state updates. The
      `isDirty` calculation now requires `syncedTaskIdRef.current ===
      modalTask?.id` before it can return `true`. This suppresses the
      false-dirty flash on open while still correctly reporting dirty state once
      the user actually makes changes.


      When you're ready to commit, say `finish FLUX-189`.
  - type: activity
    user: Agent
    date: '2026-05-11T03:51:27.995Z'
    comment: Launched Claude Code session (893700a2).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T03:51:51.299Z'
  - type: comment
    user: Agent
    date: '2026-05-11T03:51:51.300Z'
    comment: >-
      Completed. Added syncedTaskIdRef to useTaskForm.ts to suppress isDirty
      until form state is fully synced from the incoming ticket. Eliminates
      false-dirty flash (amber Save button and Unsaved changes text) on every
      ticket open. Validated: open ticket shows grey Save, edit makes it amber,
      save returns to grey, no flash on ticket switch. Commit: a1b0b7c.
    id: c-2026-05-11t03-51-51-300z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T03:51:59.755Z'
    comment: >-
      FLUX-189 is done. Commit `a1b0b7c` — ticket closed with
      `implementationLink` set.
  - type: activity
    user: Agent
    date: '2026-05-11T05:01:07.552Z'
    comment: Claude Code session lost (engine restarted).
title: all tickets are maked as dirty even with no changes
status: Done
createdBy: Guy
updatedBy: Agent
---
## Root Cause

`useTaskForm.ts` initializes form state with defaults (`status='Todo'`, `assignee=''`) but `originalPayload` (a `useMemo`) computes immediately from the incoming `modalTask`. Since `TaskModal` is never unmounted, when a new ticket opens the state still holds the previous ticket's values at the first render — making `originalPayload !== currentPayload`, i.e. `isDirty = true`.

The `useEffect` in `useTaskForm` corrects state on the next tick (after render), but the dirty flash is visible to the user as the Save button briefly appearing amber and "(Unsaved changes)" text showing on every ticket open.

## Fix

Add a `hasSyncedRef` (`useRef<string | undefined>`) to `useTaskForm` that tracks the last ticket ID whose state has been fully synced. Set it at the end of the `useEffect` (after all `setState` calls). Return `isDirty = false` whenever `hasSyncedRef.current !== modalTask?.id`, so the dirty indicator is suppressed until the initial sync completes.

## Files to Change

- `portal/src/hooks/useTaskForm.ts` — add `hasSyncedRef`, suppress `isDirty` until synced

## Validation

- Open any ticket → Save button should be disabled (grey), no "(Unsaved changes)" text
- Edit a field → Save button should become amber
- Save → button returns to grey
- Close and reopen same ticket → no dirty flash
- Close ticket A, open ticket B → no dirty flash
