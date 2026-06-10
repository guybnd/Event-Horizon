---
title: Token Optimizer Spike (SHARED-1)
order: 16
---

# Token Optimizer Spike — Findings & Recommendation

Research spike investigating [token-optimizer](https://github.com/alexgreensh/token-optimizer) as a potential addon module for reducing agent session token costs.

## TL;DR

**Recommendation: Skip (not adoptable as an engine addon module).**

Token-optimizer is a Claude Code plugin that operates via hooks on the *session* side — it is not a library with an importable API. It cannot be injected into our engine's prompt-assembly pipeline. Its optimizations target a complementary but separate layer from our FLUX-423 findings. Installing it as a user-side plugin alongside our engine is possible but creates coupling we don't control and risks conflicts with our session management.

---

## 1. Library Assessment

### What token-optimizer actually is

| Aspect | Reality |
|--------|---------|
| Type | Claude Code plugin (hook-based), not an importable library |
| API | CLI commands (`measure.py`) + slash commands — no programmatic API |
| Input | Reads JSONL session files, CLAUDE.md, MEMORY.md, SQLite DBs |
| Output | Quality scores, compressed tool outputs, dashboards, savings reports |
| Integration | Installs via Claude Code's hook API (PreToolUse, PostToolUse, SessionStart, SessionEnd, PreCompact) |
| License | PolyForm Noncommercial 1.0.0 (free for <5 people or <$20k/month revenue) |

### What "ghost tokens" means

The term refers to invisible context overhead: system prompts, tool definitions, skills, MCP server descriptions, and memory files that consume budget before the user types anything. The README claims typical power users "burn 50–70K tokens before typing a word."

### Compression mechanisms (7 active features)

| Feature | What it does | Claimed savings |
|---------|-------------|-----------------|
| Delta Mode | Re-reads return unified diff, not full content | ~20% on re-reads, up to 97% per file |
| Structure Map | Large file re-reads return AST skeleton | ~30% on large files, up to 99% |
| Bash Compression | CLI output (git, pytest, lint) rewritten as summary | ~10% on CLI output |
| Smart Compaction | Checkpoints before auto-compact, restores critical context | Prevents context loss |
| Quality Nudges | Injects warnings when quality score drops | Triggers earlier /compact |
| Loop Detection | Similarity analysis on last 4–5 messages | Prevents avg 47K wasted tokens |
| Decision Extraction | Captures decisions, injects during compaction | Survives summarization |

### Maturity

- 1,300 stars, 509 commits, 126 releases, v5.10.4 (active as of June 2026)
- 572 tests claimed, zero runtime dependencies (pure Python stdlib)
- Actively maintained with frequent releases

---

## 2. Integration Feasibility

### The fundamental mismatch

Our engine assembles prompts server-side (`buildInitialPrompt()` → persona append → relay handoff) and spawns Claude Code sessions. Token-optimizer operates *inside* the spawned session via Claude Code's hook system. These are different layers:

```
┌─────────────────────────────────────────────────┐
│ Engine (prompt assembly)  ← FLUX-423 targets    │
│   buildInitialPrompt()                          │
│   orchestration-personas.ts                     │
│   relay/scatter-gather handoff                  │
├─────────────────────────────────────────────────┤
│ Claude Code session (runtime)  ← token-optimizer│
│   Tool call outputs                             │
│   File re-reads                                 │
│   Bash output                                   │
│   Compaction behavior                           │
└─────────────────────────────────────────────────┘
```

Token-optimizer **cannot** be injected into our prompt pipeline because:
1. It has no programmatic API (no `import { optimize } from 'token-optimizer'`)
2. It operates on session-runtime artifacts (tool outputs), not prompt-assembly inputs
3. Its hooks fire inside the Claude Code process, which our engine spawns but doesn't control internally

### Could we install it alongside the engine?

Technically yes — a user could install token-optimizer as a Claude Code plugin in their environment, and it would activate on sessions our engine spawns. However:

| Concern | Impact |
|---------|--------|
| Delta Mode alters Read tool outputs | May conflict with our relay `cumulativeOutput` which expects full text |
| Bash Compression rewrites CLI output | Our `appendSessionOutput` captures raw output for history — compressed output loses fidelity |
| Smart Compaction checkpoints | May interfere with session lifecycle management (engine expects clean exit) |
| Loop Detection injections | Could trigger on legitimate retry patterns in implementation sessions |
| No engine-side control | Cannot selectively enable/disable per session type or ticket |

### Adapter cost assessment

There is no viable adapter. The tool doesn't expose a transform function — it's a side-effect system that hooks into Claude Code internals. Writing our own equivalent of its compression features (delta-mode, AST summaries) would be a separate M–L effort unrelated to this library.

---

## 3. Comparison with FLUX-423 Findings

| Dimension | FLUX-423 (our analysis) | token-optimizer |
|-----------|------------------------|-----------------|
| Layer | Prompt assembly (engine-side) | Session runtime (client-side) |
| Waste type | Structural (unused modules, docs, cache misalignment) | Runtime (verbose outputs, re-reads, compaction loss) |
| Control point | Engine code we own | Claude Code hooks we don't control |
| Savings target | Fixed costs (skill modules, doc loading) | Variable costs (tool outputs, file reads) |
| Estimated savings | $23–41/month at 20 tickets/day | Claims 8–30% on re-reads, ~10% on CLI (hard to quantify for our workload) |
| Implementation | Direct code changes to engine | Plugin install + hope for no conflicts |

**Verdict: Complementary in theory, but non-composable in practice.** FLUX-423 optimizes what we send *into* the session. Token-optimizer optimizes what happens *during* the session. They don't overlap — but token-optimizer can't be adopted as an engine module because it doesn't operate at our layer.

---

## 4. Addon Module Architecture — Worth Generalizing?

The spike asked whether we should build a general "addon module" pattern for conditional prompt-pipeline hooks. Given the findings:

### What token-optimizer taught us

The useful insight is *not* the library itself but the categories of runtime waste it identifies:
- Redundant file re-reads (delta mode)
- Verbose tool outputs (bash compression)
- Context loss during compaction (decision extraction)

These are real problems, but solving them at our layer means building engine-side features, not plugging in external modules.

### Proposed alternatives (if we pursue content-level optimization later)

| Approach | Description | Effort | Where it lives |
|----------|-------------|--------|----------------|
| Engine-side output summarization | Post-process `cumulativeOutput` in relay handoffs to remove redundancy | S | `cli-session.ts` |
| Prompt deduplication pass | Before assembling initial prompt, detect repeated text blocks across ticket body + rules + persona | M | `buildInitialPrompt()` |
| Smart doc injection | Instead of full doc files, inject only sections relevant to ticket tags (already proposed in FLUX-423 #3) | M | New MCP tool |

A general addon-module pattern is **not worth building** at this stage because:
1. We have exactly one candidate (token-optimizer) and it can't be used as a module
2. The FLUX-423 optimizations are engine-native and don't need a plugin system
3. The prompt pipeline is simple enough (3 stages) that direct code changes are clearer than an extensibility framework

---

## 5. Recommendation

| Decision | Rationale |
|----------|-----------|
| **Skip token-optimizer adoption** | Not a library; cannot be integrated into our prompt pipeline; side-effect-based hook system that risks conflicts with engine session management |
| **Do not build addon-module pattern** | No current candidates justify the abstraction; direct engine changes are simpler for all identified optimizations |
| **Proceed with FLUX-423 roadmap** | The structural optimizations (phase-specific prompts, scoped doc retrieval, cache prefix stability) remain the highest-ROI path — they target the layer we control |
| **Revisit if** | A true library emerges that offers `fn(prompt: string) → optimizedPrompt: string` semantics, or if Claude Code exposes a prompt-preprocessing hook that engines can register |

### Value delivered by this spike

- Confirmed FLUX-423 and token-optimizer target different layers (complementary, not overlapping)
- Ruled out addon-module architecture as premature (no viable candidates)
- Identified that runtime-waste categories (re-reads, verbose outputs) are real but should be solved engine-side if pursued
- Saved future investigation time by documenting what token-optimizer actually is vs. what the name implies
