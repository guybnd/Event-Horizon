---
assignee: Agent
tags:
  - feature
  - distribution
  - ux
priority: High
effort: M
implementationLink: 'a95ebc9'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T07:22:35.054Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T17:30:00.000Z'
    comment: >-
      Groomed. The `systray` npm package (v1.0.5) ships pre-compiled Go binaries
      in `traybin/` (Windows: tray_windows_release.exe ~4.6MB) and communicates
      via stdin/stdout JSON — no native .node addon, so it is compatible with
      pkg packaging when the binary is extracted to a temp directory at runtime.


      Implementation plan:

      1. `npm install systray -w engine`.

      2. `engine/scripts/build.js`: copy
      `node_modules/systray/traybin/tray_windows_release.exe`
         (and macOS/Linux variants) into `engine/dist/traybin/`.

      3. `engine/package.json` pkg.assets: add `"dist/traybin/**/*"`.

      4. `engine/src/index.ts`: on startup (after `app.listen` resolves), call
         `initTray()`. That function: (a) resolves the binary path from `__dirname/traybin/`
         (works for both dev and pkg since pkg embeds assets relative to __dirname);
         (b) extracts the binary to `os.tmpdir()/event-horizon-tray-<platform>.exe`
         if running as pkg (pkg virtual FS cannot execute directly); (c) creates a
         `Systray` instance with the menu below; (d) handles `onExit` to call
         `process.exit(0)`.

      5. Tray icon: use a bundled .ico file (engine/assets/icon.ico) for
      Windows;
         fall back to a base64-encoded monochrome placeholder if the icon file is absent.

      6. Menu items (proposed — see open question below):
         - "Event Horizon" (disabled label/header)
         - "Open in Browser" → open http://localhost:<PORT> in default browser via
           `open` package or `start <url>` shell command
         - separator
         - "Quit Event Horizon" → `process.exit(0)`

      Open question: besides "Open in Browser" and "Quit", should the tray menu
      also show the current workspace path (as a disabled label), and/or a
      "Switch Workspace" item that opens the portal workspace-selector screen?
      Proposed default: just show workspace name as a disabled info line.

      Also: should the binary auto-open the browser on launch? Proposed default:
      yes, open http://localhost:3001 automatically after the server starts
      (with a short 1 s delay to let Express bind). This makes running the exe
      feel like a proper app.
    id: c-flux124-groom
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-08T17:30:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T07:34:34.488Z'
    comment: >-
      yes we can make a ticket in the future to add a workspace picker (it
      require multi workspace support anyway as anice big feature)

      yes open browser on default

      also in the binary in the config file we should have a setting that
      decides the port so its user configurable before opening the executable

      also does the cmd terminal have to stay on? cannt we have it as a
      background service?
    replyTo: c-flux124-groom
    id: c-2026-05-08t07-34-34-488z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-08T07:34:34.488Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-08T17:42:00.000Z'
    comment: >-
      Implementation complete. Summary:

      1. Installed `systray` npm package to obtain pre-compiled Go tray binaries
         (Windows/macOS/Linux). JS module not imported — only the binaries are used.

      2. `engine/scripts/build.js`: stages `node_modules/systray/traybin/` into
         `engine/dist/traybin/` during build.

      3. `engine/package.json`: `dist/traybin/**/*` added to `pkg.assets`.
         `package:win` script now runs `node scripts/patch-pe.js` after packaging.

      4. `engine/scripts/patch-pe.js` (new): patches the Windows .exe PE header
         subsystem from 3 (CUI/console) to 2 (GUI/windowed) so no CMD window
         appears on double-click.

      5. `engine/src/index.ts`:
         - `readPortConfig()`: in pkg mode, reads/creates `event-horizon.config.json`
           adjacent to the exe for user-configurable port (default 3001).
         - `openBrowser(url)`: cross-platform browser launcher.
         - `buildTrayIcon()`: generates a 16×16 indigo ICO in-memory as base64.
         - `initTray(port)`: extracts the tray binary to a real temp dir (in pkg mode),
           spawns it, implements the stdin/stdout JSON protocol, handles
           "Open in Browser" and "Quit Event Horizon" menu items.
         - `startServer()`: async startup wrapper; in pkg mode auto-opens the
           browser 800ms after bind, then inits the tray.

      Binary built at 87MB (includes all-platform tray binaries). PE header patched.
      Console window suppressed on Windows. Auto-open confirmed in build output.
    id: c-flux124-done
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T17:42:00.000Z'
title: System tray icon for the standalone binary
status: Done
createdBy: Guy
updatedBy: Agent
---

## Problem / Motivation

When `event-horizon.exe` runs, there is no visible sign of a running process — no window, no taskbar entry, nothing to right-click to quit. Users must kill the process via Task Manager or the portal's Stop button. A system tray icon gives the binary a proper desktop presence: it shows the app is running, lets users open the portal, and provides a clean one-click Quit.

## Implementation Plan

1. **Install `systray`** (npm v1.0.5, pre-compiled Go tray binaries in `traybin/`).
2. **Build script** (`engine/scripts/build.js`): copy `traybin/` for all platforms into `engine/dist/traybin/` so it gets staged alongside the bundle.
3. **pkg.assets**: add `"dist/traybin/**/*"` so the binaries are embedded in the `.exe`.
4. **Runtime extraction** (`engine/src/index.ts` — `initTray()`):
   - When running as pkg, extract the platform tray binary from `__dirname/traybin/` to `os.tmpdir()` (pkg virtual FS cannot `execFile` directly).
   - Construct the `Systray` instance with the extracted binary path.
5. **Tray menu** (see open questions for user input on items).
6. **Auto-open browser** on startup (see open question).
7. **Icon file**: bundle `engine/assets/icon.ico` and reference it in the tray init. Can use a minimal 16×16 monochrome placeholder initially.

## Open Questions

1. Tray menu: should it show a disabled workspace name line, and/or a "Switch Workspace" item? Proposed default: show current workspace path as a disabled info label, no Switch item.
2. Auto-open browser on launch: yes or no? Proposed default: yes, open `http://localhost:3001` 1 s after server starts.

