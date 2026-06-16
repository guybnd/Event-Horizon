---
id: TRAIL-4
title: Redesign first-run onboarding flow
status: Todo
priority: Medium
effort: L
assignee: unassigned
tags:
  - feature
  - onboarding
createdBy: Maya
updatedBy: Agent
subtasks:
  - TRAIL-5
  - TRAIL-6
history:
  - type: activity
    user: Maya
    date: '2026-06-05T13:00:00.000Z'
    comment: Created ticket.
  - type: comment
    id: c-trail4-scope
    user: Maya
    date: '2026-06-05T13:20:00.000Z'
    comment: >-
      Split into two subtasks: the welcome carousel (TRAIL-5) and
      location-permission priming (TRAIL-6). Ship the carousel first; priming
      depends on its final screen.
    summary: >-
      TRAIL-4 scoped into TRAIL-5 (welcome carousel) + TRAIL-6 (location
      permission priming); carousel ships first.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-06-05T13:25:00.000Z'
---
# Redesign first-run onboarding flow

## Problem / Motivation
First-run drop-off is high — users hit a raw map and a system location prompt with no context. A short, friendly intro should lift activation.

## Plan
Two subtasks:
- **TRAIL-5** — welcome carousel introducing the three core features.
- **TRAIL-6** — prime the location permission *before* the OS dialog so users understand why it's needed.
