---
title: Support docs deep-linking via URL param query
status: In Progress
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - ux
priority: Medium
effort: S
implementationLink: ''
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
order: 7
---

## Summary

The Releases screen generates release notes in the `.docs` system and links to them using a URL param query (e.g., `/docs?doc=[encoded-path]`). However, the Docs screen (`DocsScreen.tsx`) doesn't currently support parsing this param on mount to automatically select and open the intended document.

## Acceptance Criteria

- [ ] Updating the browser path to `/docs?doc=path/to/my-doc.md` automatically selects that document when navigating to the Docs view.
- [ ] If the `doc` parameter isn't present, the Docs view falls back to selecting the first document in the hierarchy as it does currently.
- [ ] AppContext navigation functions handle routing to the Docs view seamlessly when the payload includes a document path.
