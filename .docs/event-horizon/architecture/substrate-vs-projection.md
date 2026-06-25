# Substrate vs Projection — immutable append-only turns, re-derivable board view

> Status: foundational architecture (FLUX-658, subtask of the curation epic [[FLUX-601]]).
> This is the spike + thin enabling slice. The curation **verbs** (extract / merge /
> archive / board-rebase) are out of scope here — this doc defines the shapes they
> plug into.

## 1. The commitment

**Append-only substrate, mutable projection.** Raw conversation turns are immutable
and append-only; what a human navigates on the board is a **re-derivable lens** over
those turns.

> board : conversation stream :: clean git history : reflog

Everything that happened is preserved (immutable substrate). What you read is curated
(mutable projection). This lifts the existing per-ticket rule ("history is append-only,
never delete") to the **whole board**, and it is what makes the future verbs *safe*:
extract / merge / archive / board-rebase become **re-projections**, not destructive
edits, so they are always un-doable.

## 2. Two axes — don't conflate them

| Axis | Question | Where it lives |
| --- | --- | --- |
| **Durability** | Did it happen? Is it kept? | Substrate — always append-only, never mutated |
| **Visibility** | What do I see right now? | Projection — a pure function of substrate + curation ops |

Durability is unconditional. Visibility is computed. A turn can be hidden from a view
without being deleted from the substrate; a board can be re-organized without rewriting
a single turn.

## 3. Substrate of record — the JSONL transcript sidecar

The substrate of record is the **per-stream JSONL transcript** at
`<fluxDir>/transcripts/<streamId>.jsonl` (`engine/src/transcript.ts`). One JSON object
per line, append-only, serialized per stream so concurrent writes never interleave.
`streamId` is the conversation id — a ticket id (`FLUX-658`) or the board sentinel
(`__board__`).

There is **no third store.** Two append-only logs already existed before this ticket;
the design *reconciles* them rather than inventing a new one:

1. **Raw substrate (this file).** `agents/claude-code.ts` tees every raw stream-json
   line from the `claude` CLI into it; `routes/cli-session.ts` + `ask-questions.ts`
   append synthetic `user` / `ask-question` / `ask-answer` events, and `claude-code.ts`
   appends a synthetic `resume-preamble` event on a warm-resumed turn (FLUX-655 — see
   below). This is the source of truth.
2. **The ticket-history `agent_session.progress[]`** (in `<taskId>.md` frontmatter, via
   `task-store.ts` + `history.ts`) is **already a projection** — `compactSessionProgress()`
   drops raw text, keeps tool/info entries + the last two text chunks, sets
   `finalMessage`, and records `originalProgressCount`. It is a compacted, normalized,
   digested *view*, not an independent source of truth. We reframe it as one projection
   among others, not a parallel record.

### 3.1 The gap this ticket closes — addressability

Before FLUX-658 a turn was addressed only by its **implicit line number**. There was no
stable turn identity to slice on, so no verb could say "turns 12–20 of stream X" durably.
This ticket makes turns **addressable** (stable id + monotonic seq) and **sliceable**
(`readTurns` / `sliceTurns`).

## 4. The turn envelope

Each appended line is wrapped in a stable envelope (`engine/src/transcript.ts`):

```jsonc
{
  "v": 1,            // envelope version — discriminates an envelope from a bare raw event
  "turnId": "FLUX-658:7",   // stable identity: `${streamId}:${seq}`
  "streamId": "FLUX-658",
  "seq": 7,          // monotonic per-stream ordinal (== line position); the slice key
  "ts": "2026-06-19T12:00:00.000Z",  // best-effort wall-clock for ordering/display
  "role": "assistant",               // coarse classification of `raw` (user/assistant/system/result/tool)
  "raw": { /* the original stream-json or synthetic event, byte-for-byte intact */ }
}
```

`raw` is the **unchanged** original object — nothing is lost or rewritten. The envelope
only *adds* identity around it.

### 4.1 Turn id / seq scheme — decision

The grooming open question (content-hash vs monotonic seq) is resolved in favour of a
**monotonic per-stream sequence**: `turnId = ${streamId}:${seq}`, where `seq` is the
0-based ordinal of the turn within its stream. Rationale:

- **Cheap range addressing.** "turns 12–20 of stream X" is a plain integer range — exactly
  what `sliceTurns(streamId, fromSeq, toSeq)` needs, and what extract/merge will call.
- **seq == line position.** Because the substrate is strictly append-only, the seq of a
  turn equals its line index in the file. This makes the scheme **self-recovering across
  process restarts** (count the lines) and makes **legacy un-enveloped lines fall into the
  same address space for free** — a legacy line at index *i* is addressed as
  `${streamId}:${i}` (see §5).
- Content-hashing was rejected for the substrate-of-record id because it gives no natural
  ordering or range slicing; if content-addressing is ever needed (e.g. dedup across
  merges) it can be carried as an *additional* field without disturbing `turnId`.

`ts` is best-effort: synthetic events carry their own `timestamp`; raw assistant
stream-json events have no reliable timestamp, so the envelope stamps wall-clock at
append time. Ordering of record is always `seq`, never `ts`.

### 4.2 Synthetic `resume-preamble` event (FLUX-655)

On a **warm-resumed** turn (the session already has a `claudeSessionId`), `claude-code.ts`
re-grounds the agent in the moved working tree by prepending a compact *situational update*
to the CLI prompt — only when the world actually moved (branch fell behind, the default
branch rewrote files underneath the branch, or sibling tickets reached a terminal/merged
status). When there is no delta, nothing is injected (no wasted tokens).

The injected context is recorded as its **own** durable substrate event so it is
reconstructable and the user's raw message stays clean (the preamble is **never** folded
into the `user` event):

