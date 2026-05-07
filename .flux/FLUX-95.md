---
title: Support docs deep-linking via URL param query
status: Backlog
createdBy: Guy
updatedBy: Agent
assignee: unassigned
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
order: 7
---

## Summary

The Releases screen generates release notes in the `.docs` system and links to them using a URL param query (e.g., `/docs?doc=[encoded-path]`). However, the Docs screen (`DocsScreen.tsx`) doesn't currently support parsing this param on mount to automatically select and open the intended document.

## Acceptance Criteria

- [ ] Updating the browser path to `/docs?doc=path/to/my-doc.md` automatically selects that document when navigating to the Docs view.
- [ ] If the `doc` parameter isn't present, the Docs view falls back to selecting the first document in the hierarchy as it does currently.
- [ ] AppContext navigation functions handle routing to the Docs view seamlessly when the payload includes a document path.