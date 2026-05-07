---
assignee: unassigned
tags:
  - feature
priority: Low
effort: S
implementationLink: ''
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
title: separate the filter and sorting section from the top bar
status: In Progress
createdBy: Guy
updatedBy: Agent
---
need a nicer distinct page layout.. lets consider how it will look best.
we can keep the search in the top bar and it can return actual results like a jira ticket search so it can also return for me stuff from the backlog etc. with a fuzzy search, and separately have a filter search bar in the board itself along with the sorting and filters
