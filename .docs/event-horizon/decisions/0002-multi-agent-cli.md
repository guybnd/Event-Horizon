---
title: "ADR 0002 — Multi-Agent CLI Research"
order: 2
---
# ADR 0002 — Multi-Agent CLI Research: Claude, Gemini, Copilot

> **Historical reasoning — skip this for ticket work.**
> For the current adapter contract see [[Agent Adapter Contract]] and [[Agent Integrations]]. This page is the research spike that informed today's multi-framework support.

Research for FLUX-282. Covers execution arguments, system prompt injection, context isolation, and inter-agent coordination patterns across Claude Code CLI, Gemini CLI, and GitHub Copilot CLI.

---

## Comparison Matrix

| Capability | Claude Code | Gemini CLI | Copilot CLI |
|---|---|---|---|
| Instruction file | `CLAUDE.md` | `GEMINI.md` | `AGENTS.md` / `.github/copilot-instructions.md` |
| Settings dir | `.claude/` | `.gemini/` | `~/.copilot/` + `.github/` |
| Non-interactive flag | `-p` / `--print` | `-p` | `-p` / `--prompt` |
| System prompt override | `--append-system-prompt` | `GEMINI_SYSTEM_MD` env | Path-specific `.instructions.md` |
| JSON output | `--output-format json` | `--output-format json` | `--output-format json` |
| Auto-approve all | `--dangerously-skip-permissions` | `--yolo` | `--allow-all` / `--yolo` |
| MCP support | `.claude/settings.json` / `--mcp-config` | `.gemini/settings.json` | `.mcp.json` / `--additional-mcp-config` |
| Subagents | `.claude/subagents/*.md` / `--agents` | `.gemini/agents/*.md` | `--agent` / plugins |
| Hooks | `.claude/hooks.json` | `settings.json` hooks | `settings.json` hooks |
| Session resume | `--resume <id>` / `-c` | (not documented) | `--resume` / `--continue` |
| Background mode | `--bg` | N/A | N/A |
| Tool restriction | `--allowedTools` | `tools:` in agent yaml | `--allow-tool` / `--deny-tool` |
| Model selection | `--settings '{"model":"..."}'` | `-m model` | `--model model` |
| Stdin piping | `cat x \| claude -p "..."` | `cat x \| gemini -p "..."` | Supported with `-p` |

> **Permission gating (FLUX-605, supersedes blanket auto-approve):** Event Horizon no longer spawns every Claude Code session with `--dangerously-skip-permissions`. Sessions now run in one of two modes — `gated` (`--permission-prompt-tool mcp__event-horizon__permission_prompt`, which routes destructive ops `change_status` / `delete_branch` / `finish_ticket` / `Bash` through a human Allow/Deny prompt) or `skip` (the legacy `--dangerously-skip-permissions`). Defaults come from the workspace risk-tolerance setting (`config.permissions`: board `gated`, ticket `skip`) and are overridable per chat. The "Auto-approve all" flag in the matrix above is still the *mechanism* for `skip` mode, but it is no longer EH's default for interactive sessions. See [MCP Tools → `permission_prompt`](../reference/mcp-tools.md#permission_prompt) and [Configuration → Permission Risk Tolerance](../configuration.md#permission-risk-tolerance).

---

## 1. Claude Code CLI

### System Prompt Injection

**Hierarchy (loaded in order):**

1. Managed policy (`/Library/Application Support/ClaudeCode/CLAUDE.md` or `C:\Program Files\ClaudeCode\CLAUDE.md`)
2. User (`~/.claude/CLAUDE.md`)
3. Project (`./.claude/CLAUDE.md` or `./CLAUDE.md`)
4. Local (`./CLAUDE.local.md`, gitignored)
5. Path-scoped rules (`.claude/rules/*.md` with `paths:` frontmatter)

**Per-invocation flags:**
```bash
--system-prompt "..."           # Replace entire system prompt
--system-prompt-file ./file.txt # Replace from file
--append-system-prompt "..."    # Add to default prompt (recommended)
--append-system-prompt-file ./file.txt
```

### Non-Interactive / Headless

```bash
claude -p "task"                    # Single query, exit
claude -p "task" --output-format json  # Structured output
claude -p "task" --output-format stream-json  # Streaming
claude --bare -p "task"             # Skip discovery (fast, reproducible)
cat data | claude -p "analyze"      # Pipe stdin
```

### Subagents & Multi-Agent

**Subagent definitions** (`.claude/subagents/*.md`):
```markdown
---
name: security-reviewer
description: Security-focused code reviewer
model: haiku
tools: ["Read", "Glob", "Grep"]
---
You are a security auditor. Review for OWASP vulnerabilities.
```

**Agent Teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):

- Team lead spawns independent teammates
- Inter-agent messaging via mailbox
- Shared task list
- Each teammate is a full independent session

**Background sessions:**
```bash
claude --bg "task"       # Start background
claude agents --json     # List running
claude attach <id>       # Attach to session
```

### Context Isolation for Roles

