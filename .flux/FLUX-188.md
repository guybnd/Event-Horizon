---
assignee: unassigned
tags: []
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T01:59:28.401Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T02:24:43.923Z'
    comment: Launched Claude Code session (231f36c5).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T02:25:49.478Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:25:49.479Z'
    comment: >-
      Root cause: useCliSession polls every 2500ms and calls setCliSession(),
      which triggers a full TaskModal re-render. newComment state lives in
      TaskModal, so each poll re-renders CommentBox mid-keystroke causing lag.


      Plan:

      1. Move comment textarea to uncontrolled: lift newComment state into
      CommentBox as local state, expose current value via a forwarded ref
      (useImperativeHandle or a simple valueRef). CommentBox calls onChange only
      on submit, not on each keystroke.

      2. Update TaskModal to read comment value via ref instead of controlled
      state — sendCommentDirectly reads commentRef.current?.value, handleSave
      reads it the same way.

      3. Remove newComment / setNewComment state from TaskModal and
      useImageAttachment (the paste/drop handlers write to the ref value
      directly, or trigger a local state update inside CommentBox).

      4. Keep the clear-on-send path: after send, call a reset() method on
      CommentBox via imperative ref.


      Files: portal/src/components/task-modal/CommentBox.tsx,
      portal/src/components/TaskModal.tsx,
      portal/src/hooks/useImageAttachment.ts


      Validation: open a ticket with an active session, type rapidly in the
      comment box — no lag even during 2500ms polls.
    id: c-2026-05-11t02-25-49-479z
  - type: activity
    user: Agent
    date: '2026-05-11T02:26:09.755Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-11T02:26:13.542Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-11T02:26:25.860Z'
    comment: Launched Claude Code session (dcb341f9).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T02:29:19.139Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:29:19.141Z'
    comment: >-
      Starting implementation: converting CommentBox to forwardRef with internal
      state, updating TaskModal and useImageAttachment.
    id: c-2026-05-11t02-29-19-141z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T02:36:02.721Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:36:02.722Z'
    comment: >-
      Implementation complete. Converted CommentBox to a forwardRef component
      with internal state (valueRef + useState). Exposed getValue/reset/setValue
      via useImperativeHandle. Updated useImageAttachment to accept
      commentBoxRef instead of newComment/setNewComment. Updated TaskModal:
      removed newComment state, all consumers read/reset via commentBoxRef.
      requireInputPrompt inline textarea uses separate requireInputDraft (not
      affected by polling). TypeScript compiles clean.
    id: c-2026-05-11t02-36-02-722z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T02:36:09.881Z'
    comment: >-
      FLUX-188 is now in Ready. Here's a summary of what changed:


      **`CommentBox.tsx`** — converted to a `forwardRef` component. The textarea
      value is now local state (`useState` + `valueRef` for sync reads). Removed
      `value`/`onChange` props. Exposes `{ getValue, reset, setValue }` via
      `useImperativeHandle`.


      **`useImageAttachment.ts`** — replaced `newComment`/`setNewComment` params
      with `commentBoxRef: React.RefObject<CommentBoxHandle>`. The paste/drop
      handlers now read the current value via `commentBoxRef.current.getValue()`
      and write via `commentBoxRef.current.setValue()`.


      **`TaskModal.tsx`** — removed `newComment`/`setNewComment` state. Added
      `commentBoxRef` and `requireInputDraft` (for the Require Input inline
      textarea, which is unaffected by polling). All send paths
      (`sendCommentDirectly`, `handleSave`, `submitRequireInputResponse`)
      read/reset via `commentBoxRef`. `isDirty` no longer includes
      `newComment.trim()` since the comment box is no longer a controlled form
      field.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-11T02:36:25.558Z'
  - type: activity
    user: Agent
    date: '2026-05-11T02:36:25.598Z'
    comment: Launched Claude Code session (7508087f).
  - type: activity
    user: Agent
    date: '2026-05-11T02:38:49.515Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-11T02:40:05.073Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-11T02:40:11.953Z'
  - type: activity
    user: Agent
    date: '2026-05-11T02:40:12.113Z'
    comment: Launched Claude Code session (c07790dc).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T02:44:03.475Z'
  - type: comment
    user: Agent
    comment: >-
      Performance review: fix is correct and effective. Moving textarea value
      into CommentBox local state breaks the DOM-mutation chain — during
      polling, CommentBox re-renders but React's controlled-input reconciler
      does not write to the DOM when value is unchanged, so cursor position is
      preserved. valueRef + useState dual-tracking is the right pattern: sync
      reads for send handlers, state-driven rendering for the button disabled
      guard.


      One forward-looking note: handleCommentPaste/DragOver/Drop in
      useImageAttachment.ts are plain functions (not useCallback), unlike the
      reply counterparts which are memoized via the ref-forwarding pattern.
      CommentBox not being React.memo'd means this asymmetry is harmless today,
      but wrapping CommentBox in memo later would silently fail due to unstable
      prop references. If CommentBox memo is ever added, wrap those three
      handlers in useCallback with an empty dep array (they read/write through
      commentBoxRef, which is stable).


      Typescript clean. Typing lag fix passes performance scrutiny.
    date: '2026-05-11T02:44:03.475Z'
    id: c-2026-05-11t02-44-03-475z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T02:44:09.255Z'
    comment: >-
      FLUX-188 is now **Ready**. Performance review passed.


      **Summary:** The implementation is correct. Moving `value` state into
      `CommentBox` local state breaks the exact chain that caused lag — when
      `useCliSession` polls and calls `setCliSession`, TaskModal re-renders and
      CommentBox re-renders, but React's controlled-input reconciler does not
      write to the DOM when the local value is unchanged, so cursor position is
      preserved. The `valueRef + useState` dual-tracking is the right pattern
      for this use case.


      One forward-looking note left in the ticket:
      `handleCommentPaste/DragOver/Drop` in `useImageAttachment.ts` are plain
      functions while the reply counterparts use `useCallback`. The asymmetry is
      harmless today since `CommentBox` isn't `React.memo`'d, but if memo is
      added later, those three handlers would need `useCallback` wrapping to
      avoid silent perf regression.
  - type: activity
    user: Agent
    date: '2026-05-11T02:45:45.516Z'
    comment: Launched Claude Code session (5bad293b).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T02:46:16.366Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:46:16.367Z'
    comment: >-
      Implemented. CommentBox now owns its textarea value as local state;
      TaskModal reads/clears via commentBoxRef (getValue/reset/setValue).
      useImageAttachment updated to append through the ref. Typing lag during
      polling cycles is eliminated. Commit: 3fcabad.
    id: c-2026-05-11t02-46-16-367z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T02:46:22.549Z'
    comment: >-
      FLUX-188 is done. Commit `3fcabad` — `CommentBox` now owns its textarea
      value locally, breaking the polling re-render chain that caused the input
      lag.
  - type: activity
    user: Agent
    date: '2026-05-11T03:03:20.926Z'
    comment: Claude Code session lost (engine restarted).
