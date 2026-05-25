---
assignee: unassigned
tags:
  - feature
  - docs
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T13:57:13.082Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. Plan: extend the TaskMarkdown renderer used in DocsScreen to
      detect ticket ID patterns (e.g. FLUX-\d+) in link hrefs or as autolinks
      and render them as navigable internal links. Hover tooltip showing ticket
      title and status can reuse the existing hover-popup infrastructure. S
      effort if we start with clickable links; tooltip/hover adds to M.
    id: c-flux94-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T06:07:36.585Z'
title: link to tickets from doc markdowns
status: Backlog
createdBy: Guy
updatedBy: Guy
---

# Goal

In DocsScreen markdown content and release notes, ticket IDs (e.g. `FLUX-42`) should be rendered as clickable internal links that navigate to or open the matching ticket. Optionally, hovering the link shows a tooltip with the ticket title and status.

# Implementation Plan

1. **Extend `TaskMarkdown.tsx`** (or create a doc-specific variant) with a custom `remark` plugin or `rehype` plugin that detects bare ticket IDs matching `/FLUX-\d+/` in text nodes and wraps them in `<a>` elements.

   Alternatively, use the ReactMarkdown `components` prop to intercept link rendering: if the href matches a ticket ID pattern, render a special `<TicketLink>` component.

2. **`TicketLink` component:**
   - Looks up the ticket from `AppContext` tasks by ID.
   - On click: calls `openTaskModal(ticket)` or navigates to `/board?task=FLUX-xx`.
   - On hover: shows a small popover with title, status badge, and assignee — reuse the existing hover-popup infrastructure from TaskCard.

3. **Release notes** already render through `TaskMarkdown` so they get this for free.

4. **Opt-in pattern:** only hyperlink IDs that resolve to a known ticket. Unknown IDs remain plain text to avoid broken links.

# Validation

- In a doc with `FLUX-42` in the text, the ID renders as a styled link.
- Clicking it opens the ticket modal.
- Hovering shows the ticket title and status.
- An unknown ID like `FLUX-9999` is not linked.
