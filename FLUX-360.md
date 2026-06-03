---
priority: Low
effort: XS
tags:
  - docs
  - documentation
assignee: unassigned
id: FLUX-360
title: 'Docs: tighten existing pages + cross-links (Phase D)'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:40.684Z'
    comment: Created ticket.
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
