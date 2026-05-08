---
title: Provide a robust mechanism for agent ticket edits to prevent ticket corruption
status: Todo
createdBy: User
updatedBy: Guy
assignee: unassigned
tags:
  - reliability
  - agent-workflow
priority: High
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Unknown
    date: '2026-05-07T09:23:32.000Z'
    comment: Created ticket.
  - timestamp: '2026-05-07T00:00:00.000Z'
    actor: User
    action: Created
    comment: >-
      Created ticket for grooming to explore ways to guarantee correct edits to
      ticket structure so they don't break and disappear from the board.
  - type: comment
    user: Guy
    date: '2026-05-07T09:27:31.882Z'
    comment: >-
      perhaps an additional alternative is to add a view or indicator for
      corrupted ticket files or unparsable files and indicate it to the user so
      he can instruct agent to fix or undo it
    id: c-2026-05-07t09-27-31-882z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-07T09:27:31.889Z'
  - type: activity
    user: Guy
    date: '2026-05-07T09:27:31.889Z'
    comment: >-
      Updated description. Changed assignee from Agent to unassigned. Changed
      effort from M to Medium.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. Three paths were identified. The lowest-friction path for current
      agent workflows is the CLI approach (Option 3): add engine-level Node
      scripts callable via terminal (e.g. `node engine patch-ticket FLUX-83
      --status "In Progress"`) that use js-yaml for safe round-trip editing. The
      corrupted-file indicator (Guy's comment) is a complementary UX feature
      that can be a separate ticket. Key open question: should we pursue the CLI
      (quickest, agent-friendly), the MCP tool (most robust, requires MCP
      integration), or the validation hook (lightweight, reactive)? Marking
      Require Input.
    id: c-flux83-groom
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-07T23:47:10.213Z'
    comment: >-
      lets do option D and then also add a ticket for ui indicator for bad
      tickets
    id: c-2026-05-07t23-47-10-213z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T23:47:10.213Z'
    comment: Response submitted
order: 83
---

## Summary
When an agent attempts to advance a ticket or log history, it uses file replacement tools that often break YAML formatting, causing tickets to vanish. We need a robust mechanism to prevent this, using a combination of file-watching validation and a safe CLI tool.

## Requirements

### 1. Validation Hook
- Implement a fast verification hook inside the engine watcher.
- Whenever a `.flux/*.md` file is changed, parse its YAML frontmatter.
- If invalid, emit an immediate terminal error so the agent receives feedback and can self-correct.

### 2. CLI Scripts
- Add Node CLI scripts (e.g., `patch-ticket.ts`) in `engine/src/`.
- The script should accept arguments for editing a ticket (`--status`, `--comment`, etc.) and safely parse/stringify the file using `js-yaml`.
- Update agent system instructions to mandate using the CLI tool instead of direct string replacements for ticket metadata.

## Acceptance Criteria
- [ ] Malformed ticket edits trigger an immediate validation error in the terminal.
- [ ] A CLI script successfully updates ticket status and history using `js-yaml`.
- [ ] A separate ticket is created for the "corrupted file UI indicator".

## Likely Affected Areas
- `engine/src/watcher.ts` (or similar file monitoring)
- `engine/src/cli/`
- `.flux` documentation/instructions

## Notes
- Based on user discussion, we are proceeding with "Option D" (Validation hook + CLI Scripts). MCP tooling will be explored in the future.

## Original Request
Provide a robust mechanism for agent ticket edits to prevent ticket corruption
