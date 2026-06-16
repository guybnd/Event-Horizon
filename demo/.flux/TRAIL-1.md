---
id: TRAIL-1
title: Record GPS breadcrumb trail while hiking
status: In Progress
priority: High
effort: L
assignee: Maya
tags:
  - feature
  - maps
createdBy: Maya
updatedBy: Agent
branch: flux/TRAIL-1-gps-breadcrumb-trail
tokenMetadata:
  inputTokens: 412880
  outputTokens: 7340
  costUSD: 0.71
  costIsEstimated: false
  cacheReadTokens: 388120
  cacheCreationTokens: 41200
history:
  - type: activity
    user: Maya
    date: '2026-06-08T09:12:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-06-08T09:40:00.000Z'
  - type: comment
    id: c-trail1-plan
    user: Maya
    date: '2026-06-08T14:05:00.000Z'
    comment: >-
      Plan: tap into the existing `LocationService` stream, persist points to a
      ring buffer, flush to SQLite every 5s. Render the polyline incrementally
      so the map stays smooth on long hikes. Sampling adapts to speed (denser on
      switchbacks, sparser on straightaways) to keep point count bounded.
    summary: >-
      TRAIL-1 plan: subscribe to LocationService, ring-buffer points, flush to
      SQLite every 5s, incremental polyline render, speed-adaptive sampling to
      bound point count.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-09T10:02:00.000Z'
  - type: agent_session
    sessionId: 11d2e0a4-7c3b-4f6e-9a21-2b8e5f0c4a10
    startedAt: '2026-06-09T10:05:00.000Z'
    endedAt: '2026-06-09T10:38:00.000Z'
    date: '2026-06-09T10:05:00.000Z'
    user: Claude Code
    status: completed
    outcome: Claude Code session ended with code 0.
    progress:
      - timestamp: '2026-06-09T10:05:30.000Z'
        message: Reading LocationService and the map render pipeline
        type: topic
      - timestamp: '2026-06-09T10:08:12.000Z'
        message: Read src/location/LocationService.ts
        type: tool
      - timestamp: '2026-06-09T10:11:48.000Z'
        message: Added BreadcrumbRecorder with a 256-point ring buffer
        type: tool
      - timestamp: '2026-06-09T10:19:05.000Z'
        message: Wired SQLite flush on a 5s timer; added the trails table migration
        type: tool
      - timestamp: '2026-06-09T10:27:41.000Z'
        message: >-
          Incremental polyline now appends points instead of re-drawing the
          layer
        type: tool
      - timestamp: '2026-06-09T10:34:10.000Z'
        message: >-
          Recorder is in place and the polyline updates live; speed-adaptive
          sampling still TODO before review.
        type: text
    finalMessage: >-
      Recorder is in place and the polyline updates live; speed-adaptive
      sampling still TODO before review.
    originalProgressCount: 24
  - type: comment
    id: c-trail1-progress
    user: Agent
    date: '2026-06-09T10:40:00.000Z'
    comment: >-
      Recorder + live polyline landed. Remaining before Ready: speed-adaptive
      sampling and a battery-impact check (coordinate with TRAIL-10).
    summary: >-
      TRAIL-1 progress: recorder + live polyline done; remaining =
      speed-adaptive sampling + battery check (see TRAIL-10).
---
# Record GPS breadcrumb trail while hiking

## Problem / Motivation
Hikers want to see the path they've actually walked, not just their current pin. A live breadcrumb trail is the backbone for stats, sharing, and "find my way back".

## Implementation plan
1. Subscribe to `LocationService` updates and buffer points in a bounded ring buffer.
2. Flush to SQLite every 5s so a crash loses at most a few seconds.
3. Render the polyline incrementally — append, don't redraw — to keep the map smooth on multi-hour hikes.
4. Adapt sampling rate to speed so point count stays bounded.

## Acceptance criteria
- [x] Points stream into a recorder and persist across app restarts.
- [x] Polyline updates live on the map.
- [ ] Sampling adapts to speed; verified battery impact is acceptable.
