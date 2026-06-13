---
title: Installation & Setup
order: 2
---

# Installation & Setup

This guide explains how to install Event Horizon, set up your project workspace, configure your environment, and integrate the agent workflow skills.

---

## Quick Start (Binary)

Event Horizon ships as a standalone binary with an embedded IDE-style workspace picker, a local server, and a system tray manager. No Node.js or `npm install` is required for end users.

1. **Download the Binary**: Get the latest `event-horizon` executable for your platform (Windows, macOS, or Linux).
2. **Run the App**: Double-click the executable.
3. **Connect**: Your default web browser will automatically open the Event Horizon portal (typically at `http://localhost:3067`).
4. **Select Workspace**: If it's your first time, the portal will prompt you to select a workspace. Click **Browse** and select your project folder, or type the path. If the folder hasn't been initialized, the portal will guide you through setting it up.

> **Windows users:** Windows Defender may flag `event-horizon-win-*.exe` as `Trojan:Script/Wacatac.C!ml`. This is a false positive — the binary is an unsigned [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html) and triggers AV heuristics because it's unsigned. See [Run from source](#run-from-source-windows) below for a workaround, or submit a false-positive report at [microsoft.com/wdsi/filesubmission](https://www.microsoft.com/en-us/wdsi/filesubmission).

---

## First Boot

On first launch, Event Horizon displays a one-time welcome dialog that:

- Shows the location of your global settings directory (platform-conventional path).
- Auto-migrates any existing `~/.event-horizon/settings.json` to the new location.
- Lets you confirm before proceeding to workspace selection.

After migration completes you won't see this dialog again.

---

## Initializing a New Project

To use Event Horizon in a new project, the folder must be initialized with a `.flux/` directory.

You can initialize a project directly from the Event Horizon portal when you browse to an empty folder. Alternatively, use the CLI:

```bash
event-horizon init --target /path/to/your-project --key MYAPP
```

*(Note: If you are using the npm package, use `npx event-horizon init` instead).*

This command creates:

- `.flux/config.json` — Board configuration and project settings.
- `.flux/assets/` — Image attachment storage.
- `.docs/project-overview.md` — Starter documentation page (if `.docs/` doesn't exist).

---

## Configuration Files

Event Horizon uses three main configuration files for different scopes:

1. **`event-horizon.config.json`**: Located next to the binary. Edit this to change the default port before the first launch.
2. **`.flux/config.json`**: Located in your project workspace. Contains board configuration (columns, tags, statuses).
3. **Global settings**: Platform-conventional location storing workspace list, theme, default user, preferred framework, port, and card click behavior:
   - Windows: `%APPDATA%/EventHorizon/settings.json`
   - macOS: `~/Library/Application Support/EventHorizon/settings.json`
   - Linux: `~/.config/event-horizon/settings.json`

*See the [Configuration Guide](configuration) for a full reference.*

---

## Install the Agent Workflow Skill

To enable your AI agents (Claude Code, Gemini CLI, or Copilot CLI) to manage the grooming, implementation, and commit flows, you must install the workflow skills. The Event Horizon binary embeds these files, so no internet access is required.

1. Open **Settings** in the portal header.
2. Go to the **Agent Integration** tab.
3. Select your AI framework (e.g., Copilot, Claude, Gemini, Cursor) from the dropdown.
4. Click **Install Agent Workflow**.

This step automatically copies the necessary `.md` skill files into your project's agent folder (e.g. `.github/`, `.claude/`, `.gemini/`) and patches your project instructions.

*See the [Agent Integrations](agent-integrations) guide for full setup details including prerequisites and authentication.*

---

## Switching Projects

Event Horizon supports multi-workspace switching without restarting:

- **Header dropdown:** Click the workspace name in the portal header to open a dropdown listing all configured workspaces. Select one to switch immediately.
- **Settings → Workspace tab:** Full workspace management — add new workspaces via the folder picker, remove, rename, or switch between them.
- **Auto-registration:** The current workspace is automatically added to the list on startup.
- **Session guard:** If agent sessions are active when you switch, a confirmation dialog shows how many are running and asks whether to stop them before proceeding. This prevents data confusion from agents writing to the wrong project.

The workspace list is persisted in the global settings file and remembered across restarts.

---

## Quitting

Event Horizon runs as a background process to continuously monitor your ticket files. Closing the browser does **not** stop the engine.

To stop the service completely:

- Find the Event Horizon icon in your system tray (Windows) or menu bar (macOS).
- Right-click and select **Quit**.
- Alternatively, you can click the Power icon in the portal header.

---

## Run from source (Windows)

If Windows Defender blocks the binary, the source distribution (`event-horizon-source.zip` on the [releases page](https://github.com/guybnd/event-horizon/releases)) lets you run directly from TypeScript with no AV friction. Requires Node.js 20+.

```bash
# 1. Extract event-horizon-source.zip, then from the extracted directory:
npm install

# 2. Build portal + engine
npm run build

# 3. Start the engine
node engine/dist/index.js --workspace /path/to/your/project
```

The engine serves the portal at `http://localhost:3067`. Set `PORT=<n>` to override the port.

---

## Related Docs

- [Agent Integrations](agent-integrations)
- [Configuration Reference](configuration)
- [Project Overview](project-overview)
- [Architecture Overview](architecture/overview)
- [Ticket Lifecycle](workflow/ticket-lifecycle)
