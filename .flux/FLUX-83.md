---
title: Provide a robust mechanism for agent ticket edits to prevent ticket corruption
status: Require Input
createdBy: User
updatedBy: Agent
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
order: 83
---

# Problem

When an agent uses `replace_string_in_file` or similar to edit `.flux/*.md` tickets, slight YAML formatting errors cause the ticket to fail parsing and vanish from the board. This is a recurring source of agent-induced data corruption.

# Paths Identified

1. **MCP / VS Code Command Tool (most robust):** Expose explicit tool calls (`update_ticket_status`, `add_ticket_history`) that accept JSON and use `js-yaml` for safe serialization. Agent instructions forbid direct file editing. Requires MCP server integration — higher investment.

2. **Validation Hook (reactive / lightweight):** After any `.flux/*.md` file change, run a fast YAML parse check in the engine watcher and emit a terminal error immediately so the agent can self-correct. Could be paired with a pre-commit hook. No API change needed.

3. **CLI Scripts (quickest agent-friendly path):** Add Node scripts under `engine/src/` (e.g., `patch-ticket.ts`) that accept `--id`, `--status`, `--comment` args and use `js-yaml` for safe round-trip editing. Agent calls them via terminal. Instructions updated to prefer CLI over file edits for status/history changes.

4. **Corrupted File Indicator (UX complement):** Portal detects unparsable `.flux/*.md` files (engine returns them in a separate `corrupted` list) and shows a banner so the user can instruct the agent to fix or revert.

# Open Question (Require Input)

Which implementation path should be prioritised first?

- **Option A (recommended default):** CLI scripts (Option 3) — quickest to ship, immediately usable by agents.
- **Option B:** Validation hook (Option 2) — lightweight and complementary to any path.
- **Option C:** MCP tools (Option 1) — most thorough but highest effort.
- **Option D:** Start with B + A, then track MCP as a future ticket.

Corrupted-file indicator (Option 4) should be split into a separate ticket regardless.

# Proposed Metadata Defaults

- `priority`: High
- `effort`: M (for CLI or validation hook; L for MCP)
- `tags`: reliability, agent-workflow

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
