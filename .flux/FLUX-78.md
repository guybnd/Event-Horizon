---
title: Add production build and packaging pipeline
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - mvp
priority: High
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:55:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T06:55:00.000Z'
    comment: >-
      Split from FLUX-18. Covers the build scripts and binary packaging. Depends
      on FLUX-77 (static serving) being in place so the build output is
      meaningful.
    id: c-2026-05-07t06-55-00-000z-flux-78
order: 78
---
## Summary

Add root-level build and package scripts that produce a distributable artifact:
compiled engine + pre-built portal static assets, optionally bundled into a
standalone binary that runs without Node.js.

## Requirements

### 1. Build scripts
- `npm run build` at root should:
  - Build the portal for production (`vite build` → `portal/dist/`)
  - Compile the engine TypeScript (`tsc` → `engine/dist/` or equivalent)
- Both builds must complete cleanly without errors

### 2. Package scripts
- `npm run package` should:
  - Run the build step first
  - Bundle the compiled engine + `portal/dist/` into a standalone binary
  - Use `pkg`, `nexe`, or Node.js SEA (Single Executable Applications)
- `npm run package:win` / `npm run package:mac` for platform-specific targets
- Output: `event-horizon.exe` (Windows) and `event-horizon` (macOS)

### 3. Binary requirements
- The binary must embed all engine dependencies (express, chokidar, gray-matter, etc.)
- The binary must find `portal/dist/` at a predictable relative path (sibling directory to binary for v1)
- The binary must launch without Node.js, npm, or VS Code installed

### 4. Packaging config
- Config should live in root `package.json` or a dedicated `scripts/package.js`
- Document the chosen packaging tool and any platform-specific notes

## Acceptance Criteria

- [ ] `npm run build` produces a production portal bundle and compiled engine
- [ ] `npm run package` creates a standalone binary for the current platform
- [ ] The binary launches without Node.js installed
- [ ] Windows and macOS packaging paths are both defined
- [ ] The binary serves API + portal from a single process

## Likely Affected Areas

- `package.json` (root) — new build and package scripts
- `engine/package.json` — build script, packaging tool dependency
- `engine/tsconfig.json` — production compilation settings
- New: `scripts/package.js` or packaging tool config

## Parent

- Subtask of FLUX-18

## Dependencies

- Requires FLUX-77 (static serving) to be complete
