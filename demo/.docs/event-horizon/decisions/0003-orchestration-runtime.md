---
title: "ADR 0003 — Orchestration Runtime Strategy"
order: 3
---
# ADR 0003 — Orchestration Runtime Strategy

> **Historical reasoning — skip this for ticket work.**
> For the current orchestration patterns see [[Agent Adapter Contract]] and the `WorkflowBuilder` component. This ADR records the evaluation of external orchestration frameworks and why we continue building in-house.

Research for FLUX-354. Evaluates whether Event Horizon should integrate an external multi-agent orchestration framework or continue maintaining its own runtime.

---

## Context

Event Horizon implements multi-agent orchestration in ~1,100 lines across two surfaces:

- **`engine/src/agents/types.ts`** — `ExecutionPattern` (relay, scatter-gather, supervisor), `PatternPosition` (lead, assistant, combiner, step, standalone), `CliCapabilities` per framework, `AgentAdapter` interface for subprocess management.
- **`portal/src/components/WorkflowBuilder.tsx`** — phase-based pipeline UI with sequential, parallel, and scatter-gather modes; drag-and-drop agent composition; CLI compatibility matrix; workflow templates.

The orchestration layer manages **CLI subprocess agents** (Claude Code, Gemini CLI, Copilot CLI) — real processes with stdin/stdout streams, permission prompts, and tool gating. This is distinct from frameworks that orchestrate LLM API calls directly.

**Question:** Should we replace or augment our runtime with an external orchestration framework?

---

## Candidates Evaluated

### 1. LangGraph (LangChain)

Python/JS graph runtime for stateful multi-agent applications. Agents are nodes in a directed graph; edges define control flow. Supports cycles, conditional routing, and persistence via checkpointing. Execution is driven by invoking LLM APIs through LangChain's abstraction layer.

### 2. CrewAI

Python framework for role-based multi-agent collaboration. Agents have roles, goals, and backstories. Tasks are assigned to agents and executed sequentially or in a hierarchical delegation pattern. Tightly coupled to LLM API calls — agents are prompt templates with tool access, not external processes.

### 3. AutoGen / AG2

Microsoft's multi-agent conversation framework (AG2 is the community fork). Agents communicate via message passing. Supports group chat patterns, nested conversations, and tool use. Primarily designed around LLM API agents, though `UserProxyAgent` can execute code. Recent versions add "swarm" patterns.

### 4. Temporal-based Agent Frameworks (Inngest, Windmill)

Workflow engines with durable execution, retry, and observability. Agents would be modeled as workflow steps or activities. Strong at long-running processes and failure recovery. Agent orchestration is incidental to their primary value proposition.

### 5. OpenAI Swarm / Agents SDK

Lightweight multi-agent framework. Agents are functions with instructions and tool definitions. Handoffs transfer control between agents. Tightly coupled to OpenAI's API; the Agents SDK adds tracing and guardrails but remains provider-locked.

### 6. Anthropic MCP + Claude Code Subagents (Current Approach)

MCP provides the tool protocol; Claude Code provides subprocess management, background execution, and the Agent tool for spawning subagents. Event Horizon wraps this with adapter interfaces per CLI framework, capability matrices, and the WorkflowBuilder UI. The orchestration logic lives in our code.

---

## Scoring Matrix

Criteria are weighted — not all carry equal force in the decision.

| Criterion | Weight | LangGraph | CrewAI | AutoGen/AG2 | Temporal-style | OpenAI Swarm | MCP + Current |
|-----------|--------|-----------|--------|-------------|----------------|--------------|---------------|
| **Runs CLI subprocess agents** | **Blocker** | Fail | Fail | Partial | Pass | Fail | Pass |
| **Local-first (fully offline)** | **Blocker** | Partial | Partial | Partial | Pass | Fail | Pass |
| Extensible (custom patterns) | High | Pass | Partial | Pass | Pass | Fail | Pass |
| MCP tool interop | Low (shallow adapter) | Fail | Fail | Fail | Fail | Fail | Pass |
| License | Low | MIT | MIT | MIT | Apache-2.0 | MIT | N/A (ours) |

### Scoring Rationale

**CLI subprocess agents (blocker):** This is the structural constraint. LangGraph, CrewAI, and OpenAI Swarm assume the framework owns the LLM invocation — agents are functions/prompts, not external processes. AutoGen's `UserProxyAgent` can shell out but is not designed for long-running CLI sessions with streaming I/O, permission prompts, and graceful termination. Only Temporal-style engines can genuinely host subprocesses as first-class units of work.

**Local-first (blocker):** Event Horizon is positioned as a local-first ticket system. Any runtime that defaults to a SaaS control plane (Inngest cloud, OpenAI API) is disqualified from the default path even if a self-hosted option exists.

**MCP tool interop (deliberately downgraded):** No framework speaks MCP natively, but MCP is a tool protocol, not an orchestration protocol — bridging MCP tools into any framework's tool surface is a shallow adapter, not a structural blocker. Earlier drafts treated this as near-disqualifying; that conflated two layers. It is correctly a tiebreaker, not a gate.

**Result:** Only Temporal-style engines clear both blockers. The rest are eliminated on the CLI-subprocess axis alone.

