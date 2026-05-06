---
title: Local executable / packaged app
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:33:00.000Z'
    comment: >-
      Fleshed this out with packaging options. Need your input on the target
      platform and packaging approach — see Open Questions.
  - type: comment
    user: Guy
    date: '2026-05-06T07:37:17.476Z'
    comment: >-
      1. win and mac for starter

      2. browser based

      3. git binary is fine 

      4. maybe some check if repo on github is further ahead and a prompt for
      user to update it

      5. ye can have it later
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T07:37:22.840Z'
order: 5
---
## Summary

Package Event Horizon as a standalone executable so it can run independently without requiring Node.js, npm, or an IDE. This would allow distribution as a portable app.

## Requirements

### 1. Single executable or installer
- User downloads a single file and runs it
- Launches the engine (Express server) and opens the portal (Vite-built frontend) in the browser
- No Node.js installation required on the target machine

### 2. Packaging options

| Approach | Pros | Cons |
|----------|------|------|
| **Electron** | Full desktop app, system tray, native feel | Heavy (~100MB+), complex build |
| **pkg (Vercel)** | Bundles Node.js into single exe, lightweight | No native UI, opens in browser |
| **nexe** | Similar to pkg, compiles to native binary | Less maintained |
| **Tauri** | Lightweight native wrapper (~10MB), Rust-based | Requires Rust toolchain for building |
| **Docker** | Cross-platform, easy deployment | Requires Docker on target |

### 3. Recommended approach: `pkg` + system tray

**Phase 1:** Use `pkg` to bundle the engine into a standalone `.exe` / binary
- Build the portal (`vite build`) and serve the static files from the engine
- Engine serves both API and frontend from a single process
- User runs the exe, it starts on `localhost:3001`, opens browser automatically

**Phase 2:** Optional Electron or Tauri wrapper for a proper desktop app
- System tray icon with "Open Board" and "Quit" options
- Auto-start on login option
- Native notifications for "Require Input" tickets

### 4. Build pipeline
- `npm run build` — builds portal + compiles engine
- `npm run package` — creates distributable exe
- Output: `dist/event-horizon-win.exe`, `dist/event-horizon-mac`, `dist/event-horizon-linux`

## Open Questions

> **@Guy — Need your input:**
>
> 1. **Target platforms?** Windows only for now, or also Mac/Linux?
> 2. **Desktop app or browser-based?** Do you want a proper desktop window (Electron/Tauri) or is "runs as exe, opens in browser" sufficient?
> 3. **Distribution method?** Just a downloadable binary on GitHub releases, or an actual installer (`.msi` / `.dmg`)?
> 4. **Auto-update?** Should the app check for and install updates, or is manual download fine?
> 5. **Priority?** This feels like a polish/release task. Should we focus on features first (FLUX-5, 6, 9, etc.) and do packaging later?

## Acceptance Criteria

- [ ] Single command to build a distributable binary
- [ ] Binary runs without Node.js installed
- [ ] Launches engine + serves portal UI
- [ ] Opens browser automatically to the portal
- [ ] Works on at least Windows (primary target)
- [ ] Connects to the correct `.flux/` directory (working directory or configurable)

## Files to Create/Modify

- `engine/src/index.ts` — Add static file serving for built portal assets
- `scripts/build.ts` — **[NEW]** Build and package script
- `package.json` — Add `build` and `package` scripts
- `electron/` or `tauri/` — **[NEW]** If going desktop app route

## Dependencies

- Should be done after core features are stable
- Portal must be `vite build`-able (currently works)

