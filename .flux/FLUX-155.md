---
assignee: unassigned
tags:
  - bug
priority: High
effort: XS
implementationLink: c01c04e
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T04:00:00.000Z'
    comment: >-
      Completed. Commit c01c04e.


      - `TaskMarkdown` wrapped with `React.memo` — history entries skip
      re-render on every comment keystroke since their props are stable.

      - `originalPayload` and `currentPayload` in `TaskModal` wrapped with
      `useMemo` — `normalizeTaskMarkdownBody` no longer runs on every render.


      TypeScript check passed. Validated by typing in the comment box on a
      ticket with multiple history entries.
    id: c-2026-05-09t04-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:00:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T03:52:56.685Z'
  - type: activity
    user: Agent
    date: '2026-05-09T03:52:56.685Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T03:52:59.561Z'
    comment: >-
      ```text

      FLUX-155 is done. Commit `c01c04e` — `TaskMarkdown` is now memoized and
      the payload computations in `TaskModal` use `useMemo`, eliminating the
      re-render chain that caused comment input lag.

      ```
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.356Z'
title: commenting inside a ticket full view comment box VERY LAGGY
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.356Z'
releaseDocPath: release-notes/0.2.0
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
