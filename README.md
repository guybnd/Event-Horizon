# Event Horizon

Event Horizon is a local-first, agent-centric management layer that replaces traditional cloud-based ticketing with a high-performance, filesystem-based integration pool. It is designed to be the "central nervous system" for solo developers and small teams working with AI coding agents.

## Core Principles
- **Filesystem as Database:** All state lives in the repository. If you clone the repo, you clone the entire management system.
- **Agent-First & Human-Friendly:** Data structures are instantly parseable by LLMs while remaining easily editable in tools like Obsidian or VS Code.
- **Zero Latency:** No cloud APIs. The UI reacts at the speed of the local disk.
- **Schema Flexibility:** You dictate the schema to the project using standard Markdown files with YAML Frontmatter.

## Architecture
- **Engine (Backend):** A local Node.js/TypeScript server managing file watching and providing the local REST API (and eventually the MCP server).
- **Portal (Frontend):** A reactive, customizable Web UI built with Vite, React, and Tailwind CSS v4.
- **Data Layer:** A `.flux/` directory containing ticket files.

## Getting Started

To run the full stack during development, you will need two terminal windows:

**1. Start the Backend Engine**
```bash
cd engine
npm run dev
```
*(The Engine runs on `http://localhost:3001`)*

**2. Start the Frontend Portal**
```bash
cd portal
npm run dev
```
*(The Portal UI runs on `http://localhost:5173`)*

## The Data Schema (MVP)
Tickets are stored as `.md` files inside the `.flux/` directory.

Example `TEST-1.md`:
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
