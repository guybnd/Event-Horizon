---
assignee: unassigned
tags:
  - ui
  - portal
priority: Low
effort: XS
implementationLink: 5a44011596984d6bc72fd361bb83c4794793a971
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T03:40:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T03:40:00.000Z'
    comment: >-
      Implementation complete. Added class-based dark mode via @custom-variant
      in index.css, theme state with localStorage persistence and OS-preference
      fallback in AppContext.tsx, and a Sun/Moon toggle button in Header.tsx.
      Commit: 5a44011.
    id: c-2026-05-09t03-40-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T03:40:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T03:04:45.517Z'
  - type: activity
    user: Agent
    date: '2026-05-09T03:04:45.517Z'
    comment: Updated implementation link.
  - type: comment
    user: Claude Code
    date: '2026-05-09T03:04:48.386Z'
    comment: >-
      ```text

      FLUX-147 is closed. Commit `5a44011` — dark/light mode toggle is shipped
      and the ticket is `Done`.

      ```
    id: c-2026-05-09t03-04-48-386z
title: add a dark\light mode toggle on top
status: Done
createdBy: Guy
updatedBy: Agent
description: >-
  ## Goal

  Add a dark/light mode toggle button in the portal header so users can manually
  override the OS color scheme preference.


  ## Current State

  - The portal uses Tailwind CSS v4 with `dark:` modifiers throughout.

  - Dark mode is currently driven by OS `prefers-color-scheme` (Tailwind v4
  default).

  - No toggle exists anywhere in the UI.


  ## Implementation Plan


  ### 1. Enable class-based dark mode in `portal/src/index.css`

  Add a custom Tailwind v4 dark variant:

  ```

  @custom-variant dark (&:is(.dark *));

  ```

  This switches dark mode from media-query-driven to class-driven.


  ### 2. Add theme state to `portal/src/AppContext.tsx`

  - Add `theme: 'light' | 'dark'` state, initialized from
  `localStorage.getItem('eh-theme')` or OS preference fallback.

  - On mount and on change, sync to `document.documentElement.classList`
  (add/remove `dark`).

  - Expose `theme` and `toggleTheme()` via context.

  - Persist choice to `localStorage` on toggle.


  ### 3. Add toggle button to `portal/src/components/Header.tsx`

  - Import `Sun` and `Moon` from `lucide-react`.

  - Place a small icon button between the stop-service button and the Project
  Key input.

  - Clicking cycles between light and dark.

  - Icon shows `Sun` in dark mode (click to go light) and `Moon` in light mode
  (click to go dark).


  ## Files

  - `portal/src/index.css`

  - `portal/src/AppContext.tsx`

  - `portal/src/components/Header.tsx`


  ## Validation

  - Toggle switches theme visually on click.

  - Preference is restored after page reload.

  - OS pref is used as default when no stored preference exists.
---

