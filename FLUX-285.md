---
title: Define agent system prompts for all 13 mapped roles
status: Todo
priority: High
effort: L
assignee: unassigned
tags:
  - feature
  - multi-agent
createdBy: Agent
updatedBy: Guy
history:
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Auto-created from inline subtask of FLUX-281.
  - type: activity
    user: Agent
    date: '2026-05-25T11:45:04.894Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Updated ticket body with research findings from FLUX-282. Added: exact
      system prompt injection syntax per CLI, tool gating matrix per role type,
      output format contracts for chaining (JSON schemas), context isolation
      guarantees. Each of the 13 roles now has defined output schema and tool
      restrictions per CLI. Hand-off contracts documented for pipeline
      composition.
    date: '2026-05-25T11:45:17.839Z'
    id: c-2026-05-25t11-45-17-839z
  - type: activity
    user: Agent
    date: '2026-05-25T11:49:14.320Z'
    comment: Updated description.
order: 2
---

Subtask of FLUX-281.

## Problem / Motivation

Each agent role needs a system prompt template that defines its identity, allowed actions, context boundaries, and output format contract. Research (FLUX-282) established exactly how to inject these prompts and enforce tool boundaries per CLI.

**Design principle: Claude-first.** Role templates are authored primarily for Claude Code invocation (`--append-system-prompt-file` + `--allowedTools`). Gemini/Copilot equivalents are generated from the same source template but are secondary — the Claude invocation path must work perfectly; the others are best-effort.

## Research Findings Informing This Ticket

**Claude Code (primary — all roles supported):**
- `--append-system-prompt-file ./role.txt` — recommended injection method (additive to base)
- `--allowedTools "Read,Glob,Grep"` — enforced tool boundary per invocation
- `--permission-mode plan` — read-only mode for reviewer roles
- `--output-format json` — structured output for inter-role chaining
- No turn/timeout limits — runs until done (bounded externally by orchestrator if needed)
- Supports Supervisor pattern — can spawn subagents and receive results

**Gemini CLI (supported, with constraints):**
- `.gemini/agents/*.md` with frontmatter: `name`, `tools`, `model`, `temperature`, `max_turns`, `timeout_mins`
- Has unique execution bounds (`max_turns: 10`, `timeout_mins: 5`) — useful for limiting scope
- Cannot recurse (subagents can't invoke other subagents) — cannot be Supervisor lead
- `--no-ask-user` implicit in headless — all roles are non-blocking

**Copilot CLI (supported):**
- `.github/instructions/<role>.instructions.md` with `applyTo` frontmatter
- `--allow-tool` / `--deny-tool` per invocation
- `--mode autopilot` + `--max-autopilot-continues 10` for bounded execution
- `--no-ask-user` prevents blocking in headless mode

## Implementation Plan

### Template Format

Each role stored in `.flux/skills/roles/<role>.md`:
```yaml
---
name: <role-slug>
phase: grooming | execution | validation
description: One-line role summary
supports_patterns: [relay, scatter, supervisor]  # which orchestration patterns this role can participate in

# Claude (primary)
tools_claude: ["Read", "Glob", "Grep"]
permission_mode_claude: plan | acceptEdits | full

# Gemini (secondary)
tools_gemini: [read_file, grep_search]
max_turns_gemini: 10
timeout_mins_gemini: 5

# Copilot (secondary)
tools_copilot: ["shell(git:*)"]
mode_copilot: plan | autopilot | interactive

# Output contract (universal)
output_schema:
  type: object
  properties: ...
---
Role system prompt content here (Claude-native, adapted for others at runtime)
```

### Roles to Define

**Grooming Phase (4 roles):**
1. **Interrogator** — Asks clarifying questions. Read-only. Output: `{questions: [...], assumptions: [...]}`
2. **Architect** — Analyzes codebase for impact. Read-only. Output: `{affectedFiles: [...], dependencies: [...], risks: [...]}`
3. **Scopesmith** — Estimates effort, breaks into subtasks. Read-only. Output: `{effort, subtasks: [...], acceptanceCriteria: [...]}`
4. **Spec Writer** — Synthesizes all inputs into spec. Read-only. Output: `{spec: {problem, plan, constraints, testStrategy}}`

**Execution Phase (4 roles):**
5. **Context Scout** — Gathers relevant code context. Read-only. Output: `{relevantFiles: [...], patterns: [...], conventions: [...]}`
6. **Implementer** — Writes code per spec. Full write access. Output: `{filesChanged: [...], decisions: [...]}`
7. **Refactorer** — Improves code quality post-implementation. Full write. Output: `{refactored: [...], rationale: [...]}`
8. **Dependency Manager** — Handles packages. Write + shell. Output: `{added: [...], removed: [...], upgraded: [...]}`

**Validation Phase (5 roles):**
9. **Pedant** — Style, naming, consistency. Read-only. Output: `{issues: [{severity, file, line, message}]}`
10. **Product Proxy** — Validates against requirements. Read-only. Output: `{pass: bool, gaps: [...], suggestions: [...]}`
11. **QA Automator** — Writes/runs tests. Write + shell(test). Output: `{testsAdded: [...], coverage: {...}, results: [...]}`
12. **Auditor** — Security and perf review. Read-only. Output: `{vulnerabilities: [...], perfIssues: [...]}`
13. **Documenter** — Updates docs. Write (docs paths only). Output: `{docsUpdated: [...], changelog: "..."}`

### Hand-off Contracts

- Scatter agents produce JSON per `output_schema` → Gather/Synthesis agent consumes array of upstream outputs
- Relay: each step receives previous step's full output as context injection
- Supervisor: lead agent receives child outputs as tool-call results (Claude-native, MCP-bridged for others)

### CLI Compatibility Notes

- All 13 roles work with Claude Code (primary path)
- Gemini: roles with `supports_patterns: [supervisor]` are not assignable; `max_turns`/`timeout_mins` auto-populated from template
- Copilot: `--no-ask-user` added implicitly to all headless invocations; `--max-autopilot-continues` derived from template bounds
