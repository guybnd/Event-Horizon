---
id: FLUX-34
title: Protocol Handler for IDE Navigation
status: Todo
priority: Medium
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - ux
  - integration
history:
  - type: comment
    user: Agent
    date: '2026-05-06T12:07:00.000Z'
    comment: >-
      Captured from Guy's request. This ticket adds deep links from Flux ticket
      content into the local IDE so file references become actionable instead of
      just informational.
effort: None
implementationLink: ''
---
## Groomed Scope

Support direct navigation from Flux tickets into local IDEs like VS Code,
Cursor, or Zed. The UI should recognize code references and generate links that
open the exact file and line in the user's editor.

## Requirements

### 1. Parse code references from ticket content
- Detect file paths and optional line numbers inside ticket descriptions and related content
- Resolve relative repo paths safely against the workspace root
- Avoid generating broken links for missing files or malformed references

### 2. Generate IDE protocol links
- Add backend support for normalizing paths into IDE-specific deep links
- Generate links such as `vscode://file/{full_path}:{line}` for supported editors
- Leave room for editor selection or fallback behavior when multiple IDEs are supported

### 3. Add user-facing navigation controls
- Render clickable links for recognized file references in the ticket view
- Add a `Teleport` action next to code blocks or other strongly linked code references
- Keep the experience obvious and low-friction from the modal and backlog/detail views

## Acceptance Criteria

- [ ] Ticket descriptions can surface parsed file-path references as clickable IDE links
- [ ] Links open the target file at the correct line when supported by the editor
- [ ] A `Teleport` control is available next to linked code blocks
- [ ] Invalid or missing paths fail gracefully instead of producing broken UI
- [ ] The design can support multiple editors, not only VS Code

## Likely Affected Areas

- `engine/src/index.ts`
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/types.ts`

## Notes

- A settings-level editor preference may be useful if supporting VS Code, Cursor, and Zed together
- Path normalization needs to account for Windows paths in this workspace