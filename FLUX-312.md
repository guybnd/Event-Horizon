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
updatedBy: Guy
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
implementationLink: ''
subtasks: []
---
## Problem / Motivation

Users need a visual interface to configure multi-agent workflows per ticket phase. Currently there's no way to define which agents (with which skills/system prompts) run during Grooming, Implementation, Review, or Release — let alone sequence them. We need a modular builder UI where users can:

1.  Define agent templates (name, CLI type, system prompt, skill set, allowed actions).
    
2.  Assign agents to phases (Grooming, Todo/In Progress, Review, Release).
    
3.  Compose workflows within a phase — ordering agents sequentially (relay), running them in parallel (scatter-gather), or letting a lead agent delegate (supervisor).
    
4.  Ship a sensible default template out of the box so users get value immediately.
    

## Scope

### Agent Template Builder

-   CRUD interface for agent definitions: name, role label, CLI target (Claude/Gemini/Copilot), system prompt (editable), skill attachments, context boundaries.
    
-   Each agent template is reusable across multiple workflow configurations.
    

### Phase Workflow Configurator

-   Per-phase (Grooming, Implementation, Review, Release) workflow canvas or step-list.
    
-   Drag/drop or add-step UX to compose agents into a pipeline.
    
-   Support three orchestration modes per step group: Sequential (relay), Parallel (scatter-gather), Supervisor (lead + on-demand tools).
    
-   Visual indicators for dependencies/ordering between steps.
    

### Default Template

-   Ship a curated default workflow template covering all four phases:
    
    -   **Grooming**: Interrogator + Context Scout (parallel) → Spec Writer (synthesis).
        
    -   **Implementation**: Context Scout → Implementer → Refactorer (sequential).
        
    -   **Review**: Pedant + Product Proxy (parallel) → QA Automator (relay).
        
    -   **Release**: Documenter → Release Agent (sequential).
        
-   Users can fork the default and customize, or start from scratch.
    

### Persistence & Integration

-   Workflow configs stored as JSON in `.flux/workflows/` or engine config.
    
-   Engine reads active workflow config when launching sessions for a ticket.
    
-   Ties into FLUX-283 (session orchestration layer) and FLUX-285 (role prompt definitions).
    

## Open Questions

-   Should workflow templates live per-project (`.flux/workflows/`) or be global user config?  
    probably global with per project override, but lets start with global
    
-   How granular should skill attachment be — pick from existing `.flux/skills/` files, or inline edit?  
    skills should let us only pick from existing, and a shortcut to go edit them in a dedicated pop up window maybe i guess
    
-   Do we want a "dry run" mode that previews the pipeline without launching agents?
    

probably
