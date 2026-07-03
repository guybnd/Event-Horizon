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
      "implementationModel": "claude-sonnet-4",
      "delegateModel": ""
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

#### Delegated-subagent model (FLUX-482)

`claudeCode.delegateModel` (default empty) is the model for **delegated** subagents spawned via [`delegate_to_agent` / `delegate_parallel`](reference/mcp-tools.md#delegate_to_agent) — previously a delegate silently inherited the parent ticket's status-derived model (often the strong implementation model) even for cheap search/review work. The delegate's model is now resolved with this precedence:

1. **per-call `model`** param on the delegate tool (highest) — override one delegate ad hoc,
2. **`persona.model`** — built-in personas carry a cheaper tier (`sonnet`) on search / grooming / doc-sync / review-reading roles, and **no** override on code-writing roles (`implementer`, `test-engineer`, `dev-lead`, `finalizer`) so those keep the strong model,
3. **`delegateModel`** above — a global default for all un-overridden delegates,
4. the existing **status-derived** grooming/implementation model.

Leave `delegateModel` empty for unchanged behavior (only the deliberately-cheapened personas drop to the lower tier).

> **Claude-framework only (for now).** This whole override is honored only when the board runs on the Claude framework. The resolved model is threaded onto `session.model`, which only the Claude adapter reads; the Gemini and Copilot adapters use their own `groomingModel`/`implementationModel` and ignore it (and `sonnet` is a Claude alias). The delegate route gates the resolution to `framework === 'claude'`, so on Gemini/Copilot boards `delegateModel`, `persona.model`, and the per-call `model` param are all inert. Hence this key lives under `claudeCode`; teaching the other adapters a `cheap`/`strong` tier is tracked in FLUX-931.

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

## Multi-Agent Sessions

Event Horizon supports running multiple agent sessions concurrently against the same ticket. This enables parallel code review with different reviewer personas and orchestrated multi-agent workflows.

### Session Roles & Patterns

Each session can be tagged with coordination metadata:

| Field | Purpose |
|-------|---------|
| `role` | Identifies the session's function (e.g. `reviewer:senior-dev`, `implementer`) |
| `pattern` | Orchestration pattern: `relay`, `scatter-gather`, or `supervisor` |
| `patternPosition` | Position within pattern: `lead`, `assistant`, `combiner`, `step`, `standalone` |
| `lockedPaths` | File paths this session intends to write (engine rejects conflicts) |

### Phase-Aware Single / Multi Launch

Every non-Ready card exposes a **split button**: the primary action advances the ticket (status action) or, where there's no status action, launches the phase's default single agent in one click; a caret opens a menu listing the phase's **Single** default, **Multi** default, and any other templates configured for that phase (each labelled by template name). The "Ready" column has its own **Review** split button (primary = default single reviewer, caret = Single/Multi/templates) alongside the unchanged **Return** and **Finish** buttons.

The card maps the ticket's board status to a launch phase (`grooming`, `implementation`, `review`, `finalize`). Defaults resolve through `config.phaseDefaults[phase].single` / `.multi` (falling back to `builtin-<phase>-<variant>`). A **single** selection always launches **standalone**: the launcher hides the orchestration pattern selector and runs the agent via `runAgentAction({ action: { kind: 'persona', … } })`, bypassing the pattern gating that blocks `serialized`/`handoff`. Selecting **two or more** participants launches an orchestrated team via `launchOrchestration(...)` with the phase's combiner as lead. Inside the launcher a **Template** dropdown lists every built-in and custom template that defines a config for the current phase — switching it re-applies that template's pattern and personas, while any manual edit drops the selection back to "Custom".

The **Workflows → Templates** screen groups templates by phase, splitting each phase into Single and Multi columns (by persona count). A star on each card sets that template as the phase's single or multi default; cards surface the resolved pattern and ordered persona chips.

### Parallel Code Review

From both the "Ready" status prompt (modal) and the card quick-action bar, the **Single** / **Multi** controls open a multi-select persona picker. Select one persona for a single reviewer, or select multiple for parallel reviews.

**With Orchestrator (default for 2+ reviewers):**
An orchestrator agent launches alongside the reviewers. Reviewers only post structured comments (they cannot change ticket status). The orchestrator waits for all reviews, synthesizes findings, and decides:
- All approved → moves ticket to `Ready`
- Any flagged changes → moves ticket to `In Progress` with consolidated action items

**Without Orchestrator (checkbox unchecked):**
Reviewers launch independently but are status-restricted — they can only post comments. The ticket stays in `In Progress` and the user reads comments manually.

**Single reviewer:**
Existing behavior preserved — a single reviewer has full access (including status changes).

### Status Restriction (Engine-Enforced)

When a ticket has 2+ active scatter-gather sessions, the `change_status` MCP tool rejects calls unless the caller identifies as `callerRole: 'orchestrator'` or `'lead'`. This prevents individual reviewers from moving the ticket while peers are still reviewing.

Each reviewer session:
1. Reads the ticket description and history via MCP tools
2. Inspects the diff via git commands
3. Posts a structured comment via `add_note` (`type: 'comment'`, starts with **APPROVED** or **CHANGES NEEDED**)
4. Exits — does NOT change status

Multiple reviewers run simultaneously — each as an independent session tagged with `role: 'reviewer:<persona-id>'`.

### Built-In Persona Roster

Personas are organized by phase. Built-ins are code-defined (viewable, forkable, updated via releases); custom personas live under `<fluxDir>/personas/*.json`.

| Phase | Persona | Focus |
|-------|---------|-------|
| Grooming | Context Scout | Repo recon — maps the affected surface and prior art |
| Grooming | Requirements Interrogator | Surfaces ambiguity, writes acceptance criteria |
| Grooming | Planner | Combiner — synthesizes scout + interrogator into a plan |
| Implementation | Test Engineer | TDD — writes failing tests first, no implementation |
| Implementation | Implementer | Builds to satisfy the test conditions without weakening them |
| Review | Senior Friendly Dev | Broad single-reviewer pass with severity tags |
| Review | QA Correctness | Behavior vs. acceptance criteria |
| Review | Security Auditor | OWASP Top 10 and injection surfaces |
| Review | Angry Linus | Brutally honest — zero tolerance for bad patterns |
| Review | Architect Genius | System design, separation of concerns, scalability |
| Review | Performance Expert | Complexity, hot paths, bundle size, re-renders |
| Review | UX/UI Expert | Usability, accessibility, interaction design |
| Finalize | Finalizer | End-to-end ticket finalize: docs check, commit, ticket tidy, merge PR |
| Finalize | Docs Auditor | Verifies .docs and README reflect the shipped changes; fixes drift |
| Finalize | Committer | Stages the work and creates one clean, well-described commit |
| Finalize | Ticket Curator | Tidies the ticket title and posts a clear resolution comment |
| Finalize | PR Merger | Closes and merges the ticket PR when one exists |

The internal **Orchestrator** and **Supervisor** personas are not user-selectable; they are added automatically when the pattern requires a combiner (orchestrator) or lead (supervisor). The phase-specific combiner (`planner` for grooming, `orchestrator` for other phases) is attached when a multi-agent scatter run has 2+ workers.

### Conflict Prevention

The session store enforces file-lock conventions: if a session declares `lockedPaths`, no other session can start with overlapping paths. Reviewer sessions declare no locks (read-only), so multiple reviewers never conflict.

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