```bash
# Reviewer: read-only, no file edits
claude -p "Review src/ for security" \
  --append-system-prompt "You are a security reviewer. Never modify files." \
  --allowedTools "Read,Glob,Grep" \
  --permission-mode plan

# Implementer: full access, scoped instructions
claude -p "Implement the feature" \
  --append-system-prompt-file ./implementer-role.txt \
  --allowedTools "Read,Edit,Write,Bash(npm test),Bash(npm run build)" \
  --permission-mode acceptEdits
```

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Auth |
| `ANTHROPIC_MODEL` | Default model |
| `CLAUDE_CODE_EFFORT_LEVEL` | low/medium/high/max |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Enable teams |
| `BASH_DEFAULT_TIMEOUT_MS` | Bash timeout |

---

## 2. Gemini CLI

### System Prompt Injection

**Hierarchy:**

1. Global: `~/.gemini/GEMINI.md`
2. Project root: `<project>/GEMINI.md`
3. Subdirectories: component-level context

**Override via environment:**
```bash
export GEMINI_SYSTEM_MD="/path/to/custom-system-prompt.md"
```

**Settings control:**
```json
{
  "context": {
    "fileName": "GEMINI.md",
    "memoryBoundaryMarkers": [".git"]
  }
}
```

### Non-Interactive / Headless

```bash
gemini -p "task"                       # Non-interactive
gemini -p "task" --output-format json  # Structured output
gemini -p "task" --output-format stream-json  # Streaming
gemini -i "prompt"                     # Interactive with initial prompt
```

**Approval in headless:**

- `--yolo` / `--approval-mode yolo` — auto-approve all
- `--approval-mode auto_edit` — auto-approve edits only
- `ask_user` policies become `deny` in headless mode

### Subagents & Multi-Agent

**Built-in subagents:** `codebase_investigator`, `cli_help`, `generalist`, `browser_agent`

**Custom subagents** (`.gemini/agents/*.md`):
```yaml
---
name: security-auditor
description: Finds security vulnerabilities
tools:
  - read_file
  - grep_search
model: gemini-3-flash-preview
temperature: 0.2
max_turns: 10
timeout_mins: 5
---
You are a security auditor. Analyze code for OWASP vulnerabilities.
```

**Remote Agents (A2A Protocol):**
```yaml
- kind: remote
  name: remote-reviewer
  agent_card_url: https://example.com/.well-known/agent.json
```

**Per-subagent policy:**
```toml
[[rules]]
name = "Allow pr-creator to push"
subagent = "pr-creator"
action = "allow"
toolName = "run_shell_command"
```

### Context Isolation

- Each subagent has an independent context window
- Only the final result returns to the parent agent
- No recursion (subagents cannot invoke other subagents)
- Tool access is granular: explicit lists, wildcards (`*`, `mcp_*`)

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Auth |
| `GEMINI_MODEL` | Default model |
| `GEMINI_SYSTEM_MD` | Custom system prompt file |
| `GEMINI_CLI_TRUST_WORKSPACE` | Bypass folder trust |
| `GEMINI_SANDBOX` | Sandbox mode |

---

## 3. GitHub Copilot CLI

### System Prompt Injection

**Instruction layers:**

| Mechanism | File | Scope |
|---|---|---|
| Repo-wide | `.github/copilot-instructions.md` | All interactions |
| Path-specific | `.github/instructions/<name>.instructions.md` | Glob-matched files |
| Agent mode | `AGENTS.md` (nearest in tree) | Agent/CLI sessions |
| Extra dirs | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env | Additional sources |

**Path-specific format:**
```yaml
---
applyTo: "**/*.ts,**/*.tsx"
excludeAgent: "code-review"
---
Instructions content here...
```

**Disable:** `--no-custom-instructions`

### Non-Interactive / Headless

```bash
copilot -p "task" --allow-all          # Non-interactive, auto-approve
copilot -p "task" --silent             # Clean output only
copilot -p "task" --output-format json # JSONL output
copilot -p "task" --share ./out.md     # Save session to file
```

**Auth for headless:**
```bash
COPILOT_GITHUB_TOKEN=ghp_... copilot -p "task" --allow-all
```

### Subagents & Multi-Agent

**Agent modes (`--mode`):**

- `interactive` — standard
- `plan` — decompose before acting
- `autopilot` — agent continues until done

**Fleet mode:** `/fleet` for parallel subagent execution

**Key flags:**
```bash
--agent <name>                   # Use specific agent
--mode autopilot                 # Auto-continue
--max-autopilot-continues 10    # Max turns
--no-ask-user                   # No blocking on questions
```

**Cloud Coding Agent:** Assign GitHub issues to Copilot; runs in Actions, creates PRs.

**ACP (Agent Client Protocol):**
```bash
copilot --acp   # Start as protocol server for programmatic control
```

### Context Isolation for Roles

