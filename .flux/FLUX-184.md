---
priority: Low
effort: M
tags:
  - refactor
  - dx
assignee: unassigned
createdBy: Unknown
title: Split Settings.tsx into per-section components
status: Todo
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-10T14:43:44.340Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T01:30:47.782Z'
    comment: Launched Claude Code session (24322b07).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T01:31:56.130Z'
  - type: comment
    user: Agent
    date: '2026-05-11T01:31:56.130Z'
    comment: >-
      Grooming complete. Actual tabs differ from ticket description: workflow,
      attributes, workspace, preferences, agent. Plan: create
      portal/src/components/settings/ with sub-components (colorUtils.ts,
      SortableRow, StatusColorPicker, TagEditor, StatusEditor, PriorityEditor,
      SimpleEditor, SettingToggleCard) plus 5 section files (WorkflowSection,
      AttributesSection, WorkspaceSection, PreferencesSection, AgentSection).
      State that feeds the save payload stays in parent and is prop-drilled.
      UI-only state (workspace switcher, skill install) moves into the owning
      section. Parent reduces to ~100-150 lines of tab switching + state + save
      handler.
    id: c-2026-05-11t01-31-56-130z
---
## Goal

Extract each settings section from `portal/src/components/Settings.tsx` (1447 lines) into its own component file, leaving the parent as a tab switcher + save handler only.

## Context

This is the third follow-on from FLUX-172. `Settings.tsx` already has internal sub-components (`TagEditor`, `StatusEditor`, `PriorityEditor`, `SimpleEditor`) but the main `Settings` export is still large because all sections (General, Board, Integrations, Releases) are inline.

## Proposed Split

Extract each tab section into `portal/src/components/settings/`:

```
portal/src/components/settings/
  GeneralSection.tsx     ← general settings fields
  BoardSection.tsx       ← board columns, status config
  IntegrationsSection.tsx ← integration settings
  ReleasesSection.tsx    ← release settings
```

Move existing sub-components (`TagEditor`, `StatusEditor`, `PriorityEditor`, `SimpleEditor`) into this directory as well.

The parent `Settings.tsx` becomes a tab switcher + save handler, importing and rendering these section components.

## Constraints

- No behaviour changes — structural refactor only
- All existing Settings functionality must work identically
- TypeScript types must remain accurate

## Validation

- Portal compiles without TypeScript errors
- All settings tabs render and save correctly
- No visual regressions in the Settings screen
