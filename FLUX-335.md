---
assignee: unassigned
tags:
  - feature
priority: Low
effort: M
implementationLink: 3e4f331
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-28T12:46:29.203Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-28T12:46:40.335Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-28T12:46:51.812Z'
    comment: Updated description.
  - type: agent_session
    sessionId: 6ce0d143-20b1-48cc-8473-94e0073ad7a1
    startedAt: '2026-05-28T14:38:02.921Z'
    status: completed
    progress:
      - timestamp: '2026-05-28T14:38:15.180Z'
        message: Reading image-2.png
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\assets\FLUX-335\image-2.png'
      - timestamp: '2026-05-28T14:38:18.437Z'
        message: Reading
        type: info
      - timestamp: '2026-05-28T14:38:18.954Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/**/*theme*
      - timestamp: '2026-05-28T14:38:26.657Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore portal theming setup
            subagent_type: Explore
            prompt: >-
              I need to understand how the portal (React app) handles theming.
              Look at:

              1. Any CSS files or tailwind config for dark/light mode or themes

              2. AppContext.tsx or any context that manages theme state

              3. Any settings or preferences UI for theme selection

              4. The tailwind.config or similar for custom colors/styles


              The portal is in portal/src/. Report what exists for theming today
              and how it's structured.
      - timestamp: '2026-05-28T14:38:30.258Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: 'portal/src/**/*.{tsx,ts,css,scss}'
      - timestamp: '2026-05-28T14:38:30.802Z'
        message: 'Running: find /c/GitHub/EventHorizon/portal -type f \( -nam...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/portal -type f \( -name "*tailwind*"
              -o -name "*config*" -o -name "*.config.js" -o -name "*.config.ts"
              \) | head -20
      - timestamp: '2026-05-28T14:38:33.441Z'
        message: Running command
        type: info
      - timestamp: '2026-05-28T14:38:37.073Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/src/AppContext.tsx
      - timestamp: '2026-05-28T14:38:44.208Z'
        message: 'Running: find /c/GitHub/EventHorizon/portal -maxdepth 1 -ty...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/portal -maxdepth 1 -type f \( -name
              "package.json" -o -name "tailwind*" -o -name "postcss*" \)
      - timestamp: '2026-05-28T14:38:46.898Z'
        message: Reading Header.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/src/components/Header.tsx
      - timestamp: '2026-05-28T14:38:47.255Z'
        message: 'Running: grep -r "toggleTheme\|dark:" /c/GitHub/EventHorizo...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "toggleTheme\|dark:" /c/GitHub/EventHorizon/portal/src
              --include="*.tsx" --include="*.ts" | head -30
      - timestamp: '2026-05-28T14:38:48.441Z'
        message: Running command
        type: info
      - timestamp: '2026-05-28T14:38:51.137Z'
        message: Reading vite.config.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/vite.config.ts
      - timestamp: '2026-05-28T14:38:51.407Z'
        message: 'Running: find /c/GitHub/EventHorizon/portal -name "*.css" -...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/portal -name "*.css" -type f | xargs
              ls -la
      - timestamp: '2026-05-28T14:39:00.338Z'
        message: Reading statusStyles.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/src/statusStyles.ts
      - timestamp: '2026-05-28T14:39:00.677Z'
        message: 'Running: grep -r "bg-bg-dark\|primary-hover\|color-" /c/Git...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "bg-bg-dark\|primary-hover\|color-"
              /c/GitHub/EventHorizon/portal/src --include="*.tsx"
              --include="*.ts" | head -20
      - timestamp: '2026-05-28T14:39:03.441Z'
        message: Running command
        type: info
      - timestamp: '2026-05-28T14:39:25.591Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '**/assets/FLUX-335/**'
      - timestamp: '2026-05-28T14:39:28.540Z'
        message: Reading image-2.png
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux-store\assets\FLUX-335\image-2.png'
      - timestamp: '2026-05-28T14:39:33.450Z'
        message: Reading
        type: info
      - timestamp: '2026-05-28T14:39:39.265Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:update_ticket,change_status'
            max_results: 2
      - timestamp: '2026-05-28T14:39:46.912Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__update_ticket,mcp__event-horizon__change_status,mcp__event-horizon__get_ticket
            max_results: 3
      - timestamp: '2026-05-28T14:39:48.453Z'
        message: Working
        type: info
      - timestamp: '2026-05-28T14:39:59.775Z'
        message: 'Running: curl -s http://localhost:3067/api/tasks/FLUX-335 2...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s http://localhost:3067/api/tasks/FLUX-335 2>/dev/null |
              head -100
            description: Get ticket FLUX-335 via REST API
      - timestamp: '2026-05-28T14:40:03.453Z'
        message: Running command
        type: info
      - timestamp: '2026-05-28T14:40:18.457Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-28T14:40:20.502Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-335 -H
              "Content-Type: application/json" -d '{
                "priority": "Low",
                "effort": "M",
                "tags": ["feature"],
                "body": "## Problem / Motivation\n\nThe portal currently only supports plain light/dark modes with flat backgrounds. Users want more visually distinctive, immersive themes — like a Matrix-style textured background with subtle cross/grid patterns and color tints. Adding a theme picker with several preset textured themes makes the board feel more personalized and visually engaging.\n\n## Implementation Plan\n\n1. **Extend the theme system** — expand `AppTheme` type from `\"light\" | \"dark\"` to support named themes (e.g., `\"light\"`, `\"dark\"`, `\"matrix\"`, `\"cyber\"`, `\"midnight\"`). Each theme defines: base mode (light/dark for Tailwind class), CSS custom properties for backgrounds/accents, and an optional background texture (CSS pattern or SVG).\n\n2. **Create textured background presets** — implement 3-4 CSS-based texture themes using repeating gradients, SVG patterns, or pseudo-elements:\n   - **Matrix** — dark bg with green-tinted cross/grid pattern (per reference image)\n   - **Cyber** — dark bg with blue/purple geometric line pattern\n   - **Midnight** — deep navy with subtle dot grid\n   - Keep light/dark as plain options\n\n3. **Build theme picker UI** — add a theme selector in the Preferences settings section (`PreferencesSection.tsx`) showing visual thumbnails/swatches for each theme. Replace the header sun/moon toggle with a more general theme indicator that opens the picker or cycles themes.\n\n4. **Apply themes via CSS custom properties** — set properties on `document.documentElement` (background color, texture overlay, accent tints) so existing `dark:` classes continue working. Texture applied as a fixed/absolute pseudo-element or overlay div behind content.\n\n5. **Persist selection** — store chosen theme name in localStorage (`eh-theme` key, already used for light/dark).\n\n### Key Files\n- `portal/src/AppContext.tsx` — theme state, persistence, application\n- `portal/src/index.css` — theme CSS variables and texture definitions\n- `portal/src/components/settings/PreferencesSection.tsx` — theme picker UI\n- `portal/src/components/Header.tsx` — update toggle button",
                "appendHistory": [
                  {
                    "type": "comment",
                    "user": "Agent",
                    "date": "2026-05-29T10:15:22.431Z",
                    "comment": "Groomed ticket: M effort feature to add textured theme presets (Matrix, Cyber, Midnight) and a theme picker in settings. Existing light/dark modes stay as plain options."
                  }
                ]
              }'
            description: Update ticket FLUX-335 with groomed metadata and body
      - timestamp: '2026-05-28T14:40:25.167Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-335 -H
              "Content-Type: application/json" -d '{
                "status": "Todo",
                "appendHistory": [
                  {
                    "type": "status_change",
                    "from": "Grooming",
                    "to": "Todo",
                    "user": "Agent",
                    "date": "2026-05-29T10:15:45.712Z"
                  }
                ]
              }'
            description: Move ticket FLUX-335 to Todo status
      - timestamp: '2026-05-28T14:40:29.787Z'
        message: >-
          Grooming complete. FLUX-335 is now in **Todo** with:


          - **Priority:** Low

          - **Effort:** M

          - **Tags:** feature

          - **Plan:** Extend the theme system to support named textured presets
          (Matrix green grid, Cyber blue/purple geometric, Midnight navy dot
          grid) alongside existing plain light/dark. Adds a theme picker in
          Preferences settings with visual swatches, applied via CSS custom
          properties and background textures.
    user: Claude Code
    date: '2026-05-28T14:38:02.921Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-28T14:40:29.787Z'
  - type: activity
    user: Agent
    date: '2026-05-28T14:40:20.804Z'
    comment: >-
      Updated description. Updated tags to feature. Changed priority from None
      to Low. Changed effort from None to M.
  - type: comment
    user: Agent
    date: '2026-05-28T14:40:20.804Z'
    comment: >-
      Groomed ticket: M effort feature to add textured theme presets (Matrix,
      Cyber, Midnight) and a theme picker in settings. Existing light/dark modes
      stay as plain options.
    id: c-2026-05-28t14-40-20-804z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-28T14:40:25.382Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-28T14:40:25.382Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-29T00:48:44.858Z'
  - type: comment
    user: Agent
    comment: >-
      Starting implementation. Plan: (1) Expand AppTheme to named themes with
      metadata, (2) Add CSS texture definitions in index.css, (3) Update
      AppContext theme logic for persistence and application, (4) Add theme
      picker to PreferencesSection, (5) Update Header toggle to cycle themes.
    date: '2026-05-29T00:48:46.454Z'
    id: c-2026-05-29t00-48-46-454z
  - type: comment
    user: Agent
    comment: >-
      Implemented textured theme system. Changes: (1) Expanded AppTheme type to
      include 'matrix', 'cyber', 'midnight' alongside 'light'/'dark'. (2) Added
      CSS texture backgrounds using fixed pseudo-elements with
      grid/geometric/dot patterns. (3) Added theme picker with visual swatches
      in Settings > Preferences. (4) Header toggle now cycles all 5 themes with
      appropriate icons (Sun/Moon/Palette). (5) Persists to localStorage under
      existing 'eh-theme' key. TypeScript and Vite build pass cleanly. Files
      changed: AppContext.tsx, Header.tsx, PreferencesSection.tsx, index.css.
    date: '2026-05-29T00:51:41.126Z'
    id: c-2026-05-29t00-51-41-126z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-29T00:51:41.126Z'
  - type: comment
    user: Agent
    comment: >-
      Added 3 textured theme presets (Matrix, Cyber, Midnight) with a header
      dropdown picker and Settings visual swatches. Themes apply CSS background
      patterns to body with the app shell made transparent. Existing light/dark
      modes preserved. Key files: AppContext.tsx (theme system), index.css
      (textures), Header.tsx (dropdown), PreferencesSection.tsx (swatches),
      App.tsx (transparent shell class).
    date: '2026-05-29T01:02:41.946Z'
    id: c-2026-05-29t01-02-41-946z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-29T01:02:41.946Z'
title: cool textured theme
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 386105
  outputTokens: 3021
  costUSD: 0.56708
  costIsEstimated: false
  cacheReadTokens: 355912
  cacheCreationTokens: 30143
id: FLUX-335
---
## Problem / Motivation

The portal currently only supports plain light/dark modes with flat backgrounds. Users want more visually distinctive, immersive themes � like a Matrix-style textured background with subtle cross/grid patterns and color tints. Adding a theme picker with several preset textured themes makes the board feel more personalized and visually engaging.

## Implementation Plan

1. **Extend the theme system** � expand `AppTheme` type from `"light" | "dark"` to support named themes (e.g., `"light"`, `"dark"`, `"matrix"`, `"cyber"`, `"midnight"`). Each theme defines: base mode (light/dark for Tailwind class), CSS custom properties for backgrounds/accents, and an optional background texture (CSS pattern or SVG).

2. **Create textured background presets** � implement 3-4 CSS-based texture themes using repeating gradients, SVG patterns, or pseudo-elements:
   - **Matrix** � dark bg with green-tinted cross/grid pattern (per reference image)
   - **Cyber** � dark bg with blue/purple geometric line pattern
   - **Midnight** � deep navy with subtle dot grid
   - Keep light/dark as plain options

3. **Build theme picker UI** � add a theme selector in the Preferences settings section (`PreferencesSection.tsx`) showing visual thumbnails/swatches for each theme. Replace the header sun/moon toggle with a more general theme indicator that opens the picker or cycles themes.

4. **Apply themes via CSS custom properties** � set properties on `document.documentElement` (background color, texture overlay, accent tints) so existing `dark:` classes continue working. Texture applied as a fixed/absolute pseudo-element or overlay div behind content.

5. **Persist selection** � store chosen theme name in localStorage (`eh-theme` key, already used for light/dark).

### Key Files
- `portal/src/AppContext.tsx` � theme state, persistence, application
- `portal/src/index.css` � theme CSS variables and texture definitions
- `portal/src/components/settings/PreferencesSection.tsx` � theme picker UI
- `portal/src/components/Header.tsx` � update toggle button
