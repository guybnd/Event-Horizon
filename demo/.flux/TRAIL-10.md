---
id: TRAIL-10
title: Battery drains fast during long recordings
status: In Progress
priority: High
effort: M
assignee: Maya
tags:
  - bug
  - perf
createdBy: Maya
updatedBy: Agent
history:
  - type: activity
    user: Maya
    date: '2026-06-11T08:00:00.000Z'
    comment: Created ticket.
  - type: comment
    id: c-trail10-data
    user: Maya
    date: '2026-06-11T08:30:00.000Z'
    comment: >-
      Field reports: ~18%/hr battery during recording. Profiler points at GPS
      polling at max accuracy + frequent screen wakeups.
    summary: >-
      TRAIL-10: ~18%/hr battery drain during recording; cause = max-accuracy GPS
      polling + frequent screen wakeups.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-06-11T08:35:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-12T09:00:00.000Z'
  - type: comment
    id: c-trail10-progress
    user: Maya
    date: '2026-06-12T16:00:00.000Z'
    comment: >-
      Switched to balanced-accuracy polling when stationary; investigating
      deferred location updates next. Coordinating with TRAIL-1 sampling.
    summary: >-
      TRAIL-10 progress: balanced-accuracy polling when stationary; next is
      deferred location updates; coordinating with TRAIL-1 sampling.
---
# Battery drains fast during long recordings

## Problem
Recording a multi-hour hike eats ~18%/hr of battery. Root cause: GPS polling at maximum accuracy plus frequent screen wakeups.

## Plan
- Drop to balanced accuracy when the hiker is stationary.
- Batch deferred location updates.
- Re-check against TRAIL-1's speed-adaptive sampling so the two don't fight.
