---
title: Asset Visualization for Dev Tasks
status: Backlog
priority: Low
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - ux
  - assets
history:
  - type: activity
    user: Guy
    date: '2026-05-06T12:09:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-06T12:09:00.000Z'
    comment: >-
      Captured from Guy's request. This ticket extends Flux beyond markdown by
      previewing linked art and config assets that commonly appear in Unity or
      Godot workflows.
    id: c-2026-05-06t12-09-00-000z
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T13:25:17.698Z'
effort: M
implementationLink: ''
order: 4
---
## Groomed Scope

Enable ticket views to preview common linked assets, starting with images and a
basic JSON diff experience for configuration changes.

## Requirements

### 1. Preview linked image assets
- Detect linked `.png`, `.jpg`, `.jpeg`, and `.svg` assets in ticket content
- Render inline previews in the ticket view when the files are available locally
- Keep previews safe and lightweight so large assets do not destabilize the UI

### 2. Add a basic JSON diff viewer
- Recognize linked JSON configuration files or JSON diff references
- Render a readable side-by-side or structured diff view for changed configuration files
- Fall back to plain text when a structured diff cannot be generated

### 3. Fit game-dev workflows
- Make the preview experience useful for Unity, Godot, and similar local asset-heavy projects
- Preserve the existing markdown-driven authoring flow rather than forcing a new asset format
- Ensure previews work from the same ticket surfaces where users review task details today

## Acceptance Criteria

- [ ] Linked image files can be previewed inline in the ticket view
- [ ] Supported image types include `.png`, `.jpg`, `.jpeg`, and `.svg`
- [ ] A basic JSON diff visualization exists for linked configuration changes
- [ ] Unsupported or missing assets fail gracefully
- [ ] The feature does not break existing markdown-only tickets

## Likely Affected Areas

- `engine/src/index.ts`
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/types.ts`

## Notes

- This is a good candidate for phased delivery: image preview first, JSON diff second
- Very large binary assets may need lazy loading or thumbnail generation later
