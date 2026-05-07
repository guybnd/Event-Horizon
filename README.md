# 🌌 Event Horizon

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: MVP](https://img.shields.io/badge/Status-MVP-blue.svg)]()

> A local-first, agent-centric management layer designed to serve as the central nervous system for solo developers and teams building alongside AI and LLM coding agents.

Event Horizon replaces traditional cloud-based ticketing with a high-performance, **filesystem-based integration pool**. By storing all state in the repository, you clone the entire management system right along with your code.

---

## ✨ Core Principles

* **🗂️ Filesystem as Database:** All state lives locally in the repository. Version control your management system just like your source code.
* **🤖 Agent-First & Human-Friendly:** Data structures (Markdown + YAML Frontmatter) are instantly parseable by LLMs while remaining effortlessly editable in tools like Obsidian or VS Code.
* **⚡ Zero Latency:** No cloud APIs. The UI reacts at the exact speed of your local disk.
* **📐 Schema Flexibility:** You dictate the structure and schema of your project via standard Markdown.

---

## 🏗️ Architecture

The project is split into three main areas:

* **Engine (`/engine`):** A local Node.js/TypeScript backend that watches files, manages state, and exposes a flexible local REST API. *(Future: Model Context Protocol (MCP) server support).*
* **Portal (`/portal`):** A lightning-fast, reactive Web UI built with **Vite, React, and Tailwind CSS v4**.
* **Data Layer (`.flux/`):** A directory inside the root repository acting as the persistent store containing ticket files.

---

## 🚀 Getting Started

To run the full stack during development, you will need two terminal windows:

### 1. Start the Backend Engine
```bash
cd engine
npm install
npm run dev
```
> The Engine runs locally on `http://localhost:3001`

### 2. Start the Frontend Portal
```bash
cd portal
npm install
npm run dev
```
> The Portal UI runs locally on `http://localhost:5173`

---

## 📚 Project Documentation

Event Horizon ships with a repo-backed documentation tree under `.docs/` which is natively served through the Portal's interactive **Docs screen**. Core materials include:

* 🧭 **[project-overview](.docs/project-overview.md):** High-level system shape and shipped capabilities.
* 🔩 **[architecture/overview](.docs/architecture/overview.md):** Runtime logic and storage models.
* 📝 **[architecture/docs-workspace](.docs/architecture/docs-workspace.md):** How the docs tree, live editor, and permissions function.
* 🗺️ **[architecture/repository-map](.docs/architecture/repository-map.md):** Visual map to key codebase surfaces.
* 🔄 **[workflow/ticket-lifecycle](.docs/workflow/ticket-lifecycle.md):** Status model and rigid agent execution rules.
* 🔌 **[workflow/workflow-install](.docs/workflow/workflow-install.md):** Installation of skills and always-on instructions.

> **Note for Contributors & Agents:** When shipped behavior changes, update the nearest durable `.docs/` markdown page instead of leaving context buried in a ticket's history.

---

## 🤖 Agent Workflow & Instructions

Event Horizon provides powerful Copilot-facing assets explicitly tailored for agentic capabilities:

1. **Workspace Skill:** `.flux/skills/event-horizon-agent.md`
2. **Copilot Instructions:** `.flux/skills/event-horizon-copilot-instructions.md`

### Installing the Workflows
Installing the workflow patches these templates directly into the target `.github/` directory natively supported by GitHub Copilot (`.github/skills/event-horizon/SKILL.md` & `.github/copilot-instructions.md`).

You can install or refresh the workflow in two ways:
* **Via Portal:** Navigate to the **Settings** screen in the Portal and click `Install Workflow`.
* **Via CLI:** Run `npm.cmd run install-skill -- --target c:\GitHub\EventHorizon --framework copilot`.

*(The installer makes sure to only patch designated Event Horizon instruction blocks, preserving your unrelated custom instructions).*

### Lifecycle & Prompts
* **Workflow Status Prompts:** Configured statuses (defaulting to `Require Input` and `Ready`) trigger prompts.
  * Moving a ticket to `Require Input` initiates an agent-to-human question flow.
  * Moving a ticket to `Ready` signifies a review checkpoint before final merge.
  * *Handoff:* Upon review approval, run `finish <ticket>` to automatically commit files and close the task out to `Done`.
* **Grooming:** Agents operating on a ticket in `Grooming` should **not** begin raw implementation. They must instead refine the task description, flesh out required metadata (`tags`, `effort`, `priority`), and ask blocking questions via the `Require Input` lane first.

---

## 📝 The Data Schema (MVP)

Tickets are stored natively as `.md` files within the `.flux/` directory using simple metadata.

**Example `TEST-1.md`:**
```yaml
---
id: TEST-1
status: Todo
assignee: unassigned
tags: [setup, mvp]
---

# Initial Setup Task
Body of the task goes here.
```
