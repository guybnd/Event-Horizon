---
id: FLUX-324
title: 'Global app settings: dedicated install location with first-boot config'
status: Grooming
priority: Medium
effort: M
assignee: unassigned
tags:
  - feature
  - engine
  - settings
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-26T00:43:01.140Z'
    comment: Created ticket.
---
## Problem / Motivation

Currently `~/.event-horizon/settings.json` is a hardcoded path that stores the workspace list and last-active pointer. User preferences (theme, default username, preferred CLI framework) are scattered across localStorage, hardcoded defaults, and per-project config. There's no formal "install" concept — the directory just appears on first use with no user awareness or control.

For a multi-project tool that lives permanently on a user's machine, we need:
- A well-defined, platform-appropriate global data directory
- User-level preferences that persist across projects
- First-boot configuration that lets the user choose or confirm the storage location
- Future version upgrades should be able to locate the existing data directory without re-setup

## Open Questions

1. **Storage location strategy** — use platform conventions (`%APPDATA%/EventHorizon` on Windows, `~/Library/Application Support/EventHorizon` on Mac, `~/.config/event-horizon` on Linux) vs current `~/.event-horizon`? Platform-native is more "proper" but `~/.event-horizon` is simpler and cross-platform consistent.

2. **First-boot flow** — should the app show a one-time dialog letting the user confirm/change the data directory? Or just default to the platform path and surface it in Settings?

3. **Discovery on upgrade** — if the location is configurable, how do future versions find it? Options: always check a known sentinel path first (e.g. `~/.event-horizon-pointer`), or rely on the binary being co-located with a config file (current `event-horizon.config.json` next to the exe).

4. **What belongs in global settings** — proposed: `workspaces[]`, `lastWorkspace`, `theme`, `defaultUser`, `preferredFramework`, `port`, `dataDir` (self-referential for migration). Anything else?

5. **Migration** — need to migrate existing `~/.event-horizon/settings.json` users seamlessly on first boot of the new version.
