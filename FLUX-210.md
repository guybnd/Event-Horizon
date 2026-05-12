---
priority: Low
effort: XS
assignee: Agent
tags:
  - dx
  - engine
  - agent-workflow
createdBy: Unknown
title: Add --body and --body-file flags to patch-ticket CLI
status: Released
updatedBy: Unknown
history:
  - type: activity
    user: Unknown
    date: '2026-05-12T02:22:36.561Z'
    comment: Created ticket.
  - type: status_change
    from: Done
    to: Released
    user: Unknown
    date: '2026-05-12T09:17:16.654Z'
version: 0.4.0
---
## Summary

Added `--body <text>` and `--body-file <path>` flags to `patch-ticket` so agents can update the ticket body (implementation plan) without resorting to direct file edits or a separate API call.

## Changes

- `engine/src/patch-ticket.ts`: parse `--body` and `--body-file` flags; resolve body content and pass it to `matter.stringify` instead of the original `parsed.content`
- `.docs/skills/event-horizon-implementation.md`: added `--body` / `--body-file` examples to the patch-ticket section; clarified that body updates must go through patch-ticket, not direct file edits
- `.docs/skills/event-horizon-grooming.md`: updated "Text Output vs Ticket Body" section to list `patch-ticket --body` as the canonical method and call out that `--status` and `--body` are separate flags that must both be passed explicitly

## Root Cause Fixed

Agents were moving tickets to `Todo` with `patch-ticket --status` and separately writing a plan to chat, but never updating the ticket body. The missing `--body` flag was the gap — there was no CLI path to write the plan body without a raw file edit or a direct API call.
