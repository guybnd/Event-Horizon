---
assignee: unassigned
tags:
  - ux
  - portal
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T04:10:06.913Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T04:10:17.094Z'
    comment: Launched Claude Code session (cfd965fe).
  - type: comment
    user: Agent
    date: '2026-05-11T04:11:44.056Z'
    comment: >-
      Grooming complete. Two targeted fixes in TaskModal.tsx: (1) new tasks
      always open in popup view regardless of URL state, (2) title textarea
      auto-focused on new task open.
    id: c-2026-05-11t04-12-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T04:11:44.056Z'
  - type: activity
    user: Agent
    date: '2026-05-11T04:11:44.056Z'
    comment: >-
      Updated description. Updated tags to ux, portal. Changed priority from
      None to Low. Changed effort from None to XS.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T04:11:49.395Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:11:49.397Z'
    comment: >-
      Starting implementation: two changes in TaskModal.tsx — (1) guard
      isFullView reset with modalTask.id check, (2) add useEffect to focus title
      on new task open.
    id: c-2026-05-11t04-11-49-397z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T04:12:23.783Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:12:23.784Z'
    comment: >-
      Implementation complete. Two changes in
      portal/src/components/TaskModal.tsx: (1) line 241: guard isFullView reset
      with !!modalTask.id so new tasks always open in popup regardless of URL
      state; (2) added useEffect that focuses titleRef 50ms after modal opens
      for new tasks. TypeScript type-check passes.
    id: c-2026-05-11t04-12-23-784z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T04:12:28.420Z'
    comment: >-
      Done. Two changes made in `portal/src/components/TaskModal.tsx`:


      1. **Popup default** — `TaskModal.tsx:241`: new tasks (no `modalTask.id`)
      now always initialize with `isFullView = false`, regardless of the URL
      `view` param left over from a previously opened ticket.


      2. **Auto-focus title** — added a `useEffect` that calls
      `titleRef.current?.focus()` 50ms after the modal opens for a new task, so
      the user can start typing immediately.


      TypeScript type-check passes. Ticket is in **Ready** — say `finish
      FLUX-204` when you'd like to commit.
  - type: activity
    user: Agent
    date: '2026-05-11T04:13:10.168Z'
    comment: Launched Claude Code session (66351e24).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T04:13:31.383Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:13:31.385Z'
    comment: >-
      Finished. Commit 8e19b47: two changes in TaskModal.tsx — (1) new tasks
      always open in popup view regardless of URL state; (2) title textarea
      auto-focused 50ms after modal renders. All five validation steps passed.
    id: c-2026-05-11t04-13-31-385z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T04:13:38.765Z'
    comment: >-
      FLUX-204 is done. Commit `8e19b47` — new tasks open in popup view and the
      title textarea is auto-focused on open.
  - type: activity
    user: Agent
    date: '2026-05-11T04:52:31.942Z'
    comment: Claude Code session lost (engine restarted).
title: new task window improvement UX
status: Done
createdBy: Guy
updatedBy: Agent
---
## Problem

Two UX issues with the new task creation flow:

1. **Wrong default view**: Opening a new task (no existing id) incorrectly shows the full-screen view instead of the popup. Root cause: `TaskModal.tsx:241` reads the URL `view` param when resetting per-ticket state — if the user previously had a ticket open in full view, that `view=full` URL param persists when a new task modal opens.

2. **Title not focused**: The title textarea is not auto-focused when the new task modal opens, so the user cannot immediately start typing.

## Implementation Plan

### Fix 1 — Default new tasks to popup view

In `portal/src/components/TaskModal.tsx` line 241, the per-ticket reset sets `isFullView` from the current URL param:

```ts
setIsFullView(new URLSearchParams(window.location.search).get(view) === full);
```

For new tasks (no `modalTask.id`), this should always be `false`. Change to:

```ts
setIsFullView(!!modalTask.id && new URLSearchParams(window.location.search).get(view) === full);
```

### Fix 2 — Auto-focus title on new task

Add a `useEffect` that focuses the title textarea when the modal opens for a new task (no id). After the modal transition settles, call `titleRef.current?.focus()`. Target the existing `isModalOpen` + `modalTask?.id` combination:

```ts
useEffect(() => {
  if (!isModalOpen || modalTask?.id) return;
  const timer = setTimeout(() => titleRef.current?.focus(), 50);
  return () => clearTimeout(timer);
}, [isModalOpen, modalTask?.id]);
```

The 50ms delay ensures the modal has rendered before focus is applied.

## Files to Change

- `portal/src/components/TaskModal.tsx` — two small targeted changes

## Validation

1. Click "New Task" button in Header — modal should open in popup view (not full screen)
2. Click "+" in a Column — modal should open in popup view
3. Title textarea should receive focus immediately — typing starts populating the title
4. Opening an existing ticket that was last viewed in full view should still open in full view (URL param respected for existing tickets)
5. Switching from an existing full-view ticket to creating a new task should open new task in popup
