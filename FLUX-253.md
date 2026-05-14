---
title: Fix settings dirty check missing fields
status: Released
assignee: Copilot
priority: High
created: 2026-05-14T02:41:52.512Z
updated: 2026-05-14T02:41:52.512Z
history:
  - type: activity
    user: Unknown
    date: '2026-05-14T02:41:52.512Z'
    comment: Created ticket.
  - type: activity
    user: Copilot
    date: '2026-05-14T02:41:52.512Z'
    comment: >-
      Created ticket. Settings dirty check is missing several fields, causing
      the save bar not to appear when those settings change. Also handleDiscard
      does not reset tokenDisplayMode, agentProgressEnabled, or
      agentProgressDelay.

      Plan: 1. Add tokenCostThresholds, generateDistinctFiles, releaseNotesPath,
      agentProgressEnabled, agentProgressDelay to currentSavedPayload and
      originalPayload in the isDirty comparison. 2. Add setTokenDisplayMode,
      setAgentProgressEnabled, setAgentProgressDelay to handleDiscard.
  - type: status_change
    from: In Progress
    to: Done
    user: Guy
    date: '2026-05-14T02:57:39.066Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-14T10:59:32.384Z'
order: 1
updatedBy: Guy
version: v0.6.0
releasedAt: '2026-05-14T10:59:32.384Z'
releaseDocPath: release-notes/v0.6.0
---

## Problem / Motivation

In `Settings.tsx`, the `isDirty` flag is computed by comparing `currentSavedPayload` vs `originalPayload`. Several settings state variables are saved in `handleSave` but are **absent from both payloads**, so changes to them never flip `isDirty`, the save bar never appears, and the user's changes are silently lost on tab switch or navigation.

Missing from dirty check:
- `tokenCostThresholds`
- `generateDistinctFiles`
- `releaseNotesPath`
- `agentProgressEnabled`
- `agentProgressDelay`

Additionally, `handleDiscard` does not reset:
- `tokenDisplayMode`
- `agentProgressEnabled`
- `agentProgressDelay`

## Implementation Plan

- Add the five missing fields to `currentSavedPayload` and `originalPayload` in `Settings.tsx`.
- Add the three missing `set*` calls inside `handleDiscard`.
