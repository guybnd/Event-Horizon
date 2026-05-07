---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T01:32:36.327Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      This needs one scope choice before it is ready for `Todo`. Should the
      first slice unify only the ticket-description surfaces (popup, full view,
      backlog-related ticket editing), or do you want the docs editor itself
      refactored into the same shared component in this initial ticket?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-51
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T03:26:13.694Z'
    comment: >-
      i feel like all description surfaces should be the same unified component
      that maybe can simply operate in different modes but shared component
      code. LMK if this is not a correct approach
    id: c-2026-05-07t03-26-13-694z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T03:26:13.694Z'
    comment: Response submitted
title: extend docs WYSIWIG editor to other sections
status: Grooming
createdBy: Guy
updatedBy: Guy
---
as this editor view serves the main functionality we should use the same code and edit style and page style across all 'decription' sections in the project, from backlog, to ticket description full screen, to pop up view
we should have one centralized repurposed code for this instead of separate one in each area that just inefficient
