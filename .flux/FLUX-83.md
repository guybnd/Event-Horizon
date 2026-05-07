---
title: Provide a robust mechanism for agent ticket edits to prevent ticket corruption
status: Grooming
createdBy: User
updatedBy: Guy
assignee: unassigned
tags:
  - reliability
  - agent-workflow
priority: High
effort: Medium
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Unknown
    date: '2026-05-07T09:23:32.719Z'
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
order: 83
---

# Problem
When an agent attempts to advance a ticket or log history, it uses tools like `replace_string_in_file` or similar. If the replacement is slightly off or breaks the YAML syntax, the ticket parser in the portal fails, and the ticket vanishes from the UI. This fragility degrades the user experience significantly.

# Proposed Paths for Grooming

1. **Structured Editing Tooling (MCP / VS Code Command):**
   Expose an explicit tool to the agent (e.g., `update_ticket_status`, `add_ticket_history`) that takes arguments in JSON (like `ticketId`, `status`, `actor`, `comment`). The tool itself uses a robust YAML parser/serializer (e.g., `js-yaml`) to modify the file safely. The instructions would then tell the agent to *never* edit `.flux` files manually, but only through these tools.

2. **Validation Hook:**
   Whenever a `.flux` file is modified, run a light and fast verification hook. If the YAML frontmatter is invalid, provide immediate terminal feedback to the agent so it can self-correct, or enforce a Git pre-commit hook that rejects corrupted tickets.

3. **CLI Scripts:**
   Add node scripts (e.g., `npx flux-cli update FLUX-83 --status="In Progress"`) that the agent can execute via terminal to safely interact with tickets.

# Questions to Resolve
- Which intermediary mechanism makes the most sense for the current agent context?
- Do we build this directly into the Event Horizon extension/skills/instructions?
