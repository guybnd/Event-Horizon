---
id: TRAIL-2
title: Cache offline map tiles for no-signal hikes
status: Grooming
priority: High
effort: L
assignee: unassigned
tags:
  - feature
  - offline
  - maps
createdBy: Maya
updatedBy: Agent
swimlane: require-input
history:
  - type: activity
    user: Maya
    date: '2026-06-10T08:30:00.000Z'
    comment: Created ticket.
  - type: comment
    id: c-trail2-q
    user: Maya
    date: '2026-06-11T15:20:00.000Z'
    comment: >-
      Need a product decision before grooming further: **what hard cap should we
      put on the offline tile cache?**


      Proposed default: **2 GB**, evict least-recently-viewed regions first,
      with a per-region "keep offline" pin that is exempt from eviction.
      Alternatives: 1 GB (safer on low-end devices) or user-configurable (more
      work, more support load).


      Default if no answer: ship 2 GB + LRU eviction + pinned regions.
    summary: >-
      Require Input on TRAIL-2: what hard cap for offline tile cache? Proposed
      default 2 GB + LRU eviction + pinned regions exempt; alternatives 1 GB or
      user-configurable.
---
# Cache offline map tiles for no-signal hikes

## Problem / Motivation
Trails routinely lose cell signal. Without pre-cached tiles the map goes blank exactly when navigation matters most.

## Open question (blocking)
What hard cap should bound the offline tile cache, and what eviction policy? See the Require Input comment — proposed default is 2 GB + LRU eviction with pinned regions exempt.

## Sketch (pending the decision above)
- Download tiles for a user-selected region at chosen zoom levels.
- Store in a dedicated cache with a size ceiling + eviction policy.
- Surface cache usage in Settings so users can manage space.
