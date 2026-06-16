---
id: TRAIL-3
title: Dark mode theme
status: Done
priority: Medium
effort: M
assignee: Devin
tags:
  - feature
  - ui
createdBy: Devin
updatedBy: Agent
implementationLink: 'https://github.com/trailhead-app/trailhead/pull/142'
tokenMetadata:
  inputTokens: 198400
  outputTokens: 4120
  costUSD: 0.34
  costIsEstimated: false
  cacheReadTokens: 180200
  cacheCreationTokens: 22100
history:
  - type: activity
    user: Devin
    date: '2026-05-20T11:00:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-20T11:30:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-21T09:00:00.000Z'
  - type: agent_session
    sessionId: aa31f9c2-1e44-4c8d-bb70-9f2a6d1e3c55
    startedAt: '2026-05-21T09:05:00.000Z'
    endedAt: '2026-05-21T11:50:00.000Z'
    date: '2026-05-21T09:05:00.000Z'
    user: Claude Code
    status: completed
    outcome: Claude Code session ended with code 0.
    progress:
      - timestamp: '2026-05-21T09:06:00.000Z'
        message: Auditing hard-coded colors across the component library
        type: topic
      - timestamp: '2026-05-21T09:40:00.000Z'
        message: Extracted a semantic color token layer
        type: tool
      - timestamp: '2026-05-21T10:55:00.000Z'
        message: Added a theme toggle that follows the system setting by default
        type: tool
      - timestamp: '2026-05-21T11:48:00.000Z'
        message: Dark mode complete; all screens audited and the toggle persists.
        type: text
    finalMessage: Dark mode complete; all screens audited and the toggle persists.
    originalProgressCount: 22
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-21T12:30:00.000Z'
  - type: comment
    id: c-trail3-ready
    user: Devin
    date: '2026-05-21T12:31:00.000Z'
    comment: >-
      Implemented semantic tokens + a system-following toggle. Every screen
      audited; contrast checked against WCAG AA.
    summary: >-
      TRAIL-3 ready: semantic color tokens + system-following dark mode toggle,
      all screens audited, WCAG AA contrast checked.
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-22T16:00:00.000Z'
  - type: comment
    id: c-trail3-done
    user: Devin
    date: '2026-05-22T16:00:30.000Z'
    comment: 'Merged in #142. Shipped in 2.4.'
---
# Dark mode theme

## Problem / Motivation
Early-morning and dusk hikers want a dark UI that doesn't blind them on the trailhead.

## What shipped
- A semantic color-token layer replacing hard-coded colors.
- A theme toggle that follows the system setting by default.
- WCAG AA contrast verified across every screen.