```bash
# Reviewer: restricted tools, JSON output
copilot -p "Review changes on this branch" \
  --model claude-opus-4.6 \
  --available-tools='shell(git:*)' \
  --output-format json \
  --silent \
  --no-ask-user

# Implementer: full tools, scoped MCP
copilot -p "Implement the plan" \
  --model claude-sonnet-4.6 \
  --mode autopilot \
  --max-autopilot-continues 10 \
  --allow-tool='write' \
  --allow-tool='shell(npm:*)' \
  --deny-tool='shell(git push)' \
  --additional-mcp-config @./project-mcp.json \
  --no-ask-user
```

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` | Auth |
| `COPILOT_MODEL` | Model |
| `COPILOT_ALLOW_ALL` | Auto-approve tools |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | Extra instruction dirs |
| `COPILOT_PROVIDER_BASE_URL` | BYOK mode |

---

## 4. Context Isolation Patterns for Multi-Agent Workflows

### Pattern A: Role-Specific System Prompts

Each agent instance gets a different `--append-system-prompt` (Claude) or instruction file (Gemini/Copilot) defining its role. The Reviewer prompt explicitly forbids code changes; the Implementer prompt scopes what files it may touch.

```bash
# Claude: Reviewer
claude -p "$TASK" --append-system-prompt "You are a code reviewer. Never edit files. Output JSON with {issues: [...]}." \
  --allowedTools "Read,Glob,Grep" --output-format json

# Claude: Implementer
claude -p "$TASK" --append-system-prompt-file ./implementer.txt \
  --allowedTools "Read,Edit,Write,Bash(npm test)" --output-format json
```

### Pattern B: Tool Gating

Restrict each agent's available tools to enforce boundaries:

| Role | Claude | Gemini | Copilot |
|---|---|---|---|
| Reviewer | `--allowedTools "Read,Glob,Grep"` | `tools: [read_file, grep_search]` | `--available-tools='shell(git:*)'` |
| Implementer | `--allowedTools "Read,Edit,Write,Bash(...)"` | `tools: [read_file, write_file, run_shell_command]` | `--allow-tool='write'` |
| Planner | `--permission-mode plan` | N/A | `--mode plan` |

### Pattern C: Session Chaining (Sequential Pipeline)

Agent A produces output → piped as input to Agent B:

```bash
# Step 1: Planner produces a plan
PLAN=$(claude -p "Analyze ticket and produce implementation plan" \
  --output-format json | jq -r '.result')

# Step 2: Implementer receives the plan
claude -p "Implement this plan: $PLAN" \
  --append-system-prompt "You are an implementer. Follow the plan exactly." \
  --allowedTools "Read,Edit,Write,Bash(npm test)"

# Step 3: Reviewer checks the result
claude -p "Review the changes made by the implementer" \
  --append-system-prompt "You are a reviewer. Report issues as JSON." \
  --allowedTools "Read,Glob,Grep" --output-format json
```

### Pattern D: Parallel Agents with Shared Artifact

Multiple agents work simultaneously, results merged by orchestrator:

```bash
# Launch in parallel (Claude background sessions)
claude --bg "Security review of src/"
claude --bg "Performance review of src/"
claude --bg "Test coverage analysis"

# Collect results
claude agents --json  # Get session IDs
claude attach <id>    # Read results
```

### Pattern E: Agent "Waiting" for Input

**Claude:** Use `--resume <session_id>` to continue a session with new context:
```bash
SESSION=$(claude -p "Start analysis" --output-format json | jq -r '.session_id')
# ... other work happens ...
claude --resume "$SESSION" -p "Here are the test results: $RESULTS"
```

**Copilot:** Use `--session-id` or `--resume`:
```bash
copilot -p "Start planning" --session-id my-session --share ./state.md
# ... later ...
copilot --resume my-session -p "Continue with these inputs"
```

**Gemini:** Session continuation not well-documented for headless mode.

### Pattern F: MCP as Inter-Agent Communication

Define a custom MCP server that acts as a message queue / shared state:

```json
{
  "mcpServers": {
    "agent-bus": {
      "command": "node",
      "args": ["./mcp-agent-bus.js"],
      "env": { "STORE_PATH": "./agent-state.json" }
    }
  }
}
```

Each agent instance connects to the same MCP server. The bus provides tools like `publish_result`, `wait_for_input`, `get_task_status` — enabling event-driven coordination without direct inter-process communication.

---

## 5. Recommendations for Event Horizon Multi-Agent System

1. **Use Claude Code as primary** — richest orchestration primitives (subagents, teams, background sessions, session resume, structured output)
2. **Enforce role isolation via `--allowedTools` + `--append-system-prompt`** — prevents Reviewers from editing, Implementers from pushing
3. **Session chaining for sequential workflows** — Groomer → Implementer → Reviewer pipeline using `--output-format json` and piped results
4. **MCP bus for complex coordination** — when agents need to wait for each other or share intermediate state
5. **Copilot as alternative executor** — BYOK mode lets Copilot CLI use Claude/Gemini models via `COPILOT_PROVIDER_BASE_URL`, making it model-agnostic
6. **`AGENTS.md` for Copilot cloud agent** — when delegating to GitHub's hosted coding agent for PR creation
