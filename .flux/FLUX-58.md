---
id: FLUX-58
title: Add initial keyboard shortcuts
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags: []
priority: Low
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T03:14:09.546Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T03:14:45.708Z'
    comment: Changed priority from None to Low.
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Groomed this into a safe first shortcut slice built around common web-app
      conventions: global search, new ticket, escape-to-close, and a visible
      shortcut cheat sheet. This is ready for `Todo`.
    id: c-2026-05-07t03-53-39-4816199z-flux-58
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
---
## Summary

Add a first pass of keyboard shortcuts for common navigation and ticket actions,
starting with safe, conventional shortcuts that work well for keyboard-heavy
users without interfering with text editing.

## Requirements

### 1. Ship a small, conventional shortcut set first
- `Ctrl`/`Cmd` + `K` opens or focuses global search
- `Escape` closes search, popups, full-view overlays, or other transient UI when appropriate
- `N` or an equivalent single-key shortcut creates a new ticket when focus is not inside an input or editor
- `?` should open a small shortcut reference or help surface if the implementation stays lightweight enough

### 2. Avoid breaking text editing
- Global shortcuts must not hijack typing while focus is inside text inputs, textareas, or the docs editor
- Shortcuts should work on Windows and macOS with the expected modifier key differences
- The implementation should centralize shortcut registration rather than scattering ad-hoc listeners everywhere

### 3. Make shortcuts discoverable
- Show the primary shortcuts somewhere visible, such as search UI, settings, or a small cheat sheet
- If a shortcut is unavailable in the current context, fail silently instead of producing confusing behavior

## Acceptance Criteria

- [ ] `Ctrl`/`Cmd` + `K` opens global search
- [ ] `Escape` closes the active transient UI safely
- [ ] A keyboard shortcut exists for creating a new ticket outside text-editing contexts
- [ ] Shortcut handlers do not interfere with normal typing in editors or textareas
- [ ] Users can discover the available shortcuts from the UI

## Likely Affected Areas

- `portal/src/components/Header.tsx`
- `portal/src/AppContext.tsx` or a new keyboard-shortcut hook/module
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/components/Settings.tsx` if the shortcut list is documented there
