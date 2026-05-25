---
title: Agent & Skill Builder UI — modular workflow templates per phase
status: Todo
priority: High
effort: XL
assignee: unassigned
tags:
  - feature
  - multi-agent
  - agent-workflow
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
    status: completed
    progress:
      - timestamp: '2026-05-25T11:44:05.018Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket,get_board_config,list_tickets'
            max_results: 3
      - timestamp: '2026-05-25T11:44:07.884Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T11:44:11.688Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-312
      - timestamp: '2026-05-25T11:44:22.888Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T11:44:25.285Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore portal UI structure
            subagent_type: Explore
            prompt: >-
              I need to understand the portal's existing structure to plan a new
              "Workflow Builder" page. Look at:


              1. `portal/src/` — what pages/routes exist? What's the routing
              setup?

              2. Any existing drag-and-drop usage (dnd-kit, react-beautiful-dnd,
              etc.)

              3. The existing board/kanban UI components (columns, cards)

              4. `portal/src/pages/` or equivalent — what views does the app
              have?

              5. Check `package.json` for the portal — what UI/DnD libraries are
              already installed?

              6. Any existing "agents" or "workflow" related UI components


              Report: file structure overview, key component locations,
              installed libraries relevant to DnD/UI, and any existing patterns
              I should follow. Keep it under 300 words.
      - timestamp: '2026-05-25T11:44:29.617Z'
        message: Reading FLUX-283.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-283.md'
      - timestamp: '2026-05-25T11:44:29.707Z'
        message: 'Running: find /c/GitHub/EventHorizon -type f -name "package...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon -type f -name "package.json" | grep -E
              "(portal|packages)" | head -20
      - timestamp: '2026-05-25T11:44:29.829Z'
        message: Reading FLUX-285.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-285.md'
      - timestamp: '2026-05-25T11:44:35.259Z'
        message: 'Running: find /c/GitHub/EventHorizon/portal/src -type f -na...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/portal/src -type f -name "*.tsx" -o
              -name "*.ts" | head -30
      - timestamp: '2026-05-25T11:44:37.895Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T11:44:39.055Z'
        message: Reading App.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/src/App.tsx
      - timestamp: '2026-05-25T11:44:42.130Z'
        message: 'Running: find /c/GitHub/EventHorizon/portal/src/components ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/portal/src/components -type f -name
              "*.tsx" | xargs grep -l "workflow\|agent\|Workflow\|Agent" | head
              -10
      - timestamp: '2026-05-25T11:44:44.331Z'
        message: Reading WorkflowSection.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /c/GitHub/EventHorizon/portal/src/components/settings/WorkflowSection.tsx
            limit: 50
      - timestamp: '2026-05-25T11:44:47.049Z'
        message: 'Running: ls -la /c/GitHub/EventHorizon/portal/src/component...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              ls -la /c/GitHub/EventHorizon/portal/src/components/ | grep -E
              "Task|Card" | head -20
      - timestamp: '2026-05-25T11:44:52.905Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T11:44:56.089Z'
        message: Reading Header.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/src/components/Header.tsx
            limit: 100
      - timestamp: '2026-05-25T11:45:00.233Z'
        message: 'Running: grep -A 50 "NavItem" /c/GitHub/EventHorizon/portal...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -A 50 "NavItem"
              /c/GitHub/EventHorizon/portal/src/components/Header.tsx | grep -E
              "NavItem|view=" | head -20
      - timestamp: '2026-05-25T11:45:07.904Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T11:45:37.975Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T11:46:04.765Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-312
            tags:
              - feature
              - multi-agent
              - agent-workflow
              - portal
            body: >
              ## Problem / Motivation


              Users have no visual way to configure which agents run during each
              ticket phase (Grooming, Implementation, Review, Release) or in
              what order. The multi-agent system (FLUX-283 session
              orchestration, FLUX-285 role prompts) defines 13+ agent roles, but
              there's no UI to compose them into pipelines per phase. Without
              this, users must manually edit config files to set up workflows —
              a poor experience that blocks adoption of multi-agent execution.


              ## Confirmed Decisions


              - **Persistence**: Global config (start here), with per-project
              override later. Stored in `.flux/workflows/` (JSON) and
              `.flux/agents/` (JSON/markdown).

              - **Skills picker**: Select from existing `.flux/skills/` only —
              no inline creation. Shortcut button opens skill in a dedicated
              editor popup.

              - **Dry run**: Include a "preview pipeline" mode that shows
              execution order without launching agents.

              - **Phase transitions**: Out of scope for this ticket — handled by
              FLUX-283 (session orchestration). This ticket builds the
              configuration UI only.


              ## Implementation Plan


              ### 1. Data Model & Engine API (engine/)


              - Define TypeScript interfaces: `AgentDefinition` (name,
              cliTarget, systemPrompt, skills[], category, contextBoundaries)
              and `WorkflowTemplate` (id, name, phases: Record<Phase,
              WorkflowStep[]>), `WorkflowStep` (agentId, enabled, config
              overrides).

              - Add CRUD endpoints: `GET/POST /api/workflows`, `GET/PUT/DELETE
              /api/workflows/:id`, `GET/POST /api/agents`, `GET/PUT/DELETE
              /api/agents/:id`.

              - File persistence: read/write `.flux/workflows/*.json` and
              `.flux/agents/*.json`.

              - Seed with a default template matching the confirmed design
              (Interrogator→Context Scout→Spec Writer for Grooming, etc.).


              ### 2. New Portal View — Workflow Builder (portal/src/)


              - Add `workflow-builder` to `AppView` type in `AppContext.tsx`.

              - Add navigation entry (sidebar/topnav) to reach the builder view.

              - Create `WorkflowBuilder.tsx` — top-level view component.


              ### 3. Agent Library Column


              - `AgentLibrary.tsx` — left column listing all defined agents from
              `/api/agents`.

              - Each agent rendered as a draggable card (`@dnd-kit` draggable)
              showing name, CLI type badge, category tag.

              - `[+ New Agent]` button at bottom → opens `AgentEditorModal.tsx`
              (name, CLI target, system prompt via Tiptap, skills multi-select
              from existing, category, context boundaries).


              ### 4. Phase Columns


              - `PhaseColumn.tsx` — one per phase (Grooming, Implementation,
              Review, Release). Uses `@dnd-kit` `useDroppable` +
              `SortableContext` for reordering within.

              - Template dropdown at top of each column (`TemplatePicker.tsx`) —
              lists saved templates for that phase, with [+ New Template]
              option.

              - `WorkflowStepCard.tsx` — sortable card in a phase column
              showing: checkbox (enable/disable), agent name, CLI type, step
              number (derived from index). Click expands inline config panel.


              ### 5. Drag & Drop Orchestration


              - Wrap entire builder in `DndContext` (mirrors Board.tsx pattern).

              - Handle cross-container drag (library → phase column = clone,
              phase → phase = move).

              - Handle within-column reorder (step reordering).

              - `[+ Add Step]` button per column as non-drag alternative.


              ### 6. Inline Config Panel (expanded card)


              - `StepConfigPanel.tsx` — shown when a step card is
              clicked/expanded.

              - Fields: system prompt override (Tiptap editor), skills picker
              (multi-select from `/api/skills`), CLI target selector, context
              boundaries checkboxes.

              - Skill edit shortcut: button opens `SkillEditorPopup.tsx` for the
              selected skill in a modal.


              ### 7. Dry Run / Preview Mode


              - `[Preview Pipeline]` button in toolbar.

              - `PipelinePreview.tsx` — visual representation showing execution
              order per phase, which steps are enabled/disabled, estimated
              context flow.

              - No actual agent launching — read-only visualization.


              ### 8. Persistence & Sync


              - Auto-save workflow changes (debounced PUT to
              `/api/workflows/:id`).

              - Active workflow selection stored in board config (or
              `.flux/config.json`).

              - Engine reads active workflow when FLUX-283 session orchestration
              launches agents.


              ### Key Files to Create/Modify


              | File | Action |

              |------|--------|

              | `engine/src/routes/workflows.ts` | New — CRUD routes |

              | `engine/src/routes/agents.ts` | New — CRUD routes |

              | `engine/src/models/workflow.ts` | New — interfaces + file I/O |

              | `engine/src/models/agent.ts` | New — interfaces + file I/O |

              | `portal/src/components/WorkflowBuilder.tsx` | New — view shell |

              | `portal/src/components/AgentLibrary.tsx` | New |

              | `portal/src/components/PhaseColumn.tsx` | New |

              | `portal/src/components/WorkflowStepCard.tsx` | New |

              | `portal/src/components/StepConfigPanel.tsx` | New |

              | `portal/src/components/AgentEditorModal.tsx` | New |

              | `portal/src/components/TemplatePicker.tsx` | New |

              | `portal/src/components/PipelinePreview.tsx` | New |

              | `portal/src/components/SkillEditorPopup.tsx` | New |

              | `portal/src/AppContext.tsx` | Modify — add view + workflow state
              |

              | `portal/src/App.tsx` | Modify — render WorkflowBuilder view |


              ### Dependencies


              - FLUX-285 (role prompts) provides the default agent definitions
              to seed the library.

              - FLUX-283 (session orchestration) consumes the workflow config at
              runtime — but this ticket only builds the configuration UI.
      - timestamp: '2026-05-25T11:46:07.977Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T11:46:12.447Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-312
            newStatus: Todo
      - timestamp: '2026-05-25T11:46:20.909Z'
        message: >-
          FLUX-312 is groomed and moved to **Todo**. Here's what was done:


          - **Metadata** confirmed: High priority, XL effort, tags: `feature`,
          `multi-agent`, `agent-workflow`, `portal`

          - **Open questions resolved** per your input: global-first
          persistence, skills picker from existing only (with edit shortcut
          popup), dry run mode included, phase transitions deferred to FLUX-283

          - **Body rewritten** with Problem/Motivation + detailed implementation
          plan covering: data model & API, the kanban-style builder view, DnD
          orchestration (using existing `@dnd-kit`), inline config panels, dry
          run preview, and persistence/sync — all broken into 8 concrete steps
          with a file manifest


          The ticket is ready for implementation whenever you want to pick it
          up.
    user: Claude Code
    date: '2026-05-25T11:43:51.013Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T11:46:22.063Z'
  - type: activity
    user: Agent
    date: '2026-05-25T11:46:04.913Z'
    comment: Updated description. Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T11:46:11.904Z'
