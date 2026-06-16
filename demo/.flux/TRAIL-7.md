---
id: TRAIL-7
title: Crash when exporting an empty route
status: Ready
priority: Critical
effort: S
assignee: Devin
tags:
  - bug
createdBy: Devin
updatedBy: Agent
branch: flux/TRAIL-7-crash-empty-route-export
tokenMetadata:
  inputTokens: 96200
  outputTokens: 2010
  costUSD: 0.16
  costIsEstimated: false
  cacheReadTokens: 88400
  cacheCreationTokens: 9800
history:
  - type: activity
    user: Devin
    date: '2026-06-13T18:45:00.000Z'
    comment: Created ticket.
  - type: comment
    id: c-trail7-repro
    user: Devin
    date: '2026-06-13T18:47:00.000Z'
    comment: >-
      Repro: open a brand-new trail with zero recorded points → tap Export GPX →
      hard crash. Stack points at `route.points[0]` in the GPX serializer.
    summary: >-
      TRAIL-7 repro: exporting a trail with zero points crashes at
      route.points[0] in the GPX serializer.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-06-14T09:00:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-14T09:30:00.000Z'
  - type: agent_session
    sessionId: c7e1b8d0-5a92-4d3f-8e10-6b4c2f9a7d33
    startedAt: '2026-06-14T09:32:00.000Z'
    endedAt: '2026-06-14T09:58:00.000Z'
    date: '2026-06-14T09:32:00.000Z'
    user: Claude Code
    status: completed
    outcome: Claude Code session ended with code 0.
    progress:
      - timestamp: '2026-06-14T09:33:00.000Z'
        message: Reproducing the empty-route crash
        type: topic
      - timestamp: '2026-06-14T09:41:00.000Z'
        message: >-
          Guard added: GPX export now returns an empty-track file instead of
          indexing points[0]
        type: tool
      - timestamp: '2026-06-14T09:50:00.000Z'
        message: Added a regression test for the zero-point export path
        type: tool
      - timestamp: '2026-06-14T09:57:00.000Z'
        message: >-
          Crash fixed and covered by a test; export of an empty route now yields
          a valid empty GPX.
        type: text
    finalMessage: >-
      Crash fixed and covered by a test; export of an empty route now yields a
      valid empty GPX.
    originalProgressCount: 22
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-14T10:15:00.000Z'
  - type: comment
    id: c-trail7-ready
    user: Agent
    date: '2026-06-14T10:16:00.000Z'
    comment: >-
      Fixed: guarded the GPX serializer against zero-point routes (returns a
      valid empty `<trk>` instead of crashing). Added a regression test. Ready
      for review — diff is on the PR branch.
    pin: true
    summary: >-
      REVIEW HANDOFF — TRAIL-7 ready: guarded GPX serializer against zero-point
      routes (valid empty <trk> instead of crash) + regression test. Diff on PR
      branch.
---
# Crash when exporting an empty route

## Bug
Exporting a trail with zero recorded points crashes the app — the GPX serializer assumes `route.points[0]` exists.

## Fix
Guard the serializer: a zero-point route now produces a valid empty `<trk>` document. Added a regression test covering the empty-export path.
