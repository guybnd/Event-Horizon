---
title: Local executable / packaged app
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - feature
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
order: 18
priority: Medium
effort: L
implementationLink: ''
---
## Summary

Package Event Horizon as a browser-based local app that ships without a Node.js
or npm prerequisite. The packaged runtime should start the engine, serve the
built portal, open the default browser, and behave like a downloadable desktop
binary rather than requiring an IDE-driven dev setup.

## Requirements

### 1. Bundle the runtime into one packaged app
- Build the portal for production and serve it from the packaged engine process
- Launch the local server from the packaged runtime and open the default browser automatically
- End users should not need Node.js, npm, or VS Code installed

### 2. Target Windows and macOS first
- The first supported packaged targets are Windows and macOS
- Downloadable release artifacts are sufficient for the first slice; installer wrappers can follow later
- Git can remain an external prerequisite for git-aware workflow features

### 3. Keep v1 browser-based
- The first version should run as a local executable that opens the portal in the browser
- Do not require an Electron or Tauri desktop shell for the initial implementation
- System tray controls, auto-start, and native notifications stay out of scope for this ticket

### 4. Provide lightweight update awareness
- The packaged app may check whether a newer GitHub release or repo version exists and prompt the user to update
- Automatic in-place updating is not required in the first version
- Update prompts should fail safely when network access is unavailable

### 5. Add a repeatable packaging pipeline
- `npm run build` should produce the production portal assets and engine bundle needed for packaging
- `npm run package` should create distributable artifacts for the initial supported targets
- The packaged runtime should resolve the working `.flux/` directory predictably or prompt for it when needed

## Acceptance Criteria

- [ ] A repeatable package command exists for creating a distributable runtime
- [ ] The packaged runtime launches without Node.js installed
- [ ] The packaged runtime serves the portal UI and API from the same local process
- [ ] Launching the packaged runtime opens the browser automatically
- [ ] Windows and macOS packaging paths are defined for the first release slice
- [ ] Git-aware features degrade clearly when Git is unavailable instead of failing silently

## Files to Create/Modify

- `engine/src/index.ts` or packaged entry module for serving built portal assets
- `package.json`
- `portal/` build output integration
- Packaging script or config such as `scripts/package.*` or a tool config file
- Release documentation in `README.md` if the packaging flow changes user setup

## Dependencies

- Should be done after core product flows are stable enough to package
- Depends on the portal being buildable for production

## Notes

- A `pkg`-style single-binary approach is acceptable for the first slice if it can serve the built portal assets from the same process
- macOS packaging may need a CI or platform-specific build path even if Windows is validated locally first

