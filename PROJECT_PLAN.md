# Event Horizon: The Agent-Native Task Integration Pool

## 1. Vision Statement
Event Horizon is a local-first, agent-centric management layer that replaces traditional cloud-based ticketing with a high-performance, filesystem-based integration pool. It is designed to be the "central nervous system" for solo developers and small teams working with AI coding agents, treating project management as a living part of the codebase.

## 2. Core Principles
- **Filesystem as Database:** All state lives in the repository.
- **Agent-First/Human-Friendly:** Data structures must be instantly parseable by LLMs while remaining editable in tools like Obsidian or VS Code.
- **Zero Latency:** No cloud APIs. The UI reacts at the speed of the local disk.
- **Schema Flexibility:** The project shouldn't dictate how you work; you dictate the schema to the project.

## 3. Architecture & Tech Stack
- **The Engine (Backend):** A local server (Node.js/TypeScript) that manages file watching, the MCP server, and the REST API.
- **The Portal (Frontend):** A reactive, customizable Web UI (Vite + React + Tailwind).
- **The Data Layer:** A `.flux/` directory containing ticket files (Markdown + YAML Frontmatter).
- **The Bridge:** A Model Context Protocol (MCP) server implementation for direct agent-to-tool communication.

## 4. Bootstrapping Roadmap
### Phase 1: The "Living File" (MVP)
- Define the `.flux` directory structure.
- Build the file watcher and basic JSON API.
- Create a simple React dashboard that displays `.md` files as cards.

### Phase 2: The Agent Bridge
- Implement the MCP server within the backend.
- Define the "Skill Set" for agents to "read" and "claim" tickets.
- Implement "File Locking" to prevent multiple agents from colliding on the same task.

### Phase 3: The Customizer
- Build the "UI Builder" within Event Horizon to allow users to toggle board columns and ticket fields without writing code.
- Add Git-hook integration to automatically commit ticket changes alongside code changes.
