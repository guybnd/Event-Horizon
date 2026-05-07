---
title: Write install and setup documentation for external projects
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - docs
  - mvp
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:50:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T06:50:00.000Z'
    comment: >-
      Created during install-readiness audit. The README currently documents
      dev-mode setup for contributors to the Event Horizon repo itself, but has
      no section explaining how to install and use Event Horizon as a service
      in another project.
    id: c-2026-05-07t06-50-00-000z-flux-75
order: 75
---
## Summary

Write clear documentation explaining how to install, configure, and run Event
Horizon in an external project. The current README only covers dev-mode setup
for the Event Horizon repo itself. A new user trying to adopt EH in their own
repo has no guide.

## Requirements

### 1. README install section
- Add an "Install in Your Project" section to the root `README.md`
- Cover prerequisites (Node.js version, Git)
- Document the init process (from FLUX-73)
- Explain how to start the engine and portal
- Explain how to create the first ticket

### 2. Configuration guide
- Document the `config.json` schema — what each field does
- Explain how to customize statuses, tags, priorities, and users
- Document the project key and how it affects ticket IDs

### 3. Docs tree page
- Add an `installation` page under `.docs/` that is viewable from the portal
- Cover the same content as the README section but in the portal's docs format
- Link to other relevant docs pages (architecture, workflow)

### 4. Agent setup guide
- Document how to install the agent workflow (Copilot skill)
- Explain the `install-skill` command and the Settings UI option
- Briefly explain what the skill files do

## Acceptance Criteria

- [ ] README has a clear "Install in Your Project" section
- [ ] Config schema is documented with field descriptions
- [ ] A `.docs/installation.md` page exists and is accessible from the portal
- [ ] Agent workflow install is documented
- [ ] A new user can follow the docs end-to-end to get Event Horizon running in their repo

## Likely Affected Areas

- `README.md`
- New: `.docs/installation.md`
- Potentially `.docs/architecture/overview.md` (cross-links)

## Dependencies

- Should be written after FLUX-18 and FLUX-73 are implemented so the docs reflect the actual install flow
