---
id: FLUX-8
title: Design agent skill document
status: Done
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - mvp
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:29:00.000Z'
    comment: >-
      Fleshed this out. This is tightly coupled with FLUX-6 (MCP integration).
      Need your input on whether to combine them and on the skill format — see
      Open Questions.
  - type: comment
    user: Guy
    date: '2026-05-06T07:31:41.808Z'
    comment: |-
      1. sure
      2. whatever is widely accepted as a good option
      3. both 
      4. have it as an option from the button
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T07:31:53.477Z'
  - type: status_change
    from: Todo
    to: Done
    user: Agent
    date: '2026-05-06T23:05:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T23:05:00.000Z'
    comment: >-
      Implemented the first-pass skill integration. Added the source skill doc
      under `.flux/skills/event-horizon-agent.md`, added an installer CLI at
      `engine/src/skill-installer.ts`, exposed it through the workspace
      `install-skill` script, and installed the Copilot copy into
      `.github/skills/event-horizon/SKILL.md` for this repo.
  - type: comment
    user: Guy
    date: '2026-05-06T10:05:03.013Z'
    comment: >-
      we should have some sort of UI solution for this, as its hidden from the
      user. maybe also need to update the readme
  - type: status_change
    from: Done
    to: Todo
    user: Guy
    date: '2026-05-06T10:05:07.599Z'
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-06T11:22:04.670Z'
  - type: status_change
    from: Grooming
    to: Done
    user: Agent
    date: '2026-05-06T11:40:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T11:40:00.000Z'
    comment: >-
      Followed up on the reopen note by making the skill visible in-product.
      Added a Settings panel section that shows skill status and paths, supports
      workspace install/reinstall through the engine, and added README guidance
      for both the Settings flow and the install command. Also tightened the
      skill's own task-finish protocol around descriptive completion comments
      and commit messages.
order: 1
priority: None
effort: None
implementationLink: ''
---
## Summary

Design a "skill" document — a structured prompt/instruction file that teaches AI agents how to work with Event Horizon tickets. The skill defines the workflow, conventions, and available tools so any agent can pick it up and interact with the board correctly.

Additionally, provide a CLI tool or script to copy the skill file into a target project's relevant directory (e.g. `.gemini/skills/` or `.github/copilot/`).

## Requirements

### 1. Skill Document Content

The skill should cover:

- **Overview:** What Event Horizon is and how it works (file-based kanban, `.flux/` directory)
- **Available tools/APIs:** List of MCP tools or REST endpoints the agent can use
- **Workflow instructions:**
  1. When assigned a ticket, read it fully including all comments
  2. Post a plan as a comment before starting work
  3. Update ticket status to "In Progress" when starting
  4. Post progress updates as comments
  5. When blocked or needing clarification, move to "Require Input" with a clear question
  6. When done, update description with summary and move to "Done"
  7. Read user replies in comments for follow-up instructions
- **Conventions:** How to format comments, what fields to update, naming conventions
- **Ticket structure:** Explain the frontmatter schema, history entries, comment format

### 2. Skill Distribution Tool

- A script/command that copies the skill file to a target project
- Detects the IDE/agent framework and places it in the right location:
  - `.gemini/skills/event-horizon.md` for Gemini
  - `.github/copilot/skills/event-horizon.md` for Copilot
  - Generic fallback location
- Could be an `npx` command or a button in the portal UI

## Open Questions

> **@Guy — Need your input:**
>
> 1. **Combine with FLUX-6?** The skill document depends on knowing what MCP tools exist. Should we implement FLUX-6 (MCP) first and then write the skill, or do both together?
> 2. **Skill format?** Should it be a plain markdown file, or a structured YAML/JSON format that agents parse more reliably?
> 3. **Distribution method?** Do you want a CLI command (`npx event-horizon-skill install`), a button in the portal Settings, or both?
> 4. **Per-project or global?** Should the skill be installed per-project or globally for the user?

## Acceptance Criteria

- [ ] Skill document authored with complete workflow instructions
- [ ] Skill covers all available MCP tools/REST endpoints
- [ ] Distribution script copies skill to the correct IDE-specific location
- [ ] An agent following the skill can successfully work on a ticket end-to-end
- [ ] Skill is versioned and updateable

## Files to Create

- `.flux/skills/event-horizon-agent.md` — **[NEW]** The skill document
- `engine/src/skill-installer.ts` — **[NEW]** Script to copy skill to target projects
- `package.json` — Add `install-skill` script

## Dependencies

- Related to: FLUX-6 (MCP integration) — skill references MCP tools
- Related to: FLUX-13 (User prompt) — skill instructs agents to use "Require Input"

