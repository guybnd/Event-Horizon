---
title: Token Cost Analysis (FLUX-423)
order: 15
---

# Token Cost Analysis — Agent Session Optimization Opportunities

Spike analysis investigating where tokens are spent and what can be reduced.

## Current Token Budget Breakdown

### Per-Session Fixed Costs (loaded unconditionally)

| Component | Chars | Est. Tokens | Source | Cacheable? |
|-----------|-------|-------------|--------|-----------|
| `.claude/rules/event-horizon.md` | 22,742 | ~5,700 | Claude Code auto-loads all rules | Yes (positional) |
| Claude Code system prompt | ~8,000 | ~2,000 | Platform (estimated) | Yes |
| Initial prompt (ticket + action) | 1,000–8,000 | 250–2,000 | `buildInitialPrompt()` | Varies |
| Persona append prompt | 750–2,300 | 200–575 | `orchestration-personas.ts` | No (suffix) |
| **Total fixed per session** | | **~8,000–10,300** | | |

### Variable Costs

| Component | Chars | Est. Tokens | When |
|-----------|-------|-------------|------|
| Docs loaded by agent | 5,000–80,000 | 1,250–20,000 | Agent reads `.docs/` files |
| Relay handoff (previous output) | 2,000–15,000 | 500–3,750 | Each relay step N>1 |
| Scatter-gather diff block | 0–80,000 | 0–20,000 | Review workers (cached) |
| Agent tool calls / code reads | 5,000–100,000+ | 1,250–25,000+ | Implementation sessions |

### Cost Per Session Type (Estimated)

Based on observed session patterns and model pricing:

| Session Type | Model | Input Tokens (est.) | Output Tokens (est.) | Cost/Session | Sessions/Ticket |
|---|---|---|---|---|---|
| Grooming XS | Haiku 4.5 | ~15,000 | ~3,000 | ~$0.02 | 1 |
| Grooming M (3-step relay) | Haiku 4.5 | ~45,000 | ~9,000 | ~$0.07 | 3 (relay) |
| Implementation S | Sonnet 4 | ~40,000 | ~8,000 | ~$0.24 | 1 |
| Implementation L | Sonnet 4 | ~120,000 | ~25,000 | ~$0.74 | 1–2 |
| Scatter-gather review (7+1) | Sonnet 4 | ~280,000 | ~30,000 | ~$1.29 | 8 (7 workers + combiner) |
| Relay 3-step implementation | Sonnet 4 | ~90,000 | ~20,000 | ~$0.57 | 3 |

**Key insight:** The rules file (5,700 tokens) is ~38% of a grooming-XS session's input, but <5% of an implementation-L session. Optimization impact varies dramatically by session type.

---

## Findings by Area

### 1. Rules File Loading (5,700 tokens unconditional)

**Current state:** Claude Code loads all `.claude/rules/*.md` files unconditionally at session start. There is one file (22.7KB) containing 5 skill modules: orchestrator (161 lines), grooming (54 lines), implementation (85 lines), release (28 lines), mapping (68 lines).

**What's loaded vs. what's needed:**

| Session Phase | Modules Actually Needed | Wasted Modules | Waste (tokens) |
|---|---|---|---|
| Grooming | orchestrator + grooming | implementation, release, mapping | ~2,400 |
| Implementation | orchestrator + implementation | grooming, release, mapping | ~1,800 |
| Review (scatter-gather) | orchestrator (partial) | all phase modules | ~3,200 |
| Release | orchestrator + release | grooming, implementation, mapping | ~2,900 |
| Mapping | orchestrator + mapping | grooming, implementation, release | ~2,200 |

**Constraint:** Claude Code does NOT support conditional rule loading. Splitting into separate files does not help — all files in `.claude/rules/` load unconditionally.

**Viable alternatives (ranked):**

1. **Engine-assembled initial prompt (recommended).** Move phase-specific instructions from rules into `buildInitialPrompt()` or `appendPrompt`. The engine already knows the ticket status and selects an `actionInstruction` per phase. Extend this to include the full skill module text for the active phase only. The orchestrator's critical rules (MCP tools, safety constraints) stay in the rules file as they apply universally.
   - **Estimated savings:** 1,800–3,200 tokens/session (the unused modules).
   - **Effort:** S — modify `buildInitialPrompt()` to conditionally inject skill text.
   - **Risk:** Low. The engine already does status-aware prompt assembly.

2. **Trim the rules file.** The orchestrator module's MCP tool table (20 lines), API table (8 lines), and Working Surfaces list (6 lines) are reference material rarely needed mid-session (the agent discovers tools from its tool list). Move these to docs, keep only the behavioral rules.
   - **Estimated savings:** ~800 tokens from orchestrator trim.
   - **Effort:** XS — edit the rules file.
   - **Risk:** Low. Agent still has MCP tools in its tool list regardless.

