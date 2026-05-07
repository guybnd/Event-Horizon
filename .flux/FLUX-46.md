---
assignee: unassigned
tags:
  - feature
priority: Low
effort: S
implementationLink: 7f0f6c5
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-06T14:24:31.702Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-06T14:24:37.024Z'
    comment: Changed effort from None to S.
  - type: activity
    user: Guy
    date: '2026-05-06T14:24:40.820Z'
    comment: Changed priority from None to Medium.
  - type: activity
    user: Guy
    date: '2026-05-06T14:24:43.263Z'
    comment: Changed priority from Medium to Low.
  - type: activity
    user: Guy
    date: '2026-05-06T14:24:50.801Z'
    comment: Updated tags to feature.
  - type: activity
    user: Guy
    date: '2026-05-07T01:49:38.688Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-07T01:51:05.5213574Z'
    comment: >-
      Plan: split the current header task controls into a global fuzzy ticket
      search in the top bar and a page-level filter/sort section for the board
      and backlog, then refresh the interaction docs and validate the portal
      build.
    id: c-2026-05-07t01-51-05-5213574z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T01:51:05.5213574Z'
  - type: comment
    user: Agent
    date: '2026-05-07T01:56:56.6897923Z'
    comment: >-
      User feedback: the new board and backlog filter section is taking too much
      vertical space. Compressing it into a denser toolbar-style layout while
      keeping the header-only global search split.
    id: c-2026-05-07t01-56-56-6897923z
  - type: comment
    user: Agent
    date: '2026-05-07T02:02:06.2044854Z'
    comment: >-
      Progress: collapsed the advanced sort and metadata filters behind a
      compact toolbar, kept the board and backlog local search field visible,
      refreshed the search interaction docs, and fixed a YAML parsing mistake in
      this ticket history so the engine now picks up the live In Progress state
      again.
    id: c-2026-05-07t02-02-06-2044854z
  - type: comment
    user: Agent
    date: '2026-05-07T02:06:26.4930712Z'
    comment: >-
      User redirect: making the header search results real ticket links so
      browser actions like middle-click, open in new tab, and standard link
      context menus work instead of relying on button-only interactions.
    id: c-2026-05-07t02-06-26-4930712z
  - type: comment
    user: Agent
    date: '2026-05-07T02:09:48.2845991Z'
    comment: >-
      User redirect: board card clicks should open tickets in the full-screen
      view rather than the popup view, keeping popup mode for explicit quick
      board editing actions.
    id: c-2026-05-07t02-09-48-2845991z
  - type: comment
    user: Agent
    date: '2026-05-07T02:11:54.4339242Z'
    comment: >-
      Correction: the intended split is the opposite. Header search results
      should open tickets in full view, while clicking a ticket card from the
      board should keep using the popup view.
    id: c-2026-05-07t02-11-54-4339242z
  - type: comment
    user: Agent
    date: '2026-05-07T12:13:27.3068907+10:00'
    comment: >-
      Completed the search and filter split in `7f0f6c5`. The header now owns a
      global fuzzy ticket lookup with real deep links, while the board and
      backlog each keep their own compact local search, sort, and collapsible
      metadata filters. Shared search logic was extracted, the interaction docs
      were refreshed, and the portal build was revalidated with `npm.cmd run
      build -w portal`. The later click-default discussion remains separate
      follow-up work rather than part of this ticket.
    id: c-2026-05-07t12-13-27-3068907-10-00-flux-46
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T12:13:27.3068907+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T02:14:54.7041564Z'
    comment: >-
      Bug follow-up: leaving a full-view ticket via the in-ticket back action
      currently downgrades into the same ticket's popup view instead of closing
      the ticket entirely. Reopening to route the full-view exit path through
      the normal close/discard logic.
    id: c-2026-05-07t02-14-54-7041564z
  - type: status_change
    from: Done
    to: In Progress
    user: Agent
    date: '2026-05-07T02:14:54.7041564Z'
  - type: comment
    user: Agent
    date: '2026-05-07T02:17:45.1650310Z'
    comment: >-
      Fixed the full-view ticket exit regression so both the in-ticket Back to
      Board action and full-view Escape now run through the standard
      close/discard flow instead of reopening the same ticket in popup mode.
      Refreshed the ticket interaction docs, validated with `npm.cmd run build
      -w portal`, confirmed the live `/api/docs` and `/api/tasks` responses, and
      reproduced the browser flow from `/board?ticket=FLUX-46&view=full` back to
      plain `/board`. Commit: pending focused bug-fix commit.
    id: c-2026-05-07t02-17-45-1650310z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T02:17:45.1650310Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.946Z'
title: separate the filter and sorting section from the top bar
status: Released
createdBy: Guy
updatedBy: Agent
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.946Z'
releaseDocPath: release-notes/v0.1.0
---
need a nicer distinct page layout.. lets consider how it will look best.
we can keep the search in the top bar and it can return actual results like a jira ticket search so it can also return for me stuff from the backlog etc. with a fuzzy search, and separately have a filter search bar in the board itself along with the sorting and filters
