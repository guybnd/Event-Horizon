---
title: Add project init / bootstrap CLI command
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - mvp
priority: High
effort: M
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
      Created during install-readiness audit. There is currently no way to
      scaffold Event Horizon into a new project — users must manually create
      `.flux/`, `config.json`, and understand the expected directory structure.
      This is a blocker for adoption.
    id: c-2026-05-07t06-50-00-000z-flux-73
order: 73
---
## Summary

Create a CLI command (`event-horizon init` or equivalent npm script) that
bootstraps the `.flux/` directory structure, a starter `config.json`, and
optionally the `.docs/` directory in a target project. This is the entry point
for any new user wanting to adopt Event Horizon in their repo.

## Requirements

### 1. Init command scaffolding
- Provide a runnable command (e.g. `npx event-horizon init` or `npm run init -- --target <path>`)
- Create the `.flux/` directory if it does not exist
- Create `.flux/config.json` with sensible defaults (standard statuses, empty tags, default priorities)
- Create `.flux/assets/` directory
- Optionally create `.docs/` directory with a starter `project-overview.md`
- The command should be idempotent — running it twice should not overwrite existing config or files

### 2. Configurable project key
- Prompt the user for a project key (e.g. `MYAPP`, `CORE`, `WEB`) or accept it as a CLI argument
- Write the project key into `config.json` under `projects`
- Default to `PROJECT` if no key is provided

### 3. Starter config content
- Default columns: `Todo`, `In Progress`, `Done`
- Default hidden statuses: `Backlog`
- Default priorities: Critical, High, Medium, Low, None
- Empty tags array (ready for user/agent customization)
- Empty users array with a placeholder comment
- `enableBacklogScreen: true`
- Sensible defaults for all other config fields

### 4. Detect existing installations
- If `.flux/config.json` already exists, print a message and exit without modifying anything
- Offer a `--force` flag to re-scaffold (with a warning)

### 5. Post-init guidance
- After scaffolding, print a short "Getting Started" message explaining:
  - How to start the engine and portal
  - Where to create the first ticket
  - How to open the portal UI

## Acceptance Criteria

- [ ] Running the init command in an empty repo creates `.flux/config.json` with valid defaults
- [ ] The project key is configurable via CLI argument or interactive prompt
- [ ] Running init in a repo that already has `.flux/config.json` does not overwrite it
- [ ] The generated config works immediately with the engine and portal
- [ ] A `--force` flag allows re-scaffolding with a warning
- [ ] Post-init output gives the user clear next steps

## Likely Affected Areas

- New: `engine/src/init.ts` or `scripts/init.js`
- `package.json` (root) — new `init` script
- `engine/package.json` — possible new script entry

## Dependencies

- Should be implemented after or alongside FLUX-18 (packaged app) since the init flow is part of the install experience