---

## Top Candidates Deep-Dive

### Temporal-style (Inngest/Windmill)

Could model workflows as durable definitions with agent executions as activities.

**Pattern mapping:**
- Sequential relay → sequential workflow steps
- Scatter-gather → fan-out/fan-in (native primitive)
- Supervisor → parent workflow spawning child workflows with conditional routing

**What we'd still own:** Agent adapters, MCP integration, capability matrix, WorkflowBuilder UI, CLI process lifecycle management.

**Why it doesn't clear the bar:** Massive infrastructure overhead for ~200 lines of dispatch logic. Requires running a Temporal server (or paying for Inngest cloud), introduces network hops for in-process calls. Our workflows complete in minutes — durable execution is solving a problem we don't have.

### AutoGen/AG2

Has the richest agent communication patterns among candidates. Group chat, nested conversations, and swarm patterns approximate our relay and scatter-gather.

**Pattern mapping:**
- Sequential relay → sequential group chat
- Scatter-gather → parallel execution + summary agent
- Supervisor → hierarchical chat with manager agent

**What we'd still own:** CLI subprocess management, MCP tool bridging, adapter per framework, WorkflowBuilder UI, capability matrix.

**Why it doesn't clear the bar:** AutoGen assumes it controls the conversation loop. Our agents are opaque CLI processes that stream output and may block on permission prompts. Wrapping a Claude Code subprocess in an AutoGen agent means reimplementing most of AutoGen's message routing and termination detection in the adapter layer.

---

## Decision

**(a) Keep building in-house.**

The primary justification is not "no candidate clears the bar." It is sharper than that:

> **The orchestration runtime is not where Event Horizon's product value lives.** The ticket model, the per-CLI capability matrix, and the WorkflowBuilder UI are. Swapping the dispatcher buys nothing a user can feel, and it survives even when a future framework eventually does support CLI subprocesses + MCP.

Temporal-style engines are the only candidates that clear both blockers, and they are rejected on a separate axis: their value proposition (durable execution, retry-with-state, multi-day workflows) solves problems Event Horizon does not currently have. Adopting them now would add an operational dependency and a deployment surface for ~200 lines of in-process dispatch logic.

Everything else falls out of those two observations:

1. **Agents are processes, not prompts.** We manage stdin/stdout streams, PIDs, permission requests, and graceful shutdown — not LLM API parameters. Frameworks built around LLM-call ownership do not map onto this without reimplementing themselves inside the adapter layer.
2. **Multi-framework heterogeneity.** Claude, Gemini, and Copilot CLIs have different capability profiles. The capability matrix is ours regardless of runtime choice.
3. **MCP stays ours.** Even with a Temporal-style runtime, the MCP tool bridge is something we own.
4. **The dispatcher is small.** Sequential dispatch, parallel dispatch, and fan-in are ~200 lines. The differentiating complexity is in adapters and UI, which no external tool reduces.

---

## Consequences

- We continue maintaining orchestration patterns in-house (~1,100 lines across types + UI).
- Future patterns (conditional branching, retry with backoff, human-in-the-loop gates) are added to our codebase directly.
- If a framework emerges that natively supports MCP tool agents and CLI subprocess orchestration, re-evaluate. The most likely candidate is an evolution of Claude Code's own multi-agent primitives (Agent tool, background sessions, agent teams).
- The WorkflowBuilder UI and agent adapter interfaces remain our primary development focus — they are the differentiating layer.

---

## Re-evaluation Triggers

The original draft used a line-count trigger ("re-evaluate at 500 lines"). That is the wrong signal — line count tracks symptom, not cause. Replaced with capability-based triggers below.

Re-open this decision if **any one** of the following becomes true:

**Capability triggers (any one forces re-evaluation):**
- A user-visible feature requires durable resume across host restarts (pause/resume, time-travel debugging, multi-day workflows).
- Workflows require conditional branching with more than two decision points per pipeline.
- Retry/backoff with persisted state becomes a roadmap item.
- A human-in-the-loop gate needs to survive a host restart without losing position.

**Ecosystem triggers (any one forces re-evaluation):**
- A framework ships first-class MCP **tool-server** support (not just MCP client calls).
- Claude Code's agent-teams API stabilizes with a programmable orchestration surface.
- Inngest, Temporal, or AG2 publish a documented pattern for hosting opaque CLI subprocesses as first-class agents.

**Calendar trigger (forces a re-read regardless):**
- Revisit this ADR no later than **Q4 2026**. The candidate landscape is moving fast; a desk re-scan every ~6 months keeps the decision honest.

If a re-evaluation is triggered, the next step is a time-boxed (≤1 day) spike against the leading candidate — not another desk-research pass. The weakest part of this ADR is that its dismissals are research-only; the next iteration should not repeat that.

---

## Architecture Seam (for future integration)

If decision changes to (b) or (c), the replaceable layer is:

```
WorkflowBuilder UI  →  Workflow Engine (ours or external)  →  Agent Adapters (always ours)
                                                            →  MCP Tools (always ours)
```

The "Workflow Engine" is the only component that could be swapped. Adapters, UI, and MCP integration stay regardless of runtime choice.
