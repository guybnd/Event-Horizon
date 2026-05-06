---
title: build direct API orchestrator for internal execution mode
status: Backlog
priority: High
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - backend
  - ai
  - agent
history:
  - type: comment
    user: Agent
    date: '2026-05-06T12:42:00.000Z'
    comment: >-
      Captured from the Flux internal AI vision. This ticket covers the active
      execution path that gathers context, prompts an LLM, validates the result,
      and applies safe file changes locally.
    id: c-2026-05-06t12-42-00-000z
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-06T13:18:41.388Z'
effort: Large
implementationLink: ''
subtasks: []
---
## Summary

Implement the internal execution path for Flux so a user can choose one-click
task execution without relying on an external IDE agent. This path should use
the shared execution bridge but own prompt construction, API calls, response
validation, and local file application.

## Requirements

### 1. Gather bounded ticket context
- Gather the ticket requirements, acceptance criteria, and open questions
- Read the source of any linked files declared in ticket metadata or derived by the context provider
- Keep the context scoped and deterministic rather than dumping the whole repository into the prompt

### 2. Use structured prompt and response contracts
- Build a system prompt that forces the LLM to return edits in a machine-validated format
- Accept either search-replace blocks, explicit patch operations, or full file rewrites, but the format must be strict enough to validate before writes happen
- Capture model metadata and execution logs separately from the human ticket summary if verbose reasoning is needed

### 3. Apply edits safely
- Validate the LLM response before any file writes occur
- Reject malformed edits, path escapes, or operations against files outside the allowed workspace scope
- Keep file application separate from prompt construction so the writer can be reused and tested independently

### 4. Integrate with git and ticket workflow
- Respect the shared clean-working-tree preflight from the execution bridge
- Record execution progress, failures, and resumable states back to the ticket
- Produce the diff and validation inputs needed for the Sentry phase and PR preparation

## Acceptance Criteria

- [ ] Internal execution can gather ticket requirements plus linked-file source context
- [ ] LLM responses are required to follow a strict machine-readable edit format
- [ ] Invalid or unsafe edits are rejected before local files are overwritten
- [ ] Internal execution records progress and failures back into the ticket state
- [ ] The resulting changes are ready to feed into Sentry validation and PR generation

## Likely Affected Areas

- `engine/src/index.ts`
- `engine/src/execution/` new orchestrator modules
- `engine/src/providers/` or equivalent API client modules
- `portal/src/types.ts`
- `.flux/skills/event-horizon-agent.md`

## Dependencies

- Parent: FLUX-37
- Related to: FLUX-38

## Notes

- API key handling can start with local settings storage, but the execution logic should not hard-wire itself to one provider forever
- The first version should optimize for predictable and safe file application over maximal autonomy
