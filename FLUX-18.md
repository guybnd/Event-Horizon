---
title: Local executable / packaged app
status: Grooming
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - feature
  - mvp
subtasks:
  - FLUX-76
  - FLUX-77
  - FLUX-78
  - FLUX-79
  - FLUX-80
history:
  - type: activity
    user: Guy
    date: '2026-05-06T07:33:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-06T07:33:00.000Z'
    comment: >-
      Fleshed this out with packaging options. Need your input on the target
      platform and packaging approach — see Open Questions.
    id: c-2026-05-06t07-33-00-000z
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
    id: c-2026-05-06t07-37-17-476z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T07:37:22.840Z'
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Tightened this around the answered packaging decisions: browser-based
      runtime, Windows and macOS as the first targets, Git as an external
      prerequisite, and update prompts rather than full auto-update. This is
      concrete enough to stay in `Todo`.
    id: c-2026-05-07t03-53-39-4816199z-flux-18
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-25T06:41:22.353Z'
order: 12
priority: Medium
effort: L
implementationLink: ''
---
## Summary

Package Event Horizon as a standalone local app that ships without requiring
Node.js, npm, or VS Code. The packaged binary should start the engine API,
serve the pre-built portal static assets, and open the user's default browser —
behaving like a native desktop tool rather than a developer environment.

## Current Architecture

Understanding the starting point for packaging decisions:

- **Root:** npm workspace monorepo (`engine/` + `portal/`)
- **Engine:** Express + TypeScript server, run via `tsx watch src/index.ts` (dev mode), uses `chokidar`, `gray-matter`, `cors`
- **Portal:** Vite + React + TailwindCSS SPA, builds to `portal/dist/`
- **State:** All state lives in `.flux/` directory (markdown files + `config.json`)
- **Docs:** Served from `.docs/` directory
- **No database**, no cloud — everything is filesystem-backed

## Requirements

### 1. Compile the engine into a standalone binary
- Use a Node.js single-executable bundler such as `pkg`, `nexe`, or Node.js SEA (Single Executable Applications)
- The binary must embed all engine dependencies (express, chokidar, gray-matter, etc.)
- The binary must be able to find and serve the portal's pre-built static assets from a predictable relative path (e.g. `./portal-dist/` next to the binary, or embedded)
- Target output: `event-horizon.exe` (Windows) and `event-horizon` (macOS)

### 2. Serve the portal from the engine process
- Add static file serving to the engine: `app.use(express.static(portalDistPath))`
- Serve `index.html` as the fallback for client-side routing (SPA catch-all)
- The portal's `api.ts` currently hardcodes `http://localhost:3001/api` — for packaged mode, the portal should use relative `/api` paths since both are served from the same origin
- Add a build-time or runtime flag to switch between dev mode (separate Vite dev server) and packaged mode (static serving from engine)

### 3. Resolve the workspace directory
- The `.flux/` directory path is currently hardcoded as `path.join(__dirname, '../../.flux')`
- For packaged mode, the binary needs a different resolution strategy:
  - **Option A:** Accept a CLI argument: `event-horizon.exe --workspace C:\Projects\MyRepo`
  - **Option B:** Use the current working directory: `process.cwd()/.flux/`
  - **Option C:** Prompt the user with a directory picker on first run (requires more UI work)
- Recommendation: Start with Option B (CWD-based) with Option A as an override. Add a startup check that exits with a clear message if `.flux/` is not found.

### 4. Auto-open the browser on launch
- After the engine starts listening, open `http://localhost:3001` in the default browser
- Use Node.js `child_process.exec` with platform-specific commands: `start` (Windows), `open` (macOS)
- Add a `--no-browser` flag to suppress auto-open for headless/CI usage

### 5. Build and package pipeline
- Add root-level scripts:
  - `npm run build` — builds portal for production (`vite build`) and compiles engine TypeScript
  - `npm run package` — runs the build, then packages the compiled engine + portal dist into a standalone binary
  - `npm run package:win` / `npm run package:mac` for platform-specific targets
- The packaging config should live in the root `package.json` or a dedicated `scripts/package.js`

### 6. Lightweight update awareness
- On startup, make a single `GET` to the GitHub releases API (e.g. `https://api.github.com/repos/{owner}/{repo}/releases/latest`)
- Compare the remote version tag against the local `package.json` version
- If a newer version exists, show a one-line console message and optionally surface it in the portal header
- Fail silently when offline — never block startup on a network check

### 7. Git as an external prerequisite
- Git remains a user-installed dependency; do not bundle it
- Git-aware features (commit tracking, branch detection) should check for `git` availability on startup
- If git is not found, log a clear message and disable git-dependent features rather than crashing

## Acceptance Criteria

- [ ] `npm run build` produces a production portal bundle and compiled engine
- [ ] `npm run package` creates a standalone binary for the current platform
- [ ] The binary launches without Node.js, npm, or VS Code installed
- [ ] The binary serves both the API and portal UI from a single process on one port
- [ ] The binary opens the default browser automatically on launch
- [ ] The binary resolves `.flux/` from CWD or a `--workspace` argument
- [ ] The binary exits with a clear error if no `.flux/` directory is found
- [ ] Windows and macOS packaging paths are both defined
- [ ] Missing git degrades gracefully with a clear message, not a crash
- [ ] Update check runs on startup and reports newer versions without blocking

## Likely Affected Areas

- `engine/src/index.ts` — static serving, workspace resolution, browser auto-open
- `portal/src/api.ts` — relative API URL for packaged mode
- `portal/vite.config.ts` — build output configuration
- `package.json` (root) — build and package scripts
- `engine/package.json` — build script, packaging tool dependency
- New: `scripts/package.js` or packaging tool config
- `README.md` — installation and usage docs for packaged binary

## Dependencies

- Should be done after core product flows are stable enough to package
- Portal must build for production cleanly (`npm run build -w portal`)
- Engine TypeScript must compile cleanly

## Notes

- **Packaging tool choice:** `pkg` by Vercel is the most proven option for bundling Node.js + native deps into a single binary. Node.js SEA is newer but may struggle with native modules like chokidar's fsevents on macOS. Recommend starting with `pkg` and evaluating SEA if `pkg` becomes unmaintained.
- **Portal embedding:** The simplest first approach is shipping `portal/dist/` as a sibling directory to the binary. Embedding assets inside the binary is possible with `pkg` but adds complexity — defer to a follow-up.
- **Port conflicts:** Consider adding a `--port` flag so users can change from the default 3001 if it conflicts with another service.
- macOS packaging may need a CI or platform-specific build path even if Windows is validated locally first.
- System tray, auto-start, and native notifications are explicitly out of scope for this ticket.
