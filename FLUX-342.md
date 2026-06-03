---
priority: High
effort: S
tags:
  - bug
  - portal
title: Fix code review button not moving ticket or adding comments
status: Done
createdBy: guy
updatedBy: guy
assignee: unassigned
history:
  - type: activity
    user: guy
    date: '2026-06-03T03:31:00.308Z'
    comment: Created ticket.
  - type: activity
    user: guy
    date: '2026-06-03T03:31:17.666Z'
    comment: Updated implementation link.
  - type: comment
    user: Agent
    comment: >-
      Implemented in commit 8867a3ab79f2694848e5cd5e5ff303476dcebc20. Fixed
      TaskCard.tsx sendReview to use persona.prompt and move ticket to In
      Progress first. Updated all 5 CodeReviewButton persona prompts to use
      add_comment + change_status MCP tools.
    date: '2026-06-03T03:31:17.666Z'
    id: c-2026-06-03t03-31-17-666z
implementationLink: 8867a3ab79f2694848e5cd5e5ff303476dcebc20
---
## Problem / Motivation

The "Send for Code Review" button on ticket cards (`TaskCard.tsx`) was broken in two ways: it passed a raw CLI command string (`"review FLUX-xxx --persona architect"`) instead of the actual persona prompt, and it never moved the ticket to In Progress before starting the session. This caused `buildInitialPrompt` to emit a "do not move it further" instruction, completely blocking the reviewer agent from doing anything.

Additionally, all five review persona prompts in `CodeReviewButton.tsx` instructed the agent to use `PUT /api/tasks/:id` with `appendHistory` (REST API), which directly conflicted with the `CRITICAL: Use MCP tools` override injected by `buildInitialPrompt`.

## Implementation Plan

1. Fix `TaskCard.tsx` `sendReview`: move ticket to In Progress first via `updateTask`, then call `startTaskCliSession` with `persona.prompt` (matching the working `TaskModal` path).
2. Update all 5 persona prompts in `CodeReviewButton.tsx` to use `add_comment` and `change_status` MCP tools instead of the REST `appendHistory` pattern.
