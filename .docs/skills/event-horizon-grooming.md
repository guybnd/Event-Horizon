---
title: Event Horizon Grooming
order: 2
delivery: [injected:grooming, concatenated, modular]
deliveryNote: "🚚 INJECTED into every Claude grooming-phase session at spawn — content added here is paid by every grooming session · concatenated into gemini/cursor/antigravity/windsurf/generic installs · installed per-file for copilot/cline (modular, on-demand)."
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.20.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.

## End-of-Turn Action Contract (FLUX-651/826)

Full contract: `read_skill('orchestrator', 'End-of-Turn Action Contract')`. For grooming specifically: complete → `change_status` to `Todo`; an implementation-critical choice unresolved → `change_status` to `Require Input` with the question + a proposed default. Never leave the ticket parked in `Grooming` with only a chat summary.

## Grooming Workflow

1. Use `get_ticket` to read the full ticket, including all history.
2. **Size it first (FLUX-1795).** Decide `effort` (XS/S/M/L/XL) from what the ticket asks *before* writing any of the body — the size sets how much you read and how much you write below. Re-size if what you read changes the picture.
3. Read only what the size needs: XS/S — the files the change touches, no docs; M+ — `.docs/INDEX.md`, then only the relevant docs. Treat `Grooming` as a planning phase — do not code.
4. If an implementation-critical choice is unresolved, `change_status` to `Require Input` with one question + a proposed default, then wait. Non-blocking ambiguity → a stated default in the plan (Plan Discipline item 3), not a status flip.
5. **Artifact call (FLUX-1313):** emit via `publish_artifact` for UI/UX tickets or M+ effort (see "Rich Artifacts" below). XS/S non-UI tickets skip it silently — no "why no artifact" note (the engine already records whether one exists). Under `## Dynamic Delegation`, the session that moves the ticket to `Todo` owns this call.
6. `update_ticket` the body (and `priority`/`effort`/`tags`), **written to its size**:

   | Size | Body | Budget |
   |---|---|---|
   | XS / S | `> **TL;DR**` + up to ~6 one-line steps + only the non-obvious constraints/gotchas. No separate Problem section, no Acceptance criteria / Recommended Tests / Open Questions / Risks, no per-step rationale. | ~1.5k / ~3k chars |
   | M | TL;DR, 1-sentence Problem (or none), anchored steps, `## Acceptance criteria`; other Plan Discipline items only when genuinely relevant. | ~6k |
   | L / XL | Full Plan Discipline treatment. | ~10k |

   **Every size:** the implementer reads the code itself — record the decisions, scope boundaries and non-obvious constraints (what reading the files will *not* tell them), never a re-narration of what the files say. Supporting analysis you did (a test-by-test table, research, logs) goes in a summarized `add_note`, not the body — the body is re-read by every later session. `update_ticket` warns when a body exceeds its size's budget; trim before moving on.
7. `change_status` to `Todo`. **CRITICAL: Stop after moving to Todo — do not begin implementation.** Under an `Auto`/`Auto→You` plan gate (FLUX-1263) the call may start a plan-review pass instead of moving the ticket; stop the same way either way. Launch-mission overrides (fast-path / Oneshot continues into implementation; batch-grooming runs steps 1-7 per member) are spelled out in the mission itself — full detail: `read_skill('orchestrator', 'Grooming launch overrides')`.

All persistence uses MCP tools (see "Editing & Safety" below).

## Plan-reviewer Agent Handoff

