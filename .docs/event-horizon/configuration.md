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
| `port` | `number` | The local port the API and portal are served on (default: `3067`). |

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
| `defaultAgent` | `string` | Which agent framework to use by default when launching sessions from the portal. Options: `claude`, `gemini`, `copilot`. |
| `worktreeByDefault` | `boolean` | Default state of the **portal/human** "dedicated worktree" choice on `POST /:id/branch` (default `false`). When on, the human "Start task" path also creates a git worktree so the agent runs isolated from `master` (FLUX-516). **Note (FLUX-741):** the **agent** `branch` (`action:'create'`) MCP tool no longer reads this — agent branch sessions are worktree-isolated **by default** regardless of this setting (pass `worktree: false` to opt a single agent session out into the shared main tree). This flag now governs only the human-manual portal path. A per-launch `worktree` param overrides it on either path. |
| `effortLevel` | `string` | Global effort level for agent sessions. Options: `low`, `medium`, `high`, `xhigh`, `max`. Can be overridden per-ticket or per-session. |
| `permissions` | `object` | Default permission mode per session surface — the workspace "risk tolerance" (FLUX-605, see below). |
| `integrations` | `object` | Per-framework agent configuration (see below). |

### Permission Risk Tolerance

The `permissions` object sets the default permission mode for each session surface. `gated` routes destructive ops (`change_status`, `branch` with `action:'delete'`, `finish_ticket`, `archive`, `Bash`) through a human **Allow/Deny** prompt via Claude Code's `--permission-prompt-tool`; `skip` runs ungated (`--dangerously-skip-permissions`). Configured in **Settings → Agent Integration → Permission Risk Tolerance**. The per-chat **Perms** picker overrides per turn; leaving it on *Default* inherits these values.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `permissions.boardDefault` | `"gated" \| "skip"` | `gated` | Default mode for orchestrator/board sessions (they have triage teeth and a human present to approve). |
| `permissions.ticketDefault` | `"gated" \| "skip"` | `skip` | Default mode for per-ticket chat sessions. |

> Delegated/headless sessions (combiner, relay) cannot block on a human and always run ungated, regardless of this setting.

### Integration Settings

The `integrations` object configures model selection for each supported AI framework. Each has two fields:

| Field | Type | Description |
|-------|------|-------------|
| `integrations.claudeCode.groomingModel` | `string` | Model used for grooming tasks (e.g. `claude-sonnet-4`). Empty string uses the CLI default. |
| `integrations.claudeCode.implementationModel` | `string` | Model used for implementation tasks. |
| `integrations.geminiCli.groomingModel` | `string` | Model used for grooming tasks (e.g. `gemini-2.5-pro`). |
| `integrations.geminiCli.implementationModel` | `string` | Model used for implementation tasks. |
| `integrations.copilotCli.groomingModel` | `string` | Model used for grooming tasks. |
| `integrations.copilotCli.implementationModel` | `string` | Model used for implementation tasks. |

Example:

```json
{
  "defaultAgent": "claude",
  "effortLevel": "high",
  "integrations": {
    "claudeCode": {
      "groomingModel": "claude-sonnet-4",
      "implementationModel": "claude-sonnet-4"
    },
    "geminiCli": {
      "groomingModel": "",
      "implementationModel": ""
    },
    "copilotCli": {
      "groomingModel": "",
      "implementationModel": ""
    }
  }
}
```

## 3. `~/.event-horizon/settings.json` (Global User Settings)

This file is automatically managed by the system tray and portal. It is stored globally in your OS user directory and persists your application preferences across restarts.

| Field | Type | Description |
|-------|------|-------------|
| `lastWorkspace` | `string` | The absolute path to the last opened project directory. |

*You generally do not need to edit this file manually. Use the Workspace tab in Settings to change directories.*
