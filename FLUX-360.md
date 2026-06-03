---
priority: Low
effort: XS
tags:
  - docs
  - documentation
assignee: unassigned
title: 'Docs: tighten existing pages + cross-links (Phase D)'
status: Done
createdBy: Agent
updatedBy: copilot
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:40.684Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: In Progress
    user: copilot
    date: '2026-06-03T04:55:39.503Z'
  - type: comment
    user: copilot
    comment: >-
      Picking up. Plan:


      1. architecture/overview.md — add `Update channels` subsection linking to
      reference/realtime-channels.md; lightly describe the two storage modes
      (in-repo vs orphan-branch) instead of leaving readers to dig into ADR
      0001.

      2. workflow/ticket-lifecycle.md — cross-link each lifecycle step to the
      matching tool in reference/mcp-tools.md (get_ticket / change_status /
      add_comment / log_progress / finish_ticket / create_subtask) and add a
      docs-update reminder.

      3. agent-integrations.md — link the framework table to
      reference/agent-adapter-contract.md.

      4. ADRs already have the `Skip this for ticket work` note; just verify
      0002 points at the now-existing reference/agent-adapter-contract.md (no
      longer 'planned').

      5. Update orchestrator + implementation skill: explicit reminder that
      reference/* must be kept in sync with code (and the finish_ticket flow
      checks for it).

      6. User add-on: tighten the `Ready`/`Done` step in both
      ticket-lifecycle.md and the implementation skill to emphasize doc updates
      as part of finishing.
    date: '2026-06-03T04:55:39.503Z'
    id: c-2026-06-03t04-55-39-503z
  - type: status_change
    from: In Progress
    to: Done
    user: copilot
    date: '2026-06-03T04:58:11.118Z'
  - type: activity
    user: copilot
    date: '2026-06-03T04:58:11.118Z'
    comment: Updated implementation link.
  - type: comment
    user: copilot
    comment: >-
      Shipped in commit 13aa9bc6e3af030052893ec547466137e9106357.


      **Phase D doc tightening:**

      - architecture/overview.md now describes the two storage modes (in-repo vs
      orphan-branch worktree) directly, and has an 'Update channels' subsection
      summarizing the chokidar/SSE/polling stack with a link to
      reference/realtime-channels.md.

      - workflow/ticket-lifecycle.md: every step now names the MCP tool that
      performs it (get_ticket, update_ticket, change_status, add_comment,
      log_progress, finish_ticket, create_subtask). The 'Documentation
      touchpoints' section is now concrete — lists reference/*, code-map.md,
      agent-integrations.md, workflow/*, README, and .flux/skills/ explicitly.

      - agent-integrations.md: framework table now links to
      reference/agent-adapter-contract.md as the entry point for adding a new
      framework.

      - decisions/0002-multi-agent-cli.md: the 'skip this for ticket work' note
      now points at the existing reference/agent-adapter-contract.md (was
      'planned').

      - ADR 0001 already had the skip note from Phase A.


      **Finish-task docs enforcement (user add-on):**

      - .docs/skills/event-horizon-orchestrator.md: added an explicit Critical
      Rule that reference/* is kept in sync with code as part of the ticket (no
      follow-up filings). The end-to-end checklist now requires the completion
      comment to either name the docs updated or explain why none were needed.

      - .docs/skills/event-horizon-implementation.md: step 10 expanded into a
      concrete pre-Ready/Done checklist enumerating the four doc categories to
      verify; step 11 requires the completion comment to name updated docs.

      - Re-ran install-skill for claude / copilot / gemini so .claude/,
      .github/skills/, and .gemini/ all match the source.


      No code changes. No reference page needed updating because nothing in the
      schema, MCP tools, REST endpoints, realtime channels, or adapter contract
      changed — this ticket was pure docs.
    date: '2026-06-03T04:58:11.118Z'
    id: c-2026-06-03t04-58-11-118z
implementationLink: 13aa9bc6e3af030052893ec547466137e9106357
---
## Problem

After Phase A–C, several existing pages need small updates to point at the new reference docs and stop being mini-references themselves.

## Plan

- `architecture/overview.md`: add a "Update channels" subsection linking to `reference/realtime-channels.md`; describe current storage modes (not the spike).
- `workflow/ticket-lifecycle.md`: cross-link each lifecycle step to the relevant tool in `reference/mcp-tools.md`.
- `agent-integrations.md`: link to `reference/agent-adapter-contract.md` from the framework table.
- Add a top-of-page "Skip this for ticket work" note on each ADR in `decisions/`.
- Update the orchestrator skill note: "Reference docs (`reference/*`) are kept in sync with code; fix drift as part of the ticket."
- Acceptance: no page duplicates content that lives in a reference page.