implementationLink: ''
subtasks: []
id: FLUX-312
tokenMetadata:
  inputTokens: 195176
  outputTokens: 3505
  costUSD: 0.388396
  costIsEstimated: false
  cacheReadTokens: 178397
  cacheCreationTokens: 16480
---
## Problem / Motivation

Users have no visual way to configure which agents run during each ticket phase (Grooming, Implementation, Review, Release) or in what order. The multi-agent system (FLUX-283 session orchestration, FLUX-285 role prompts) defines 13+ agent roles, but there's no UI to compose them into pipelines per phase. Without this, users must manually edit config files to set up workflows — a poor experience that blocks adoption of multi-agent execution.

## Confirmed Decisions

- **Persistence**: Global config (start here), with per-project override later. Stored in `.flux/workflows/` (JSON) and `.flux/agents/` (JSON/markdown).
- **Skills picker**: Select from existing `.flux/skills/` only — no inline creation. Shortcut button opens skill in a dedicated editor popup.
- **Dry run**: Include a "preview pipeline" mode that shows execution order without launching agents.
- **Phase transitions**: Out of scope for this ticket — handled by FLUX-283 (session orchestration). This ticket builds the configuration UI only.

## Implementation Plan

### 1. Data Model & Engine API (engine/)

- Define TypeScript interfaces: `AgentDefinition` (name, cliTarget, systemPrompt, skills[], category, contextBoundaries) and `WorkflowTemplate` (id, name, phases: Record<Phase, WorkflowStep[]>), `WorkflowStep` (agentId, enabled, config overrides).
- Add CRUD endpoints: `GET/POST /api/workflows`, `GET/PUT/DELETE /api/workflows/:id`, `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`.
- File persistence: read/write `.flux/workflows/*.json` and `.flux/agents/*.json`.
- Seed with a default template matching the confirmed design (Interrogator→Context Scout→Spec Writer for Grooming, etc.).