```jsonc
{ "type": "resume-preamble", "text": "```situational-update …```", "timestamp": "2026-06-23T…Z" }
```

`classifyRole` maps the envelope to `unknown` (ordering metadata only). It is deliberately
**not** a chat bubble: `projectTranscript` projects it to a non-bubble `note` row tagged
`kind: 'context-update'` (FLUX-745), and the portal (`ChatView.tsx → ContextUpdateChip`)
renders that as a subtle, collapsible "⟳ context update" chip carrying the situational-update
text — visually distinct from user/assistant turns. This is pure projection + rendering off
the `text` + `timestamp` the event already carries (no schema change). The assembler
(`engine/src/resume-preamble.ts` → `buildResumePreamble`)
is standalone and side-effect-free beyond git/`tasksCache` reads, so the cold-resume
re-prime path (FLUX-602) can reuse it. It is size-capped (~1–2k chars; file/ticket lists
truncated with a "+N more" tail) and fully best-effort (any git hiccup ⇒ `null` ⇒ the turn
proceeds with the prompt untouched).

## 5. Backward compatibility — legacy lines

Live transcripts written before this ticket contain bare raw events (no envelope). The
reader must never break on them:

- **Discriminator.** A line is an envelope iff the parsed object has a string `turnId`,
  a numeric `seq`, and a `raw` field. Raw stream-json / synthetic events never carry
  these, so the check is unambiguous.
- **Legacy wrapping on read.** `readTurns` wraps a bare line into a synthetic envelope:
  `seq` = its line index, `turnId = ${streamId}:${seq}`, `ts` = `raw.timestamp` (if any),
  `role` = classified from `raw.type`. The original object is preserved verbatim as `raw`.
- **Seq continuity on write.** New appends continue the seq from the current line count
  (legacy lines included), so a file may contain legacy lines `0..k` followed by enveloped
  lines `k+1..n` with one continuous, gap-free seq space.

Result: a mixed file reads as one uniform list of `Turn`s; no migration pass is required.

## 6. Projection — `view = project(substrate, ops)`

A view is a **pure function** of the substrate and an append-only **curation op-log**:

```
view = projectTranscript(turns, ops?)
```

- `turns` — the enveloped substrate (`readTurns(streamId)` or a `sliceTurns(...)` range).
- `ops` — an append-only log of structuring operations (turn→ticket membership, extract,
  merge, archive). **No ops exist yet**; the verbs are separate tickets. The function is
  shaped to consume such a log from day one (parameter present, defaulting to empty), so
  the verbs only have to *append ops* and never touch the projector's call sites.

`projectTranscript` lives in `engine/src/projection.ts` and is **pure** (no IO) — it takes
turns in, returns `TranscriptMessage[]`. `transcript.ts`'s `readTranscriptMessages` now
routes through it (`readTurns` → `projectTranscript`), proving the rendered transcript is
a *function of* the substrate, not an independent store. There is **no user-visible
change**: the same messages render, now provably re-derivable.

### 6.1 The op-log (shape only — verbs deferred)

When the verbs land, `ops` is an append-only list of records like:

```jsonc
{ "op": "membership", "turnRange": ["FLUX-658:12", "FLUX-658:20"], "ticketId": "FLUX-700", "ts": "..." }
{ "op": "archive",    "turnRange": ["FLUX-658:3",  "FLUX-658:3"],  "ts": "..." }
{ "op": "merge",      "fromStream": "FLUX-701", "intoStream": "FLUX-658", "ts": "..." }
```

Because ops are append-only and the projector is pure, every verb is a re-projection and
therefore reversible (append a compensating op; the substrate is never edited). This is
the safety guarantee the epic rests on. The concrete op vocabulary is each verb's own
ticket; only the *seam* (a trailing `ops` parameter and the addressable turn ids the ops
reference) is fixed here.

