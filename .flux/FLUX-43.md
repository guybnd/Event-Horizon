---
id: FLUX-43
title: extend workspace installer to patch copilot instructions
status: Done
priority: High
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - ux
  - agent
history:
  - type: comment
    user: Agent
    date: '2026-05-06T13:20:00.000Z'
    comment: >-
      Captured from the follow-up on the skill installer flow. The current
      Settings button only installs the workspace skill, which is not enough to
      make Event Horizon's ticket workflow apply automatically in target repos.
      This ticket adds the always-on Copilot instructions install or patch flow
      to the existing installer surface.
    id: c-2026-05-06t13-20-00-000z
  - type: comment
    user: Agent
    date: '2026-05-06T13:24:00.000Z'
    comment: >-
      Plan: extend the backend installer to manage both the workspace skill and
      a marked Copilot instructions block, expose combined install status
      through the API, then update the Settings surface and README to describe
      the combined workflow install.
    id: c-2026-05-06t13-24-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-06T13:24:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T13:42:00.000Z'
    comment: >-
      Completed the combined workflow installer. The backend installer now
      installs the workspace skill and patches a marked Copilot instructions
      block, the Settings screen reports both assets, and the README documents
      the combined workflow install. Validated with `npm.cmd run install-skill
      -- --target c:\GitHub\EventHorizon --framework copilot --dry-run`,
      `npm.cmd run install-skill -- --target c:\GitHub\EventHorizon
      --framework copilot`, `npm.cmd run build -w portal`, and the live
      `/api/skill/status` response showing both assets installed. Commit:
      `a089edc` (`Install Copilot workflow instructions with the skill`).
    id: c-2026-05-06t13-42-00-000z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-06T13:42:00.000Z'
effort: M
implementationLink: 'a089edc'
subtasks: []
---
## Summary

Extend the current workspace skill installer so it also creates or patches
`.github/copilot-instructions.md` in the target repository. The goal is to
install the optional Event Horizon skill and the always-on Copilot workflow
instructions together, so projects using Event Horizon get both the discovery
surface and the mandatory ticket lifecycle rules.

## Why This Ticket Exists

The existing Settings flow and `install-skill` command only copy the skill file.
That makes the Event Horizon workflow discoverable, but it does not make the
workflow always-on. The always-on enforcement surface for Copilot is
`copilot-instructions.md`, so the installer needs to manage that file as part
of the setup flow.

## Requirements

### 1. Extend the installer output
- Install the workspace skill to `.github/skills/event-horizon/SKILL.md`
- Create or patch `.github/copilot-instructions.md` in the target repository
- Keep the instructions patch idempotent so reinstalling does not duplicate the
  managed block

### 2. Preserve user-owned instructions safely
- If `.github/copilot-instructions.md` already exists, replace only the
  Event Horizon managed section instead of overwriting unrelated content
- If the file does not exist, create it with the managed Event Horizon section
- Use clear start and end markers so future updates remain predictable

### 3. Surface combined status in the portal
- Update the Settings install surface so it reports both skill and instructions
  state, not only the skill file
- Replace the skill-only language with workflow installation language that
  reflects the combined setup

### 4. Update user-facing docs
- Update the README so the Settings flow and CLI describe that both the skill
  and Copilot instructions are installed or refreshed together

## Acceptance Criteria

- [ ] Reinstalling the installer does not duplicate the managed instructions block
- [ ] Existing non-Event-Horizon instructions content is preserved
- [ ] The Settings UI reports both skill and instructions install state
- [ ] The Settings install action installs or refreshes both assets together
- [ ] The README explains the combined installer behavior

## Likely Affected Areas

- `engine/src/skill-installer.ts`
- `engine/src/index.ts`
- `portal/src/api.ts`
- `portal/src/components/Settings.tsx`
- `README.md`
- `.github/copilot-instructions.md`

## Dependencies

- Follow-up to: FLUX-8