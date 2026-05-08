---
assignee: unassigned
tags:
  - ux
  - feature
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T14:09:50.074Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. ReleasesScreen renders each version as a static card block. Plan:
      add local collapsed state per version using React useState (or a Set),
      render a chevron toggle button in the version header row, and hide the
      task grid when collapsed. Default state: expanded. No routing or
      persistence needed.
    id: c-flux97-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T04:00:08.078Z'
    comment: test inline comment
    replyTo: c-flux97-groom
    id: c-2026-05-08t04-00-08-078z
title: release surface - make releases collapsible for easy navigation
status: Todo
createdBy: Guy
updatedBy: Guy
---

# Goal

Allow users to collapse individual release version sections on the Releases screen so they can quickly navigate to older or newer releases without scrolling through all tickets.

# Implementation Plan

1. In `portal/src/components/ReleasesScreen.tsx`, add a `collapsedVersions` state: `useState<Set<string>>(new Set())`.
2. For each version card header, add a chevron button (using `ChevronDown`/`ChevronUp` from lucide-react) that toggles the version key in the set.
3. Conditionally render the task grid only when the version is not collapsed.
4. Default: all versions expanded.

# Validation

- Releases screen shows chevron per version.
- Clicking chevron hides/shows the task grid for that version independently.
- Other versions are unaffected.