### 6.2 The op-log STORE and the `extract` op (FLUX-656)

FLUX-658 fixed only the projection *seam*; it did not read or write a log. **FLUX-656 adds
the store** — an append-only JSONL at `<fluxDir>/transcripts/_curation-ops.jsonl`
(`engine/src/curation-ops.ts`), with `appendCurationOp(op)` / `readCurationOps()`, serialized
behind a write-queue exactly like the transcript substrate. This is the **shared** log: merge
([[merge-verb-fold-chats]], FLUX-657) reuses the same file, helpers, and source-attribution
convention so `board-rebase.ts` drives both verbs uniformly.

The first concrete op is **`extract`** — the promotion gate. A chat starts as turns in the
orchestrator thread (`__board__`); it materializes into a card only when a topic-slice is
**carved** out of the stream:

```jsonc
{ "op": "extract", "id": "<uuid>", "into": "FLUX-700", "from": "__board__",
  "fromSeq": 12, "toSeq": 20, "by": "Agent", "ts": "..." }
```

- `into` = the new ticket the slice seeds; `from` = the source stream; `fromSeq`/`toSeq` =
  the inclusive seq range of the topic-slice.
- **Reference, not copy.** The sliced `__board__` turns stay in their immutable substrate.
  The new card's view is RE-DERIVED: `readTranscriptMessages(into)` reads the op-log, finds
  ops whose `into` matches, gathers each `sliceTurns(from, fromSeq, toSeq)`, prepends them
  (in op order, ahead of the card's own turns), and projects. Remove the op → the view
  reverts. The source substrate is **byte-for-byte unchanged**.
- **Cross-stream resolution lives in the reader, not the projector.** `projectTranscript`
  stays pure over the flat turn list it is handed; `transcript.ts`'s `gatherTurnsForView`
  does the op-log read + slice-gather. Gathered (foreign) turns keep their own `streamId`;
  passing the card's id as `projectTranscript`'s `homeStreamId` tags those messages with
  `sourceStream` for an attribution badge. This is the same seam merge consumes.
- **Engine entrypoint + gating.** `extractTicket(opts)` (`engine/src/extract.ts`) is the one
  shared path behind both the `extract_ticket` MCP tool and the board-rebase `promote`
  executor. It validates the range/source (inverted range, unknown stream, empty slice →
  clear error, no ticket created) BEFORE `createTask`, so there is no partial state. Extract
  is never auto-applied: it reaches the engine only via the human-approved board-rebase
  ritual or a direct call that hits the FLUX-605 CONFIRM gate.

## 7. Authored vs projected — field map

| Concern | Classification | Notes |
| --- | --- | --- |
| Ticket title / status / priority / effort / tags / body | **Authored** | Human/agent decisions, kept verbatim in `<taskId>.md` frontmatter |
| Pins / summaries | **Authored** | Curation intent expressed by a human/agent |
| Branch name / implementation link | **Authored** | |
| Raw conversation turns | **Substrate** | Immutable, append-only; the source of record |
| Turn → ticket membership | **Projected** | Re-derivable from substrate + membership ops |
| Transcript / chat view | **Projected** | `projectTranscript(turns)` |
| History digest (`agent_session.progress[]`) | **Projected** | `compactSessionProgress()` over substrate-equivalent turns |
| Cold-resume payload | **Projected** | Re-primed from the captured turns |

"Authored" data is never re-derived — it is the input a human gave. "Projected" data is
always a function of substrate + ops and may be recomputed at will.

## 8. What this ticket ships vs defers

**Ships:** this doc; the turn envelope + monotonic id/seq on the substrate; the addressing
primitives `readTurns` / `sliceTurns`; the pure `projectTranscript(turns, ops?)` that
re-derives the existing transcript view (with `readTranscriptMessages` refactored to route
through it); tests for envelope round-trip, legacy back-compat, slice ranges, and
projection equivalence.

**Defers (separate tickets):** the curation verbs (extract/promotion [[promotion-gate-extract]],
merge [[merge-verb-fold-chats]], archive, board-rebase [[orchestrator-triage-board-rebase]])
— this ticket only fixes the op-log seam and slice primitives they call. Resume preamble
([[FLUX-655]]) is independent.

> **Update (FLUX-656, shipped):** the op-log STORE and the **`extract`** verb now exist —
> see §6.2. FLUX-656 created `engine/src/curation-ops.ts` (the shared append-only op-log) and
> `engine/src/extract.ts` (`extractTicket`), wired the board-rebase `promote` executor, and
> registered the `extract_ticket` MCP tool. Merge (FLUX-657) reuses the same store.
