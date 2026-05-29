---
title: Tray icon blank in system tray on Windows
status: Grooming
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - bug
  - distribution
  - ux
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Bug reported during FLUX-124 testing. The system tray icon is blank/empty
      on Windows despite the Go tray binary receiving a valid menu JSON payload
      with a base64-encoded PNG icon. Right-click menu works, but no icon is
      displayed. Multiple PNG formats were attempted (16x16 RGB, 32x32 RGBA,
      hardcoded known-good base64 from systray test suite) — all result in a
      blank tray icon. The tray binary receives the ready handshake and menu
      JSON correctly. Investigation needed into whether the systray Go binary
      requires a specific PNG format, size, or encoding that differs from what
      is currently sent.
    id: c-flux129-created
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-10T14:39:22.564Z'
  - type: agent_session
    sessionId: 90d4e81b-fdb3-4ef2-ba14-52f233643cdc
    startedAt: '2026-05-29T02:24:33.727Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-29T02:24:33.727Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-29T02:24:44.955Z'
order: 0
id: FLUX-129
---

## Problem / Motivation

The system tray icon introduced in FLUX-124 displays as blank (empty) in the Windows system tray. The tray binary starts correctly, the right-click menu appears and works, but no icon is shown. This gives a poor UX — the tray entry is invisible unless the user knows to look for a blank space.

## What Was Tried

- 16×16 solid-colour RGB PNG (color type 2) — blank
- 32×32 RGBA PNG (color type 6) — blank
- Hardcoded base64 PNG from `node_modules/systray/test/menu.json` (2984 chars, confirmed valid) — blank

## Investigation Needed

1. Check whether the `systray` Go binary on Windows expects a specific PNG dimensions, bit depth, or has a size limit.
2. Try calling the `systray` JS module directly (`import Systray from 'systray'`) rather than spawning the binary and implementing the protocol manually — the JS wrapper may handle encoding differences.
3. Check if the issue is specific to the PE-patched binary (GUI subsystem) vs a console build.
4. Try a `.ico` file path reference (Windows may prefer ICO for tray icons through the Go binary).
