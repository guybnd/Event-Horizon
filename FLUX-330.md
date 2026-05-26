---
id: FLUX-330
title: Investigate how API/MCP writes corrupt ticket YAML structure
status: Grooming
priority: Medium
effort: None
assignee: unassigned
tags: []
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-26T10:40:38.742Z'
    comment: Created as subtask of FLUX-329.
---
## Problem / Motivation

Despite agents using the official API and MCP tools (not editing files directly), tickets still end up with malformed YAML � e.g. `oldStatus/newStatus` instead of `from/to`, missing `title`, broken subtask arrays. This keeps recurring and needs a root-cause investigation.

## Investigation Scope

1. Audit all write paths in `engine/src/routes/tasks.ts` and MCP tool handlers � identify where user-supplied history entries bypass schema normalization
2. Check if `appendHistory` accepts raw entries without validating/normalizing field names
3. Check if any race conditions in file watching + concurrent writes can produce partial YAML
4. Determine if the issue is agent-side (sending wrong field names) or engine-side (not normalizing input)
5. Propose a fix: either strict input validation that rejects bad shapes, or automatic normalization on write
