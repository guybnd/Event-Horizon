---
title: Agent Integrations
order: 6
---

# Agent Integrations

Event Horizon integrates with three AI coding CLI frameworks. Each can be launched directly from a ticket card in the portal, with full session tracking, live progress streaming, and cost monitoring.

---

## Supported Frameworks

| Framework | Binary | Status | Install Command |
|-----------|--------|--------|-----------------|
| **Claude Code** | `claude` | Fully supported | `npm install -g @anthropic-ai/claude-code` |
| **Gemini CLI** | `gemini` | Fully supported | `npm install -g @google/gemini-cli` |
| **Copilot CLI** | `copilot` | Fully supported | `npm install -g @github/copilot` |

All three frameworks plug in through the same `AgentAdapter` interface. To add a fourth framework, or to understand exactly how the engine drives a CLI, see [[Agent Adapter Contract]].

---

## Prerequisites

### Claude Code

1. Install: `npm install -g @anthropic-ai/claude-code`
2. Authenticate: Run `claude` once to set up your Anthropic API key
3. Verify: `claude -p "say hello" --output-format stream-json` should produce JSON output

### Gemini CLI

1. Install: `npm install -g @google/gemini-cli`
2. Authenticate: Run `gemini` once to authenticate with Google
3. Verify: `gemini -p "say hello" --output-format stream-json` should produce JSON output

### Copilot CLI

1. Install: `npm install -g @github/copilot`
2. Authenticate: Ensure you're logged in via `gh auth login` (requires GitHub Copilot subscription)
3. Verify: `copilot -p "say hello" --output-format json` should produce JSONL output

---

## How Sessions Work

1. **Start**: Click the agent button on a ticket card, or use the command palette. The portal sends the ticket context as the initial prompt.
2. **Execute**: The agent runs autonomously — reading files, making edits, running commands. Live progress streams into the portal.
3. **Interact**: If the agent needs input, it moves the ticket to "Require Input". Answer from the portal comment box — your response is routed directly to the running session.
4. **Complete**: When done, the agent moves the ticket to "Ready" status. Token usage and cost are recorded.

### Session Features

- **Live activity streaming**: See what the agent is doing in real-time (reading, editing, running commands)
- **Progress history**: All agent actions are recorded in the ticket's activity timeline
- **Token tracking**: Input/output tokens and estimated cost per session
- **Multi-turn**: Send follow-up messages to a running session via the portal comment box
- **Resume**: Copilot sessions support `--resume` for continuing previous conversations

---

## Configuration

### Default Agent

Set in `.flux/config.json`:

```json
{
  "defaultAgent": "claude"
}
```

Options: `claude`, `gemini`, `copilot`

### Effort Levels

Control how much work the agent puts into each task:

| Level | Description |
|-------|-------------|
| `low` | Quick, minimal changes |
| `medium` | Balanced (default for most CLIs) |
| `high` | Thorough, considers edge cases |
| `xhigh` | Very thorough, extensive testing |
| `max` | Maximum effort, full investigation |

Set globally in config, per-ticket in frontmatter (`effortLevel: high`), or per-session when starting.

### Model Selection

Each framework supports separate models for grooming vs implementation:

```json
{
  "integrations": {
    "claudeCode": {
      "groomingModel": "claude-haiku-4",
      "implementationModel": "claude-sonnet-4"
    },
    "geminiCli": {
      "groomingModel": "gemini-2.5-flash",
      "implementationModel": "gemini-2.5-pro"
    },
    "copilotCli": {
      "groomingModel": "",
      "implementationModel": ""
    }
  }
}
```

Leave empty to use the CLI's default model.

---

## Workflow Skill Installation

Each framework needs workflow skills installed so the agent understands Event Horizon's ticket lifecycle. Install from:

- **Portal**: Settings → Install Agent Workflow → Select framework
- **CLI**: `npx event-horizon install-skill --target /path/to/project --framework <target>`

### Install Targets

| Target | Files Installed |
|--------|----------------|
| `copilot` | `.github/skills/event-horizon/*.md` + patches `.github/copilot-instructions.md` |
| `claude` | `.claude/rules/event-horizon.md` |
| `gemini` | `.gemini/skills/event-horizon.md` |
| `cursor` | `.cursor/rules/event-horizon.mdc` |
| `windsurf` | `.windsurf/rules/event-horizon.md` |
| `generic` | `.ai/skills/event-horizon.md` |
| `auto` | Detects framework from project structure |

The installer patches only Event Horizon blocks — your other custom instructions remain untouched.

---

## Troubleshooting

### "Binary not found" error

The CLI binary must be on your system PATH. Verify with:

- Windows: `where claude` / `where gemini` / `where copilot`
- macOS/Linux: `which claude` / `which gemini` / `which copilot`

### Copilot: "path with spaces" errors on Windows

Event Horizon handles this internally by spawning `node` directly with the Copilot JS entry point, bypassing `.cmd` wrappers that break on paths with spaces. If you still see issues, ensure Node.js is on your PATH.

### Session starts but produces no output

- Check the CLI is authenticated (run it manually first)
- Check the engine logs for stderr output from the child process
- Ensure your API key / subscription is active

### Cost tracking shows $0

- Claude: Reports exact tokens — cost should populate automatically
- Gemini: Reports exact tokens — cost should populate automatically  
- Copilot: Does not currently report token counts in JSON output; cost tracking is limited

---

## Related Docs

- [Configuration Reference](configuration)
- [Model Pricing](model-pricing)
- [Ticket Lifecycle](workflow/ticket-lifecycle)
- [Workflow Install](workflow/workflow-install)
