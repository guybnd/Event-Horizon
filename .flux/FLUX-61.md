---
title: require grooming to complete ticket metadata
status: Done
priority: High
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - docs
  - task
history:
  - type: activity
    user: Guy
    date: '2026-05-07T14:02:19.7917592+10:00'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T14:02:19.7917592+10:00'
    comment: >-
      Plan: tighten the grooming workflow so agents must review applicable
      ticket metadata, fill fields they can infer during grooming, and move the
      ticket to `Require Input` with proposed values for anything still missing.
      Update the lifecycle docs, source workflow assets, and refreshed installed
      copies, then validate the installed text plus live ticket parsing.
    id: c-2026-05-07t14-02-19-7917592-10-00
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T14:02:19.7917592+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T14:05:41.9889413+10:00'
    comment: >-
      Grooming now explicitly includes a metadata-completeness pass. Updated the
      lifecycle doc, README, workflow skill, and always-on instructions so
      agents must fill inferable metadata during grooming and include proposed
      values when routing missing fields through `Require Input`. Refreshed the
      installed `.github` workflow copies and validated the new guidance by
      checking the updated source and installed assets plus the live task API.
      Commit: `347a69f` (`Require grooming metadata completion`).
    id: c-2026-05-07t14-05-41-9889413-10-00
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T14:05:41.9889413+10:00'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-07T04:18:31.076Z'
effort: S
implementationLink: 347a69f
subtasks: []
order: 10
---
## Summary

Tighten the grooming workflow so agents do not leave obvious ticket metadata
blank when the information is already inferable, and so missing metadata is
explicitly proposed through the `Require Input` flow when user confirmation is
still needed.

## Requirements

### 1. Review metadata completeness during grooming
- Update workflow guidance so grooming includes an explicit pass over the
  ticket metadata, not only the body plan.
- Applicable fields should include current modeled metadata such as `priority`,
  `effort`, `tags`, and hierarchy links, plus durable body sections like
  related-ticket references when those are relevant to the work.

### 2. Fill what is inferable
- If the current ticket context makes a field clear enough to set during
  grooming, require the agent to populate it instead of leaving it blank or
  `None` by default.
- Keep this scoped to fields that are actually applicable to the ticket.

### 3. Propose missing values through user input
- If a relevant metadata field still needs user confirmation, require the
  agent to move the ticket to the configured user-input status and ask one
  focused question that includes the proposed fill values.
- The workflow should make it clear that these proposed values are part of the
  grooming output before a ticket returns to `Todo` or moves into
  `In Progress`.

## Acceptance Criteria

- [x] Workflow docs explicitly require a grooming metadata-completeness pass
- [x] Source workflow assets require agents to fill inferable metadata during
  grooming
- [x] Source workflow assets require proposed values for missing metadata when
  routing to `Require Input`
- [x] Installed workflow assets are refreshed after the source updates

## Likely Affected Areas

- `.docs/workflow/ticket-lifecycle.md`
- `README.md`
- `.flux/skills/event-horizon-agent.md`
- `.flux/skills/event-horizon-copilot-instructions.md`
- `.github/skills/event-horizon/SKILL.md`
- `.github/copilot-instructions.md`
