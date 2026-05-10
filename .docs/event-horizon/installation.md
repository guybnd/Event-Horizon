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
3. **`~/.event-horizon/settings.json`**: Global user settings. Remembers your last opened workspace so you don't have to select it every time you start the app.

*See the [Configuration Guide](configuration) for a full reference.*

---

## Install the Agent Workflow Skill

To enable your AI agents (like GitHub Copilot, Cline, or Antigravity) to manage the grooming, implementation, and commit flows, you must install the workflow skills. The Event Horizon binary embeds these files, so no internet access is required.

1. Open **Settings** in the portal header.
2. Go to the **Agent Integration** tab.
3. Select your AI framework (e.g., Copilot, Antigravity) from the dropdown.
4. Click **Install Agent Workflow**.

This step automatically copies the necessary `.md` skill files into your project's agent folder (e.g. `.gemini/` or `.github/`) and patches your project instructions.

---

## Switching Projects

Event Horizon operates on an IDE workspace model:

1. Open **Settings** in the portal header.
2. Go to the **Workspace** tab.
3. Browse to or enter the path of the new project folder.
4. The portal will immediately switch context to the new workspace. This choice is remembered across restarts.

---

## Quitting

Event Horizon runs as a background process to continuously monitor your ticket files. Closing the browser does **not** stop the engine.

To stop the service completely:
- Find the Event Horizon icon in your system tray (Windows) or menu bar (macOS).
- Right-click and select **Quit**.
- Alternatively, you can click the Power icon in the portal header.

---

## Related Docs

- [Configuration Reference](configuration)
- [Project Overview](project-overview)
- [Architecture Overview](architecture/overview)
- [Ticket Lifecycle](workflow/ticket-lifecycle)
