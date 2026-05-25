---
id: FLUX-285
title: Define agent system prompts for all 13 mapped roles
status: Todo
priority: High
effort: L
assignee: unassigned
tags:
  - feature
  - multi-agent
createdBy: Agent
updatedBy: Agent
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
---

Subtask of FLUX-281.

## Problem / Motivation

Each agent role needs a system prompt template that defines its identity, allowed actions, context boundaries, and output format contract. Research (FLUX-282) established exactly how to inject these prompts and enforce tool boundaries per CLI.

## Research Findings Informing This Ticket

**System prompt injection per CLI:**
- Claude: `--append-system-prompt "..."` or `--append-system-prompt-file ./role.txt` (recommended — additive to base)
- Gemini: Custom agent files in `.gemini/agents/*.md` with YAML frontmatter (`name`, `tools`, `model`, `temperature`, `max_turns`, `timeout_mins`)
- Copilot: `.github/instructions/<role>.instructions.md` with `applyTo` frontmatter, or `AGENTS.md` for agent-mode sessions

**Tool gating per role type:**

| Role Type | Claude `--allowedTools` | Gemini `tools:` | Copilot |
|---|---|---|---|
| Read-only (Reviewer) | `"Read,Glob,Grep"` | `[read_file, grep_search]` | `--available-tools='shell(git:*)'` |
| Write (Implementer) | `"Read,Edit,Write,Bash(npm test)"` | `[read_file, write_file, run_shell_command]` | `--allow-tool='write' --allow-tool='shell(npm:*)'` |
| Planner | `--permission-mode plan` | N/A | `--mode plan` |

**Output format contracts (for chaining):**
- All CLIs support `--output-format json` — role prompts should define a JSON schema for their output
- Example: Reviewer outputs `{issues: [{file, line, severity, message}]}`, Implementer outputs `{filesChanged: [...], testsRun: [...]}`

**Context isolation guarantees:**
- Claude subagents: independent context window, only final result returns to parent
- Gemini subagents: isolated context, no recursion (cannot invoke other subagents)
- Copilot: `--no-ask-user` prevents blocking; `--silent` for clean output

## Implementation Plan

### Role Templates to Create

Each template stored in `.flux/skills/roles/<role>.md` with frontmatter:
```yaml
---
name: <role-slug>
phase: grooming | execution | validation
tools_claude: [...]
tools_gemini: [...]
tools_copilot: [...]
output_schema: <JSON schema for structured output>
---
```

**Grooming Phase (4 roles):**
1. **Interrogator** — Asks clarifying questions about requirements. Output: `{questions: [...], assumptions: [...]}`
2. **Architect** — Analyzes codebase structure for impact. Output: `{affectedFiles: [...], dependencies: [...], risks: [...]}`
3. **Scopesmith** — Estimates effort and breaks into subtasks. Output: `{effort: "M", subtasks: [...], acceptanceCriteria: [...]}`
4. **Spec Writer** — Synthesizes inputs into implementation spec. Output: `{spec: {problem, plan, constraints, testStrategy}}`

**Execution Phase (4 roles):**
5. **Context Scout** — Gathers relevant code context without modifying. Tools: read-only. Output: `{relevantFiles: [...], patterns: [...], conventions: [...]}`
6. **Implementer** — Writes code following the spec. Tools: full write. Output: `{filesChanged: [...], decisions: [...]}`
7. **Refactorer** — Improves code quality post-implementation. Tools: full write. Output: `{refactored: [...], rationale: [...]}`
8. **Dependency Manager** — Handles package/dependency changes. Tools: write + shell. Output: `{added: [...], removed: [...], upgraded: [...]}`

**Validation Phase (5 roles):**
9. **Pedant** — Code style, naming, consistency review. Tools: read-only. Output: `{issues: [{severity, file, line, message}]}`
10. **Product Proxy** — Validates against requirements/acceptance criteria. Tools: read-only. Output: `{pass: bool, gaps: [...], suggestions: [...]}`
11. **QA Automator** — Writes/runs tests. Tools: write + shell(test). Output: `{testsAdded: [...], coverage: {...}, results: [...]}`
12. **Auditor** — Security and performance review. Tools: read-only. Output: `{vulnerabilities: [...], perfIssues: [...]}`
13. **Documenter** — Updates docs to match implementation. Tools: write (docs only). Output: `{docsUpdated: [...], changelog: "..."}`

### Hand-off Contracts

Define what each role consumes and produces so the relay/scatter-gather pipeline is machine-parseable:
- Scatter agents (Interrogator + Architect + Context Scout) → Spec Writer consumes all three outputs
- Implementer output → Pedant + Auditor + Product Proxy consume in parallel → QA Automator synthesizes
