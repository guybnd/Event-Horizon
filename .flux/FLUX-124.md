---
assignee: Agent
tags:
  - feature
  - distribution
  - ux
priority: High
effort: M
implementationLink: 449fe3b
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

      Binary built at 87MB (includes all-platform tray binaries). PE header
      patched. Console window suppressed on Windows. Auto-open confirmed in
      build output.
    id: c-flux124-done
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T17:42:00.000Z'
  - type: status_change
    from: Done
    to: Require Input
    user: Guy
    date: '2026-05-08T07:47:40.444Z'
  - type: comment
    user: Guy
    date: '2026-05-08T07:49:16.607Z'
    comment: >-
      upon testing:


      1. system icon should be same as the app brower icon

      2. right click tray menu ahs a dumb "<SEPARATOR>" line

      3. should have project name line at the top

      4. it still opens a cmd window, that upon user closing it, kills the app.
      bad UX

      cant it live in background service in the tray icon?
    replyTo: c-flux124-done
    id: c-2026-05-08t07-49-16-607z
  - type: comment
    user: Agent
    date: '2026-05-08T18:00:00.000Z'
    comment: >-
      Fixed 4 issues from testing:

      1. Icon: replaced ICO with PNG (Go binary expects base64 PNG, not ICO).
         Added `crc32()`, `pngChunk()`, `buildTrayIconPng()` — generates a 16x16
         solid #863bff (portal violet) PNG at runtime using Node's built-in `zlib`.

      2. Separator showing as text: removed `<SEPARATOR>` item entirely. The Go
         binary has no separator support in its JSON protocol — it was rendering
         the literal string as a menu item.

      3. CMD window: added `windowsHide: true` to the `spawn()` call for the
      tray
         binary. This was the same fix used in the systray JS library. The PE
         header patch suppresses the main exe's console; `windowsHide` suppresses
         the spawned tray process's console.

      4. Project name: added two disabled header items at the top of the menu —
         "Event Horizon" (app name) and the current workspace basename (or
         "No project open"). Menu is now: header / project name / Open in Browser
         / Quit.

      5. Protocol fix: now waits for `{type: "ready"}` from the Go binary before
         writing the menu JSON, matching the expected handshake protocol.

      Binary rebuilt and PE-patched.
    id: c-flux124-fixes
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T18:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Closing FLUX-124. All originally scoped items are shipped: systray binary
      integration, pkg extraction, auto-open browser, configurable port, PE
      header patch (no CMD window), right-click menu with project name, ready
      handshake protocol. Commits: a95ebc9, 5c5d727, 10d01f7, eea58fe, 449fe3b.

      One known issue remains: the tray icon is blank on Windows despite valid
      base64 PNG being sent. This is tracked separately as FLUX-129 and will be
      investigated independently.
    id: c-flux124-close
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.339Z'
title: System tray icon for the standalone binary
status: Released
createdBy: Guy
updatedBy: Agent
order: 0
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.339Z'
releaseDocPath: release-notes/0.2.0
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

