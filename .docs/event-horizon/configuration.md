---
title: Configuration Reference
order: 3
---

# Configuration Reference

Event Horizon relies on three separate configuration layers. This document explains where they live and what they control.

## 1. `event-horizon.config.json` (Engine Configuration)

This file sits directly next to your `event-horizon` binary or inside your source root if you're running via the CLI. It controls the core server settings.

| Field | Type | Description |
|-------|------|-------------|
| `port` | `number` | The local port the API and portal are served on (default: `3001`). |

*Note: Changes to this file require restarting the Event Horizon engine.*

## 2. `.flux/config.json` (Project Configuration)

This is your primary workspace configuration file. It is tracked in your repository and shared with your team. It defines the structure of your workflow, board, and metadata.

| Field | Type | Description |
|-------|------|-------------|
| `projects` | `string[]` | Project key prefixes for ticket IDs (e.g. `["WEB", "API"]`). |
| `columns` | `{ name, color? }[]` | The vertical columns displayed on the Kanban board view. |
| `hiddenStatuses` | `{ name, color? }[]` | Ticket statuses that are tracked but hidden from the main board. |
| `users` | `{ name }[]` | List of known team members or agents, shown in assignee dropdowns. |
| `tags` | `{ name, color? }[]` | Preset tag definitions with optional display colors. |
| `priorities` | `{ name, icon, color }[]` | Priority levels with associated Lucide icon names and text colors. |
| `enableBacklogScreen` | `boolean` | Toggles the visibility of the Backlog navigation item. |
| `requireInputStatus` | `string` | The exact status name agents use when they need clarification (default: `"Require Input"`). |
| `readyForMergeStatus` | `string` | The status name indicating a ticket is awaiting user review before merging (default: `"Ready"`). |
| `boardCardOpenMode` | `"full" \| "preview"` | Controls whether clicking a board card opens the full modal or the side preview. |
| `animationsEnabled` | `boolean` | Toggles micro-animations on the board interface. |
| `docsRoot` | `string` | The directory relative to the workspace root where documentation is stored (default: `.docs`). |

## 3. `~/.event-horizon/settings.json` (Global User Settings)

This file is automatically managed by the system tray and portal. It is stored globally in your OS user directory and persists your application preferences across restarts.

| Field | Type | Description |
|-------|------|-------------|
| `lastWorkspace` | `string` | The absolute path to the last opened project directory. |

*You generally do not need to edit this file manually. Use the Workspace tab in Settings to change directories.*
