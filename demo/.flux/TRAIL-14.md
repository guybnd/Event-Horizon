---
id: TRAIL-14
title: Migrate map renderer to MapLibre GL
status: Done
priority: High
effort: XL
assignee: Devin
tags:
  - feature
  - maps
  - perf
createdBy: Devin
updatedBy: Agent
implementationLink: 'https://github.com/trailhead-app/trailhead/pull/97'
history:
  - type: activity
    user: Devin
    date: '2026-04-10T10:00:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-04-12T10:00:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-04-15T09:00:00.000Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-04-28T15:00:00.000Z'
  - type: comment
    id: c-trail14-ready
    user: Devin
    date: '2026-04-28T15:01:00.000Z'
    comment: >-
      Replaced the legacy raster renderer with MapLibre GL: vector tiles,
      smoother pan/zoom, and the foundation for the offline-tile work (TRAIL-2).
    summary: >-
      TRAIL-14 ready: migrated to MapLibre GL vector renderer — smoother
      pan/zoom, foundation for offline tiles (TRAIL-2).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-04-30T12:00:00.000Z'
---
# Migrate map renderer to MapLibre GL

Replaced the legacy raster map with MapLibre GL (vector tiles). Smoother pan/zoom, smaller download sizes, and the groundwork for offline tile caching (TRAIL-2). Shipped in 2.2.
