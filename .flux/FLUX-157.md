---
assignee: unassigned
tags:
  - portal
  - ui
priority: High
effort: XS
implementationLink: 2e48b03
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T05:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T05:00:00.000Z'
    comment: >-
      Implemented both fixes in `portal/src/components/TaskMarkdown.tsx`:

      - Extended `isBlock` detection in the `code` component to include fenced
      blocks without a language specifier (checks for newline in children).

      - Added `break-normal` to the `pre` component to override inherited
      `break-words`, so long code lines scroll horizontally instead of wrapping.

      Validated that unlabelled fenced blocks now render with dark background
      and scroll, inline backticks retain inline styling, and language-annotated
      blocks are unaffected. Committed in 2e48b03.
    id: c-flux-157-completion
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T05:00:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:34:06.917Z'
  - type: activity
    user: Agent
    date: '2026-05-09T04:34:06.917Z'
    comment: Updated implementation link.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.357Z'
title: >-
  clayude code replies in code blocks in the comments UI so it makes it hard to
  read since no overflow on rows
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.357Z'
releaseDocPath: release-notes/0.2.0
---
## Problem

Code blocks in the ticket activity feed (comments/agent messages) wrap their content instead of scrolling horizontally, making them hard to read.

Two root causes in `portal/src/components/TaskMarkdown.tsx`:

1. **Block code detection** (`code` component, line 193): only checks `className?.includes("language-")`. Claude’s fenced blocks without a language specifier have no className, so they are rendered with inline code styling (light background, no overflow) even though they are inside a `<pre>` block.

2. **Word-wrap inheritance** (`pre` component, line 199): the parent container has the Tailwind `break-words` class (`overflow-wrap: break-word`), which is inherited by `<pre>` and overrides its `white-space: pre` default, causing long lines to wrap rather than trigger horizontal scroll.

## Fix

In `portal/src/components/TaskMarkdown.tsx`:

- **`code` component**: extend `isBlock` detection to also flag code whose content contains a newline character (`String(children).includes("\\n")`). Fenced blocks always have a trailing newline; inline backticks never do. Remove the redundant `bg-black/90` and `rounded-lg` from the block `<code>` element — the `<pre>` already provides the container background.

- **`pre` component**: add `break-normal` (Tailwind: `overflow-wrap: normal; word-break: normal`) to override the inherited `break-words` from the parent div, ensuring code lines overflow and scroll rather than wrap.

## Validation

- Open a ticket with agent messages containing fenced code blocks (with and without language specifier)
- Verify code blocks render with dark background and horizontal scroll on long lines
- Verify inline backtick code still renders with inline styling
- Verify no regression on ticket body markdown with language-annotated code blocks