3. **Phase markers with engine preprocessing.** Add `<!-- phase:grooming -->` markers to the rules file; the engine strips non-active sections before spawning. Requires the engine to read/modify the rules file path before session start.
   - **Estimated savings:** Same as #1 (1,800–3,200 tokens).
   - **Effort:** M — need a file preprocessor + temp file or stdin pipe.
   - **Risk:** Medium. Couples engine to rules file format; breaks if user edits rules manually.

### 2. Documentation Loading (~1,250–20,000 tokens variable)

**Current state:** The implementation skill says "for M+ effort tickets, check `.docs/INDEX.md` for relevant docs." The grooming skill says "skip docs entirely for XS/S effort tickets." These are advisory instructions — enforcement depends on agent compliance.

**Documentation tree size:**
- Total: 316KB / ~79,000 tokens (entire `.docs/` tree)
- Architecture: 77KB / ~19,000 tokens
- Reference: 65KB / ~16,000 tokens
- INDEX.md alone: 5.5KB / ~1,386 tokens
- Largest single file: `multi-repo-groups.md` at 43KB / ~10,867 tokens

**Viable alternatives (ranked):**

1. **MCP tool for scoped doc retrieval (recommended).** Add a `get_relevant_docs` MCP tool that accepts a subsystem name (from INDEX.md's subsystem map) and returns only the relevant reference page content. The agent calls it on-demand instead of reading the entire tree.
   - **Estimated savings:** 5,000–15,000 tokens/session for implementation tasks (avoid loading irrelevant reference pages).
   - **Effort:** M — new MCP tool + subsystem routing logic.
   - **Risk:** Low. Agent still has fallback Read access to `.docs/` if needed.

2. **Engine-side doc filtering in initial prompt.** For relay pipelines, include only docs relevant to the ticket's tags. Map `tags` → subsystem → doc snippets, inject into the prompt.
   - **Estimated savings:** Similar to #1 but less flexible (static at launch time).
   - **Effort:** M — tag-to-docs mapping + prompt injection.
   - **Risk:** Medium. Static mapping can't adapt to mid-session discovery needs.

3. **Enforce effort-based doc gating.** For XS/S effort, remove docs reading from the action instruction entirely (not just advisory "skip"). For M+, pre-inject only the subsystem-relevant doc.
   - **Estimated savings:** 1,000–5,000 tokens for XS/S tickets (prevents accidental doc loading).
   - **Effort:** XS — tighten action instruction wording.
   - **Risk:** Low. XS/S tickets rarely need architectural context.

### 3. Cross-Session Memory / Context Carryover

**Current state:** Each session starts from zero context beyond the ticket body + last 3 history entries. The relay system carries `cumulativeOutput` between steps, but standalone sessions have no memory of prior sessions on the same ticket.

**Options assessed:**

| Mechanism | Persistence | Token Cost | Stale Risk | Implementation |
|---|---|---|---|---|
| Claude Code CLAUDE.md | Survives all sessions | ~500 tokens (project-level) | Low (user-managed) | Free (already works) |
| Engine-injected session summary | Per-ticket, engine-managed | 200–500 tokens | Medium (last session may be outdated) | S effort |
| `cumulativeOutput` expansion | Between relay steps only | 500–3,750 tokens | Low (sequential) | Already implemented |
| Ticket history (last 3 entries) | Already injected | 200–1,000 tokens | None (authoritative) | Already implemented |

**Recommendation:** Engine-injected "last session summary" for tickets returning to `In Progress` after `Require Input` or `Ready` → `In Progress` (rework cycle). The session that produced the Ready comment has context the new session would otherwise re-discover.

- **Estimated savings:** 2,000–10,000 tokens avoided in re-discovery (agent re-reading files it already read in the prior session).
- **Effort:** S — on session start, if ticket has prior agent_session history with a summary, inject the last summary as a "prior context" block.
- **Risk:** Medium. Stale summaries could mislead if code changed between sessions. Mitigate by including the prior session's commit hash so the agent can diff.

### 4. Prompt-Prefix Caching Extension

**Current state (FLUX-375):** Scatter-gather review injects the diff block into the shared prefix of `buildInitialPrompt`, allowing all 7 reviewer workers + combiner to share a cached prefix. Persona-specific `appendPrompt` is last (suffix position), so it doesn't break cache sharing.

**Cache mechanics (Anthropic):**
- Cache reads: ~$0.30/M tokens (10x cheaper than fresh input at Sonnet rates)
- Cache creation: ~$3.75/M tokens (1.25x more than fresh input)
- Cache TTL: 5 minutes (resets on hit)
- Minimum cacheable prefix: 1,024 tokens

**Extension opportunities:**

| Scenario | Current Caching | Opportunity | Savings Estimate |
|---|---|---|---|
| Scatter-gather (7+1 workers) | Diff in shared prefix (working) | Already optimized | Baseline |
| Relay pipeline (3 steps) | No shared prefix | Steps share ticket+rules prefix | ~$0.05/relay (rules+ticket cached for steps 2-3) |
| Standalone sessions (same ticket) | No caching between sessions | Within 5-min TTL, sequential sessions hit cache | ~$0.02/session if <5min apart |
| Grooming relay (3 workers) | No shared prefix | Scout/interrogator/planner share ticket prefix | ~$0.01/grooming relay |

**Constraint:** Cross-session caching depends on the provider's server-side cache TTL (5 minutes) and prompt prefix stability. The engine cannot force cache hits — it can only ensure prompt prefix stability to maximize the probability.

**Recommendation:** For relay pipelines, ensure the stable portion (ticket ID + body + history) is in the same position across all relay steps. Currently the relay handoff *prepends* previous output to the prompt, which shifts the ticket content and breaks prefix caching. Fix: move handoff content to a suffix position (or after the ticket block but before persona).

- **Estimated savings:** $0.03–0.08 per relay pipeline (cache hits on rules + ticket prefix for steps 2+).
- **Effort:** S — reorder handoff injection in `cli-session.ts`.
- **Risk:** Low. Output quality unaffected by position of handoff context.

### 5. Model Stratification (Already Implemented)

**Current state:** The engine supports separate `groomingModel` and `implementationModel` per integration. Configuration lives in board config's `integrations.claudeCode` object.

**Pricing differential:**
- Haiku 4.5: $0.80/$4.00 per 1M (input/output)
- Sonnet 4: $3.00/$15.00 per 1M
- Ratio: Haiku is **3.75x cheaper on input, 3.75x cheaper on output**

**Current usage pattern:** Grooming uses Haiku; implementation uses Sonnet. This is already the right stratification.

**Additional opportunity:** Scatter-gather *worker* sessions could use Haiku instead of Sonnet for the 7 review passes, with only the *combiner* using Sonnet. Review workers produce short, focused findings — Haiku is sufficient.

- **Estimated savings:** $0.72/scatter-gather run (7 workers × ~$0.13 saved each).
- **Effort:** XS — add `reviewWorkerModel` config field, use it for non-lead scatter-gather sessions.
- **Risk:** Medium. Review quality may decrease with Haiku for complex code. Test with a few runs first.

---

## Ranked Recommendations

| # | Opportunity | Monthly Savings (20 tickets/day) | Effort | Risk | Priority |
|---|---|---|---|---|---|
| 1 | Engine-assembled phase prompts (strip unused skills) | $8–14/mo | S | Low | High |
| 2 | Scatter-gather workers on Haiku | $7–12/mo | XS | Medium | High |
| 3 | Scoped doc retrieval MCP tool | $5–10/mo | M | Low | Medium |
| 4 | Relay prompt reorder for cache sharing | $3–5/mo | S | Low | Medium |
| 5 | Engine-injected session summary (rework cycles) | $2–5/mo | S | Medium | Medium |
| 6 | Trim reference tables from rules file | $1–3/mo | XS | Low | Low |
| 7 | Effort-gated doc enforcement in prompt | $1–2/mo | XS | Low | Low |

**Methodology:** Monthly savings assume 20 tickets/day, mix of 40% XS grooming, 30% S implementation, 15% M implementation, 10% scatter-gather review, 5% relay pipeline. Model mix: Haiku for grooming, Sonnet for implementation/review. Savings calculated as token-delta × applicable rate × sessions/month.

**Combined potential:** Implementing #1–4 together yields an estimated **$23–41/month savings** at 20 tickets/day throughput, with total implementation effort of S+XS+M+S = approximately M overall.

---

## Follow-Up Ticket Proposals

1. **"Move phase-specific skill text into engine-assembled prompts"** — Extract grooming/implementation/release/mapping module bodies from `.claude/rules/event-horizon.md` into engine-side prompt templates. `buildInitialPrompt()` injects only the active phase's module. Orchestrator safety rules stay in rules file. Effort: S.

2. **"Add reviewWorkerModel config + use Haiku for scatter-gather workers"** — New config field `integrations.claudeCode.reviewWorkerModel`. Non-lead scatter-gather sessions use this model; combiner keeps `implementationModel`. Effort: XS.

3. **"Add get_relevant_docs MCP tool for scoped doc retrieval"** — New MCP tool accepting a subsystem slug (from INDEX.md), returns only that subsystem's reference page content. Agents call this instead of reading the full docs tree. Effort: M.

4. **"Reorder relay handoff for prefix cache stability"** — Move relay previousOutput injection from prompt-prefix position to post-ticket/pre-persona position. Ensures ticket+rules prefix is identical across relay steps for cache sharing. Effort: S.

---

## Appendix: Key Source Files

| File | Relevance |
|---|---|
| `engine/src/agents/claude-code.ts` | `buildInitialPrompt()`, token tracking, model selection |
| `engine/src/routes/cli-session.ts` | Relay handoff, scatter-gather spawn, diff injection |
| `engine/src/orchestration-personas.ts` | 20 persona prompts (750–2,300 chars each) |
| `engine/src/task-store.ts` | Token metadata persistence, cost estimation |
| `engine/src/session-store.ts` | Session registry, relay/scatter barriers |
| `.claude/rules/event-horizon.md` | 5 skill modules (22.7KB total, loaded unconditionally) |
| `.docs/event-horizon/model-pricing.md` | Model pricing table (engine-reloaded) |
