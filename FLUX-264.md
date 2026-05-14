---
id: FLUX-264
title: Remove shell:true from Windows agent spawn calls
status: Grooming
priority: Medium
effort: S
assignee: unassigned
tags:
  - engine
  - security
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-14T09:42:00.000Z'
    comment: Created from Node DEP0190 warning observed in Gemini CLI session output. shell:true with args is a deprecation path and mild injection risk.
---

## Problem / Motivation

`spawn(exe, args, { shell: true })` in `copilot.ts:271` and `gemini.ts:493/735` triggers Node's DEP0190 deprecation warning. With `shell: true`, args are concatenated unescaped — ticket content containing shell metacharacters (`;`, `&&`, backticks) could execute arbitrary commands. Node will eventually remove this pattern.

## Implementation Plan

- `copilot.ts:271`: Already resolves `gh.exe` directly — remove `shell: true`, it's not needed when spawning the exe directly.
- `gemini.ts:493,735`: The fallback path uses `shell: true` for `.cmd/.ps1` wrappers. Either resolve the node entry point (already done in the primary path) or use `execFile` with explicit shell escaping.
- Test on Windows to verify spawn still works without `shell: true` when the direct exe path is resolved.

Touchpoints: `engine/src/agents/copilot.ts`, `engine/src/agents/gemini.ts`.