title: lag on typing comment box of a ticket whose currently active agent session
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 447637
  outputTokens: 11746
  costUSD: 0.541912
  costIsEstimated: false
order: 0
---
## Problem

When a ticket has an active agent session, useCliSession polls the engine every 2500ms and calls setCliSession() on each response. This state lives in TaskModal, causing a full re-render of the component tree -- including CommentBox -- on every poll. Because newComment is controlled state in TaskModal, the textarea re-renders mid-keystroke and causes perceptible input lag.

## Root Cause

- useCliSession interval fires every 2500ms, setCliSession(session) is called, TaskModal re-renders
- CommentBox receives new props on each re-render (value={newComment})
- React reconciles the textarea on every poll tick, interrupting typing

## Fix

Make the comment textarea uncontrolled by moving newComment state into CommentBox as local state. Expose the current value and a reset method via useImperativeHandle so TaskModal can still read and clear the value when sending.

### Steps

1. CommentBox.tsx -- convert to a forwardRef component with local value state. Expose { getValue(): string; reset(): void } via useImperativeHandle. Remove value and onChange from props.

2. TaskModal.tsx -- replace newComment / setNewComment controlled state with reads from commentRef.current?.getValue(). Update sendCommentDirectly, handleSave, and any other consumer. After a successful send, call commentRef.current?.reset().

3. useImageAttachment.ts -- paste/drop handlers currently append to newComment state. Expose an appendValue(text) method via the imperative ref, or pass a callback into CommentBox that appends to its local state.

4. isDirty guard -- currently includes newComment.trim() !== empty string. Replace with a check against commentRef.current?.getValue()?.trim() or remove (comment box non-empty is not a form-dirty condition).

## Files

- portal/src/components/task-modal/CommentBox.tsx
- portal/src/components/TaskModal.tsx
- portal/src/hooks/useImageAttachment.ts

## Validation

Open a ticket with an active CLI session, type rapidly in the comment box -- input should remain smooth with no lag even during polling cycles.
t appends to its local state.

4. isDirty guard -- currently includes newComment.trim() !== empty string. Replace with a check against commentRef.current?.getValue()?.trim() or remove (comment box non-empty is not a form-dirty condition).

## Files

- portal/src/components/task-modal/CommentBox.tsx
- portal/src/components/TaskModal.tsx
- portal/src/hooks/useImageAttachment.ts

## Validation

Open a ticket with an active CLI session, type rapidly in the comment box -- input should remain smooth with no lag even during polling cycles.
rty condition).

## Files

- portal/src/components/task-modal/CommentBox.tsx
- portal/src/components/TaskModal.tsx
- portal/src/hooks/useImageAttachment.ts

## Validation

Open a ticket with an active CLI session, type rapidly in the comment box -- input should remain smooth with no lag even during polling cycles.
t appends to its local state.

4. isDirty guard -- currently includes newComment.trim() !== empty string. Replace with a check against commentRef.current?.getValue()?.trim() or remove (comment box non-empty is not a form-dirty condition).

## Files

- portal/src/components/task-modal/CommentBox.tsx
- portal/src/components/TaskModal.tsx
- portal/src/hooks/useImageAttachment.ts

## Validation

Open a ticket with an active CLI session, type rapidly in the comment box -- input should remain smooth with no lag even during polling cycles.