### 2. New Portal View — Workflow Builder (portal/src/)

- Add `workflow-builder` to `AppView` type in `AppContext.tsx`.
- Add navigation entry (sidebar/topnav) to reach the builder view.
- Create `WorkflowBuilder.tsx` — top-level view component.

### 3. Agent Library Column

- `AgentLibrary.tsx` — left column listing all defined agents from `/api/agents`.
- Each agent rendered as a draggable card (`@dnd-kit` draggable) showing name, CLI type badge, category tag.
- `[+ New Agent]` button at bottom → opens `AgentEditorModal.tsx` (name, CLI target, system prompt via Tiptap, skills multi-select from existing, category, context boundaries).

### 4. Phase Columns

- `PhaseColumn.tsx` — one per phase (Grooming, Implementation, Review, Release). Uses `@dnd-kit` `useDroppable` + `SortableContext` for reordering within.
- Template dropdown at top of each column (`TemplatePicker.tsx`) — lists saved templates for that phase, with [+ New Template] option.
- `WorkflowStepCard.tsx` — sortable card in a phase column showing: checkbox (enable/disable), agent name, CLI type, step number (derived from index). Click expands inline config panel.

### 5. Drag & Drop Orchestration

- Wrap entire builder in `DndContext` (mirrors Board.tsx pattern).
- Handle cross-container drag (library → phase column = clone, phase → phase = move).
- Handle within-column reorder (step reordering).
- `[+ Add Step]` button per column as non-drag alternative.

