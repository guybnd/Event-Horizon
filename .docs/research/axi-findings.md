---
title: "AXI → EventHorizon findings"
order: 0
---
# AXI → EventHorizon: agent-tool ergonomics findings

> Research spike for [FLUX-871](#follow-up-backlog). Source: **[AXI — Agent eXperience Interface](https://axi.md/)** (repo: [github.com/kunchenguid/axi](https://github.com/kunchenguid/axi)).
> Deliverable = this mapping + the follow-up backlog at the end. **No production behavior changed in FLUX-871** — every recommendation is spun out as its own ticket.

## What AXI is

AXI is a set of **10 empirically-validated design principles for agent-ergonomic tool interfaces**, grouped into Efficiency, Robustness, and Discoverability. Its thesis: *"100% task success at the lowest cost" comes from **principled interface design, not protocol choice** (CLI vs MCP)* — and the governing constraint is that **token budget is a first-class cost**. AXI reports its MCP baseline averaged **~185K tokens/task vs ~79K for AXI-style tools**, and on a complex task (`ci_failure_investigation`) **$0.065 (AXI) vs $0.758 (MCP) — ~12×**; on GitHub tasks **100% success at $0.050 vs MCP 82–87% at $0.101–0.148**. It promotes **TOON** (a compact tabular encoding) over JSON for **~40% token savings**. *(All numbers are AXI's own benchmarks, cited here, not EH-validated.)*

The 10 principles (AXI's grouping):

- **Efficiency** — (1) Token-efficient output (TOON ~40% vs JSON); (2) Minimal default schemas (3–4 fields per list item, opt-in expansion); (3) Content truncation with size hints + escape hatches.
- **Robustness** — (4) Pre-computed aggregates (inline counts/summaries that eliminate round-trips; combine multi-step ops); (5) Definitive empty states (explicit zero-result message, not a bare empty collection); (6) Structured errors + clean exit codes, idempotent mutations, no interactive prompts.
- **Discoverability** — (7) Ambient context (session hooks / installable skill inject directory-scoped state); (8) Content-first (no-arg invocation shows live data, not help); (9) Contextual disclosure (append next-step command templates after output); (10) Consistent `--help`.

**Why EH cares.** EH ships a **33-tool MCP server** ([`engine/src/mcp-server.ts`](../../engine/src/mcp-server.ts)) and injects digest/preamble payloads into agents every turn — it is exactly the surface AXI critiques. The good news from this audit: **EH already implements most of AXI's principles, often in a stronger idiom**. The deltas are concentrated and cheap.

## Principle-by-principle mapping

| AXI principle | EH state | EH evidence (file · symbol/tool) | Opportunity |
|---|---|---|---|
| **1. Token-efficient output (TOON)** | **Partial** | `mcp-server.ts` · `jsonResult()` = `JSON.stringify(data, null, 2)` (pretty-printed) | TOON itself doesn't port to JSON-RPC (see Skip). But the 2-space **pretty-print indentation is pure waste** — emit compact JSON. → **FLUX-876** |
| **2. Minimal default schemas** | **Already** ✓ | `task-store.ts` · `serializeTaskForAgent()`; `mcp-server.ts` · `list_tickets` returns 7 fields (id/title/status/priority/effort/assignee/tags), not body/history; `get_ticket` opt-in `expand` / `fullHistory` | Done well. Don't rebuild. Marginal: list tools always emit `tags` even when empty. |
| **3. Content truncation + size hints** | **Already (history) ✓ / Partial (body)** | `history.ts` · `digestHistoryForAgent()` (windowing + summary-collapse, signals `olderHistoryEntries`/`collapsedCount`), `compactSessionProgress()` (streaming noise → `progressCount`); `mcp-server.ts` · `get_session_log` tail → `omittedProgressEntries` | History truncation is **better than AXI's flat truncation** (summary-collapse + recoverable `expand`). Gap: the ticket **`body` is returned whole** by `serializeTaskForAgent` and can dominate payload (`agent-payload-metrics.ts` measures it as its own section). → **FLUX-879** |
| **4. Pre-computed aggregates / combine ops** | **Already** ✓ | `mcp-server.ts` · `get_board_state` (statusCounts + active-session snapshot), `finish_ticket` (set-link + comment + status in one call); `board-digest.ts` · `buildBoardDigest()` (counts + deltas); `context-budget-metrics.ts` (whole-payload budget rollup) | Strong. Don't rebuild. Credit `finish_ticket` as a literal "combine multi-step ops." |
| **5. Definitive empty states** | **Partial** | `board-digest.ts` does it ("Active sessions: none"); but `mcp-server.ts` · `list_tickets` returns bare `[]` on no matches | Bring list tools up to the board-digest bar: return a definitive, filter-echoing empty state. → **FLUX-878** |
| **6. Structured errors / idempotent / no prompts** | **Already** ✓ **/ Partial (codes)** | `mcp-server.ts` · `errorResult()` → `{ isError: true }` with enumerated text ("…Known sessions: DEF, GHI"); `ask_user_question` is a structured tool, not a blocking stdin prompt | Errors are free-text only — no machine-readable discriminant. Add a stable `code` (retryable vs terminal). → **FLUX-880** |
| **7. Ambient context** | **Already** ✓ | `resume-preamble.ts` · `buildResumePreamble()` (situational-update fence on resume); `board-reprime.ts` · `buildBoardReprime()` (cold-resume transcript recovery); `board-digest.ts` per-turn; installable skills under `.docs/skills/` + `skill-installer.ts` | EH's strongest match — this *is* AXI #7 ("relevant state in every conversation"), with capped lists + graceful git fallback. Don't rebuild. |
| **8. Content-first (no-arg = live data)** | **Adapted / N/A** | No "no-arg invocation" in JSON-RPC; closest is `get_board_state` (explicit) + ambient re-priming (implicit live data) | CLI-specific mechanic. EH already delivers live-data-without-asking via re-priming (#7). Nothing to build — see Skip. |
| **9. Contextual disclosure (next-step templates)** | **Partial** | Next-step guidance lives in **static tool descriptions** (`get_ticket` "pass ids in `expand`…", `propose_board_rebase` "do not call the restructuring verbs directly") — but **not in responses** | Strongest cheap win: have mutation tools return a terse next-step hint **in the response** (after `change_status`, `create_branch`, `create_ticket`). → **FLUX-877** |
| **10. Consistent `--help`** | **Already (idiom-translated)** ✓ | MCP protocol surfaces every tool's description + JSON schema on tool-list; that *is* the consistent, per-tool help affordance | The `--help` concept maps onto MCP's tool-listing. Nothing to build. |

**Bonus — AXI's measurement thesis ("measure the token budget"):** EH already instruments this. [`agent-payload-metrics.ts`](../../engine/src/agent-payload-metrics.ts) · `computeAgentPayloadMetrics()` breaks the agent-facing `get_ticket` payload into sections (body / history / tags / cliSessions / frontmatter) with byte + token-est + pct, plus a history breakdown — surfaced **debug-only** via `GET /:id/debug/sizes` (and a fuller rollup at `/:id/debug/budget` via `context-budget-metrics.ts`), never attached to the agent payload so measurement doesn't inflate it. This is EH's existing, principled answer to AXI's core claim.

## Adopt / Adapt / Copy(already) / Skip

Ranked by value-vs-effort. Each names the EH surface it touches.

### Adopt (worth doing — tickets filed)
1. **Compact JSON output** — drop `null, 2` in `jsonResult` (`mcp-server.ts`). One line, every tool benefits; the realistic stand-in for AXI #1 without TOON. *(XS)* → **[FLUX-876](../../engine/src/mcp-server.ts)**
2. **Next-step hints in responses** (AXI #9) — mutation tools return a terse next-step line, not just static docstrings (`mcp-server.ts`). Best ergonomics-per-effort. *(M)* → **[FLUX-877](../../engine/src/mcp-server.ts)**
3. **Definitive empty states** (AXI #5) — `list_tickets`/peers return a filter-echoing empty state instead of `[]` (`mcp-server.ts`). *(S)* → **[FLUX-878](../../engine/src/mcp-server.ts)**
4. **Body truncation + size hint** (AXI #3) — apply the history-collapse idiom to oversized `body` in the agent view (`task-store.ts` · `serializeTaskForAgent`), with an opt-in full-body escape hatch. *(M)* → **[FLUX-879](../../engine/src/task-store.ts)**

### Adapt (port the intent, not the mechanic)
5. **Structured error codes** (AXI #6) — add a stable machine-readable `code` to `errorResult` alongside the existing human text (`mcp-server.ts`). MCP has no exit codes; a `code` field is the idiomatic port. *(S, lower priority — text errors already serviceable)* → **[FLUX-880](../../engine/src/mcp-server.ts)**

### Copy = already done (credit, do **not** rebuild)
- **AXI #2 minimal schemas** → `serializeTaskForAgent` + `list_tickets` field-trim + opt-in `expand`/`fullHistory`.
- **AXI #3 truncation+hints (history)** → `digestHistoryForAgent` / `compactSessionProgress` — *stronger* than flat truncation (summary-collapse, recoverable, supersession-aware).
- **AXI #4 aggregates / combine-ops** → `get_board_state`, `buildBoardDigest`, `finish_ticket`, `context-budget-metrics`.
- **AXI #7 ambient context** → `resume-preamble` + `board-reprime` + installable skills.
- **AXI measurement thesis** → `agent-payload-metrics` + `context-budget-metrics` + `/debug/sizes`.

### Skip / doesn't transfer (with reason)
- **AXI #1 TOON wire format** — EH speaks **JSON-RPC over MCP**, not a CLI stdout stream; you can't swap the transport encoding to a TOON table without breaking every MCP client. The *intent* (token efficiency) is captured by compact JSON (FLUX-876); TOON itself is out of scope.
- **AXI #8 content-first (no-arg)** — there is no "no-argument invocation" in JSON-RPC; the principle is CLI-shell-specific. EH already delivers live-data-without-being-asked through ambient re-priming (#7), which is the correct idiom here.
- **AXI #6 exit codes / no interactive prompts** — exit codes are a process-CLI concept; MCP uses `{ isError: true }`, which EH already does. EH also has no blocking stdin prompts (HITL is the structured `ask_user_question` tool). Only the *structured-code* slice (FLUX-880) is actionable.
- **AXI #10 `--help`** — MCP's tool-list already surfaces descriptions + schemas per tool; the affordance exists by protocol. Nothing to build.

## Bottom line

EH was, independently, already living most of AXI's playbook — and in two places (summary-collapse over flat truncation; payload-cost instrumentation) goes further. The actionable delta is small and concentrated on **MCP tool response shapes** (`mcp-server.ts`) plus one **agent-view body** gap (`task-store.ts`): five tickets, mostly XS–S, headlined by the one-line compact-JSON win.

## Follow-up backlog

| Ticket | Title | AXI principle | Effort |
|---|---|---|---|
| FLUX-876 | Emit compact JSON from MCP tool results | #1 (token-efficient) | XS |
| FLUX-877 | Contextual next-step hints in MCP responses | #9 (contextual disclosure) | M |
| FLUX-878 | Definitive empty states for list-style tools | #5 (empty states) | S |
| FLUX-879 | Truncate oversized ticket body + size hint | #3 (truncation) | M |
| FLUX-880 | Machine-readable error codes in `errorResult` | #6 (structured errors) | S |