When resuming a ticket that's already in `Grooming`, check `planReviewState` first. If it's `changes-requested`, read the latest plan-review comment (or the plan-approval panel's "Send back to Grooming" notes, FLUX-1273) before touching the plan — it explains what needs revising. Address every point raised, then re-run workflow step 7 (`change_status` to `Todo`) as normal. Write the revision as if the plan had been right the first time — ticket history already records what changed; never annotate the body with what a prior draft got wrong or which review round/annotation resolved a point.

The `Auto` gate's own revise-dispatch already carries this instruction via `gate-runner.ts`'s `PLAN_REVISE_FOCUS` session focus text — but that only fires when the gate itself dispatches the revision. A groomer resuming manually (not freshly dispatched by the gate — e.g. picking the ticket back up after a `you`-gate rejection, or continuing a stalled session) gets no equivalent guidance without this section.

## Plan Discipline — scale to the ticket, don't apply blanket (FLUX-978)

Borrowed from Builder.io's `agent-native` `/visual-plan` skill. Like the artifact heuristic below, **none of this is a blanket rule.** A small UI bug fix or a one-line change should stay a two-sentence plan — apply these in proportion to the ticket's size and risk, not because the section exists. Each item states its own skip condition; read the skip condition *before* reaching for the item. **XS/S:** only item 1 (lightly — name the file/symbol) and item 8 apply; skip the rest outright.

1. **Anchor to real code, lead with reuse.** When the Implementation plan touches existing code, name the actual files/functions/symbols you found while reading the ticket and docs — not invented ones — and state what each step reuses (an existing action, component, or helper) before what it adds. **Prefer symbol names over line numbers** — a line cite drifts the moment an earlier item in the same plan lands; cite a line only where it's genuinely load-bearing (e.g. pinpointing one spot in a large file with no distinguishing symbol). Fewer, stabler anchors also cheapen the plan-review gate's `ANCHOR_CHECK`, which re-derives every citation on every review pass.
   - *Skip for:* XS tickets and single-line fixes where "fix line N in file.ts" is the whole plan.
2. **Call out hard-to-reverse decisions.** If the ticket touches wire format, public ids, data-model/schema shape, or auth/ownership boundaries, name those decisions explicitly in the plan and state what's deferred vs. decided now.
   - *Skip for:* UI-only, XS/S, or bug-fix tickets — never add an empty section just to have covered it; only write it when such a decision genuinely exists.
3. **Non-blocking ambiguity → an "Open Questions" note, not always `Require Input`.** Reserve `Require Input` (workflow step 4) for genuinely blocking, batched (2–4 max) choices. Anything resolvable with a stated assumption goes in a short `Open Questions (non-blocking) — using default: …` line inside the plan instead of a status flip.
   - *Skip for:* the common case — most small tickets have no real ambiguity. Omit the line rather than force one.
4. **Adversarial self-review before `Todo`.** Delegate one pass whose only job is to find what's weak, missing, or wrong in the plan you just wrote (not re-research the repo): unanchored steps, an implicit hard-to-reverse call, a menu of options where the plan should commit to one, an obvious missing decision. Fix clear-cut issues yourself; route genuine judgment calls to `Require Input`.
   - *Reserve for:* L/XL effort tickets, or anything touching architecture, data-model, migration, multi-file changes, or an irreversible decision. This is the most expensive item here and the one most likely to be over-applied — **skip outright for XS/S, UI-only, or single-decision tickets.**
   - *Overlap with the automated gate (FLUX-1263):* when the board's `plan` gate is `Auto`/`Auto→You` and the ticket resolves to Thorough depth (L/XL effort — the same threshold as "Reserve for" above), `gate-runner.ts`'s Thorough-depth check runs this exact wording (`ADVERSARIAL_CHECK`) automatically once you move to `Todo` — doing it manually here is redundant with what the gate is about to do anyway. Still do it manually under a `you` gate (the gate never fires) or at a depth lower than Thorough (the automated check doesn't run there).
5. **Acceptance criteria, for tickets with a Ready/PR review flow (FLUX-1148).** Write a `## Acceptance criteria` section in the body as a GFM checkbox list (`- [ ] …`) — concrete, checkable statements a reviewer (or the portal) can verify without re-deriving intent from prose. This is a documented convention, not a new schema field or an engine gate: the portal renders an advisory "X/Y checked" progress indicator parsed from this section, and the review skill has the reviewer tick items off before recording a verdict — nothing blocks on it.
   - *Skip for:* XS/S-effort tickets and tickets with no Ready/PR review flow (pure discussion, read-only, spikes).
6. **Recommended Tests, for tickets with a non-obvious testing approach (FLUX-1273).** Write a `## Recommended Tests` section in the body — a short list or prose naming what layer to test and the key scenarios, especially anything a reviewer wouldn't guess from the Acceptance Criteria alone. The plan-approval panel's Tests tab parses a `## Recommended Tests` or `## Test plan` heading (case-insensitive) and renders it alongside Acceptance Criteria; without one, it just shows an empty state.
   - *Skip for:* XS/S-effort tickets, UI-only tickets, and tickets where the test approach is self-evident from the Acceptance Criteria (e.g. "existing suite covers this," "run `npm run check`").
7. **Consequence tracing, when the plan moves content/config into a destination (FLUX-1480).** For every file, constant, list, or module the plan says to move something INTO, name who actually consumes that destination and confirm the move still achieves the plan's goal — don't stop at "the destination exists and the plan reads consistently." The gate's own Standard-and-above check (`CONSEQUENCE_CHECK` in `gate-runner.ts`) re-asks this at review time; asking it yourself first catches the mistake before a review pass has to.
   - *Skip for:* plans that don't move anything into a shared destination (most bug fixes, UI tweaks, single-file additions).
8. **State each constraint once (FLUX-1582).** Write a shared constraint — a validation rule, a derived value, an edge case — in the one implementation step where it's acted on. Acceptance Criteria and any Risks section may reference it by name ("see item 2") but must never restate it in their own words. A Risks/Considerations section that just paraphrases the impl plan instead of naming a genuinely new risk gets cut, not trimmed — restating isn't a lighter version of the same information, it's the same information twice.
   - *Skip for:* tickets with only one implementation step — nothing to restate across.

## Rich Artifacts (`publish_artifact`) — default ON for plan proposals

Shared mechanics — lifecycle framing, sandbox rules, CDN policy, revisions, the annotation round-trip, the layout-audit gate, and richer artifact kinds (Mermaid/SVG/charts/prototypes, plus live React/TSX component previews) — live in `read_skill('orchestrator', 'Rich Artifacts')`; pull it before your first emit. This section covers only grooming's emit/skip judgment.

For grooming: a plan proposal is far cleaner for the user to work with — and to **annotate their change requirements onto** (the annotation round-trip) — as a rendered artifact than as prose. So **default to publishing a self-contained HTML artifact** the user reasons *against* — a rendered mockup, an architecture/flow diagram, an interactive prototype, or acceptance criteria laid out visually — catching misunderstanding *before* code is written. Use the `publish_artifact` MCP tool; the artifact renders in the ticket's artifact panel.

This is a **default-ON** rule, not the old "exception, not the norm" — **almost always emit for a plan proposal:**

- **Emit** when the ticket is **UI/UX (any effort)**, or **M+ effort** (M / L / XL) otherwise — a mockup/prototype for UI, an architecture/data-flow diagram for non-UI structural work.
- **Skip** only for **XS/S non-UI** tickets with no visual or structural "shape" to react to (a one-line fix, pure backend plumbing). A markdown plan is the right output for these.

When in doubt on a plan proposal, emit one.

Open-ended "feel" variables or several pivotal choices buried in prose are a strong signal to emit — the guided-annotation controls (`data-eh-feel` / `data-eh-decision`) are in `read_skill('orchestrator', 'Rich Artifacts')`.

This judgment call is workflow step 5, not just a section to remember on your own (FLUX-1313) — see the ownership note there for Dynamic Delegation. The plan-review gate also checks for this: a UI/UX-shaped plan with no artifact gets flagged in the review comment as a gap rather than silently approved, so a missed decision here surfaces there too — but that's a backstop, not a substitute for making the call at grooming time.

## Pulled on demand (not needed for most tickets)

- **Point-in-time evidence that won't be implemented right away** (tech-debt sweeps, audits, refactor epics) → add a `## ⚠️ Reground before starting` section: `read_skill('orchestrator', 'Reground before starting')`.
- **UI/UX ticket on a repo with no `.docs/design/style-guide.md`** → offer the bootstrap: `read_skill('orchestrator', 'Design Style Guide')`.
- **Splitting an epic that has published artifacts into subtasks** → run the coverage check first: `read_skill('orchestrator', 'Epic → Subtask Splitting')`.

## Metadata Conventions

| Field | Values |
|---|---|
| `priority` | `None`, `Low`, `Medium`, `High`, `Critical` |
| `effort` | `None`, `XS`, `S`, `M`, `L`, `XL` |
| `tags` | Use existing tags from board config; propose new ones only when clearly distinct |
| `assignee` | Set if user indicated ownership; leave `unassigned` otherwise |

## Editing & Safety

- All writes go through MCP tools (or the REST API as last-resort fallback). NEVER use Write, Edit, or Bash to modify ticket files.
- MCP tools handle `updatedBy` attribution and history normalization automatically.
- Do not read or write files in `.flux/` or `.flux-store/` — use `get_ticket` instead.

## Comment Conventions

- Keep comments factual and short. End input requests with a concrete question and proposed default.
- Prefer comments that help the next agent continue without re-discovery.
- **Write for the reader (FLUX-1502):** to the user (questions, `Require Input`, TL;DRs) — lead with the outcome or question, plain language, bold the load-bearing phrases; to the next agent (handoffs, findings) — self-contained facts with exact paths/symbols/ids, action first, never "see above". No filler, no hedging. Full rules: `read_skill('orchestrator', 'Communication Style')`.
- **Substantial comments: add a faithful `summary`** on `add_note` (preserve the decision / why / actionable detail; concise but not lossy; length scales with importance — don't force one line; skip for short notes). Older summarized comments show collapsed in the agent digest; the full text stays fetchable via `get_ticket` with `expand: ["<id>"]`. Set `pin: true` on entries that must never collapse. When a comment **replaces an earlier decision** in this ticket, pass `supersedes: ["<id>"]` so the dead entry collapses to a marker (a pinned/user-authored target stays full, advisory-only — the engine won't bury human intent).
