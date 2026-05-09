---
assignee: unassigned
tags:
  - bug
priority: High
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T03:52:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T03:52:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T03:52:01.000Z'
    comment: >-
      Implemented two fixes:

      1. Wrapped `TaskMarkdown` with `React.memo` so history entries do not
      re-render on comment keystrokes.

      2. Memoized `originalPayload` and `currentPayload` in `TaskModal` with
      `useMemo` to avoid running `normalizeTaskMarkdownBody` on every render.


      TypeScript type-check passes with no errors. Ready for review.
    id: c-2026-05-09t03-52-01-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T03:51:54.651Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T03:51:58.756Z'
    comment: >-
      ```text

      Done. Two changes made:


      1. **`TaskMarkdown.tsx`** — wrapped the component with `React.memo`.
      History entries now skip re-rendering when the comment box value changes
      (their props are stable).

      2. **`TaskModal.tsx`** — wrapped `originalPayload` and `currentPayload` in
      `useMemo` so `normalizeTaskMarkdownBody` doesn't run on every keystroke.


      Ticket is in `Ready` — let me know when you want to `finish FLUX-155`.

      ```
  - type: activity
    user: Agent
    date: '2026-05-09T03:52:24.641Z'
    comment: Launched Claude Code session (237adcf9).
title: commenting inside a ticket full view comment box VERY LAGGY
status: Ready
createdBy: Guy
updatedBy: Agent
---
## Problem

Typing in the comment textarea inside the ticket full view is laggy because every keystroke triggers a full re-render of `TaskModal`, which in turn re-renders all `TaskMarkdown` instances in the history feed. Each `TaskMarkdown` call runs `ReactMarkdown` with `remarkGfm`, which parses and renders markdown — an expensive operation. With many history entries this compounds and causes visible input lag.

## Root Cause

`TaskMarkdown` (`portal/src/components/TaskMarkdown.tsx`) is not memoized. Since it receives props that do not change on comment keystrokes (e.g., `body`, `taskId`, `compact`, `imageMode`), wrapping it with `React.memo` will skip re-rendering existing history entries while the user types.

Secondarily, `originalPayload` and `currentPayload` (lines 425-448 of `TaskModal.tsx`) call `normalizeTaskMarkdownBody` on every render without memoization — a minor but fixable overhead.

## Implementation Plan

1. Wrap the `TaskMarkdown` export in `React.memo` in `portal/src/components/TaskMarkdown.tsx`.
2. Memoize `originalPayload` and `currentPayload` in `TaskModal.tsx` using `useMemo` so `normalizeTaskMarkdownBody` does not run on every comment keystroke.

## Validation

- Open a ticket with several history comments in the full view.
- Type in the comment box and verify input is no longer laggy.
- Confirm existing comments still render correctly.
