## Event Horizon Workflow

This repository uses the Event Horizon ticket system. Tickets are markdown files stored in `.flux/`.

- **Ticket Work:** When working on a ticket (e.g., `FLUX-41`) or before starting any task that modifies repository files, you **MUST** read the Event Horizon Orchestrator skill.
- The orchestrator skill provides critical rules for ticket resolution, metadata formatting, and workflows. Find it in your agent's rule location (e.g., `.github/skills/event-horizon/SKILL.md`, `.gemini/skills/event-horizon.md`, `.cursor/rules/event-horizon.mdc`, `.claude/rules/event-horizon.md`, `.codex/skills/event-horizon.md`, or `.grok/skills/event-horizon/SKILL.md`). If none of those files exist, call the Event Horizon MCP tool `read_skill` with `module: "orchestrator"`.
- Pure explanation, brainstorming, or read-only discussion does not require reading the skill or modifying tickets.