### 6. Inline Config Panel (expanded card)

- `StepConfigPanel.tsx` — shown when a step card is clicked/expanded.
- Fields: system prompt override (Tiptap editor), skills picker (multi-select from `/api/skills`), CLI target selector, context boundaries checkboxes.
- Skill edit shortcut: button opens `SkillEditorPopup.tsx` for the selected skill in a modal.

### 7. Dry Run / Preview Mode

- `[Preview Pipeline]` button in toolbar.
- `PipelinePreview.tsx` — visual representation showing execution order per phase, which steps are enabled/disabled, estimated context flow.
- No actual agent launching — read-only visualization.

### 8. Persistence & Sync

- Auto-save workflow changes (debounced PUT to `/api/workflows/:id`).
- Active workflow selection stored in board config (or `.flux/config.json`).
- Engine reads active workflow when FLUX-283 session orchestration launches agents.

### Key Files to Create/Modify

| File | Action |
|------|--------|
| `engine/src/routes/workflows.ts` | New — CRUD routes |
| `engine/src/routes/agents.ts` | New — CRUD routes |
| `engine/src/models/workflow.ts` | New — interfaces + file I/O |
| `engine/src/models/agent.ts` | New — interfaces + file I/O |
| `portal/src/components/WorkflowBuilder.tsx` | New — view shell |
| `portal/src/components/AgentLibrary.tsx` | New |
| `portal/src/components/PhaseColumn.tsx` | New |
| `portal/src/components/WorkflowStepCard.tsx` | New |
| `portal/src/components/StepConfigPanel.tsx` | New |
| `portal/src/components/AgentEditorModal.tsx` | New |
| `portal/src/components/TemplatePicker.tsx` | New |
| `portal/src/components/PipelinePreview.tsx` | New |
| `portal/src/components/SkillEditorPopup.tsx` | New |
| `portal/src/AppContext.tsx` | Modify — add view + workflow state |
| `portal/src/App.tsx` | Modify — render WorkflowBuilder view |

### Dependencies

- FLUX-285 (role prompts) provides the default agent definitions to seed the library.
- FLUX-283 (session orchestration) consumes the workflow config at runtime — but this ticket only builds the configuration UI.
