---
title: Agent & Skill Builder UI — modular workflow templates per phase
status: Grooming
priority: High
effort: XL
assignee: unassigned
tags:
  - feature
  - multi-agent
  - workflow
  - portal
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-25T11:29:38.152Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-25T11:31:44.358Z'
    comment: >-
      Should workflow templates live per-project (.flux/workflows/) or be global
      user config?

      probably global with per project override, but lets start with global


      skills should let us only pick from existing, and a shortcut to go edit
      them in a dedicated pop up window maybe i guess


      Do we want a "dry run" mode that previews the pipeline without launching
      agents?

      probably
    id: c-2026-05-25t11-31-44-353z
  - type: activity
    user: Guy
    date: '2026-05-25T11:32:12.344Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-25T11:42:09.713Z'
    comment: Updated description.
  - type: agent_session
    sessionId: 98d8cfaa-5f05-45b5-aa42-173e20adb299
    startedAt: '2026-05-25T11:43:51.013Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T11:43:51.013Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T11:44:00.641Z'
implementationLink: ''
subtasks: []
id: FLUX-312
---

## Problem / Motivation

Users need a visual interface to configure multi-agent workflows per ticket phase. Currently there's no way to define which agents (with which skills/system prompts) run during Grooming, Implementation, Review, or Release — let alone sequence them. We need a modular builder UI where users can compose agent pipelines per phase, with a sensible default template shipped out of the box.

## Confirmed Design: Kanban-Style Workflow Builder

The UI mirrors the existing board's column layout:

### Layout

- **Leftmost column — Agent Library**: A palette of all defined agents. Each card shows agent name, CLI type (Claude/Gemini/Copilot), and category. Dragging from here into a phase column creates a copy as a new step (the original stays — agents are reusable). `[+ New Agent]` at the bottom opens a creation form.

- **Phase columns (Grooming | Implementation | Review | Release)**: Each column represents a status phase. Cards within are ordered top-to-bottom as sequential steps — step N waits for step N-1 to finish before launching.

- **Template picker per column**: Each phase column has its own dropdown at the top to select/create templates. Different templates = different agent sets for that phase. Users can have multiple saved configurations and swap between them.

### Agent Cards (in phase columns)

Each card shows:
- Checkbox (enable/disable without removing)
- Agent name + CLI type
- Step number (derived from position)
- Click to expand → edit system prompt, attached skills, CLI target, context boundaries

### Interactions

- **Drag from library → column**: Adds agent as a new step in that phase
- **Drag within column**: Reorder steps
- **Click card**: Opens inline config panel (prompt editor, skill picker, CLI selector)
- **Checkbox toggle**: Enable/disable a step (disabled steps are skipped during execution)
- **Template dropdown per column**: Switch between saved agent configurations for that phase
- **[+ New Template]**: Fork current or start blank
- **[+ Add Step]**: Alternative to drag — pick from library via dropdown

### Execution Model

- Steps within a column run sequentially (top → bottom)
- Each step's output is available as context for the next step
- A phase completes only when its last enabled step finishes
- Disabled (unchecked) steps are skipped entirely

### Default Template

Ships with a curated default for each phase:
- **Grooming**: Interrogator → Context Scout → Spec Writer
- **Implementation**: Context Scout → Implementer → Refactorer (disabled by default)
- **Review**: Pedant → Product Proxy → QA Automator
- **Release**: Documenter → Release Agent

### Agent Definition (library entries)

Each agent in the library has:
- Name / role label
- CLI target (Claude, Gemini, Copilot)
- System prompt (editable, supports markdown)
- Skills (selected from `.flux/skills/` or inline)
- Category tag (Grooming / Execution / Validation / Release)
- Context boundaries (what the agent can/cannot see)

### Persistence

- Workflow templates stored in `.flux/workflows/` as JSON
- Agent definitions stored in `.flux/agents/` as JSON or markdown
- Engine reads active workflow config when launching sessions for a ticket
- Ties into FLUX-283 (session orchestration) and FLUX-285 (role prompts)

## Open Questions

- Should workflow templates live per-project (`.flux/workflows/`) or be global user config?
- Do we want a "dry run" mode that previews the pipeline without launching agents?
- How to handle the transition between phases — automatic (ticket status change triggers next phase) or manual?
