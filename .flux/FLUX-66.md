---
title: refresh docs for recent settings surfaces
status: Done
priority: Medium
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - docs
  - task
history:
  - type: activity
    user: Guy
    date: '2026-05-07T14:46:00.000+10:00'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T14:46:00.000+10:00'
    comment: >-
      Captured from the request to review the latest completed tickets for any
      remaining docs gaps. The attachment flow is already covered in Ticket
      Interactions, but the newer Settings-backed workflow and interaction
      controls are still scattered across the README and isolated doc mentions.
      Plan: refresh the in-product docs so Settings behavior is easier to find,
      then validate the docs through the live API or portal build.
    id: c-2026-05-07t14-46-00-000-10-00-flux-66
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T14:46:00.000+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T14:52:00.000+10:00'
    comment: >-
      Reviewed the latest completed tickets against the current docs set. The
      attachment flow and recent interaction changes were already covered in
      `Ticket Interactions`, so the remaining gap was the Settings-driven
      workflow controls that only existed in the README. Updated
      `workflow/workflow-install` to document the workflow source and installed
      paths, the copyable install command, and the configurable user-input and
      ready-for-merge status selectors. Validated with a live `GET
      http://localhost:3001/api/docs` check confirming the updated section
      parses through the docs API. No focused commit was created because the
      current worktree still contains unrelated in-flight changes.
    id: c-2026-05-07t14-52-00-000-10-00-flux-66
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T14:52:00.000+10:00'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-07T05:00:32.073Z'
effort: XS
implementationLink: ''
subtasks: []
order: 13
---
## Summary

Review the latest completed tickets and refresh the repo docs where recent
Settings-backed behavior is still under-documented.

## Requirements

### 1. Confirm the real gaps from recent completed work
- Re-check the most recent `Done` tickets rather than assuming every recent UI
  change needs docs
- Keep features that are already clearly documented out of scope for this pass

### 2. Promote remaining Settings behavior into the docs tree
- Update the nearest existing docs pages so the portal's Settings surface is
  easier to understand from `.docs/`
- Cover the durable workflow and interaction controls that now live in
  Settings, rather than leaving them discoverable only through the README or
  ticket history

### 3. Revalidate the docs after editing
- Confirm the updated docs still parse cleanly through the project surfaces

## Acceptance Criteria

- [ ] Recent completed tickets have been checked for doc coverage gaps
- [ ] The real remaining Settings-related docs gap is covered in `.docs/`
- [ ] The updated docs still parse cleanly after the refresh---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T04:50:17.787Z'
    comment: Created ticket.
id: FLUX-66
title: ticket view should keep top bar
status: Grooming
createdBy: Guy
updatedBy: Guy
---
both popup and full ticket view should still keep the top bar navigation, to allow search to go to other  ticket, and navigate to specific windows from there if wanted.
