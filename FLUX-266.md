---
id: FLUX-266
title: GitHub release Windows exe does not launch
status: Grooming
priority: High
assignee: unassigned
tags:
  - bug
effort: M
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-14T11:27:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-14T11:27:00.000Z'
    comment: >-
      The locally compiled Windows build (npm run package:win on Windows) works
      fine — server starts, tray icon appears, browser opens. But the Windows
      exe downloaded from GitHub Releases (cross-compiled on macOS via the
      release workflow) does nothing when double-clicked. Need to investigate
      why the cross-compiled binary fails silently.
    id: c-2026-05-14t11-27-00-000z
---

## Problem / Motivation

The GitHub Actions release workflow (`release.yml`) runs on `macos-latest` and cross-compiles the Windows exe using `@yao-pkg/pkg` with target `node22-win-x64`. The resulting exe is PE-patched to GUI subsystem and zipped into the release artifacts.

When a user downloads the release zip, extracts the exe, and runs it on Windows, nothing happens — no server, no tray icon, no browser. The locally compiled exe (built natively on Windows) works correctly.

## Investigation areas

- Cross-compilation differences between macOS-built and Windows-built pkg binaries
- Embedded asset resolution (portal dist, traybin, skill docs) in cross-compiled snapshot
- PE patch correctness on cross-compiled binary
- Windows SmartScreen / Mark of the Web blocking
- Missing runtime dependencies in cross-compiled binary
