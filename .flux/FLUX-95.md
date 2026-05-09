---
title: Support docs deep-linking via URL param query
status: Released
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - ux
priority: Medium
effort: S
implementationLink: 8d6b010bb3149971d91618409e88d347e765bf13
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-08T00:01:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:02:00.000Z'
    comment: >-
      Groomed ticket. We will implement URL param parsing in DocsScreen's
      initialization and update AppContext generic view routing if necessary to
      preserve query parameters when transitioning to the Docs view. No further
      input needed as the ACs are clear.
    id: c-2026-05-08t00-02-00-000z
  - type: status_change
    from: Backlog
    to: Todo
    user: Agent
    date: '2026-05-08T00:02:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T00:02:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T00:15:00.000Z'
    comment: >-
      Implemented URL query param support for Docs: - Reads `doc` param from URL
      via `window.location.search` during component initialization. - Uses
      `flux:navigate` window event to seamlessly transport link requests from
      `ReleasesScreen.tsx` straight to `DocsScreen.tsx` and re-mount. -
      Automatically sets/reads history state cleanly. - Batched commit in
      `8d6b010`.
    id: c-2026-05-08t00-15-00-000z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T00:15:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.366Z'
order: 7
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.366Z'
releaseDocPath: release-notes/0.2.0
---

## Summary

The Releases screen generates release notes in the `.docs` system and links to them using a URL param query (e.g., `/docs?doc=[encoded-path]`). However, the Docs screen (`DocsScreen.tsx`) doesn't currently support parsing this param on mount to automatically select and open the intended document.

## Acceptance Criteria

- [x] Updating the browser path to `/docs?doc=path/to/my-doc.md` automatically selects that document when navigating to the Docs view.
- [x] If the `doc` parameter isn't present, the Docs view falls back to selecting the first document in the hierarchy as it does currently.
- [x] AppContext navigation functions handle routing to the Docs view seamlessly when the payload includes a document path.
