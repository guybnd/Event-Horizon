---
title: Event Horizon Grooming
order: 2
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.13.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## End-of-Turn Action Contract (FLUX-651/826)

Full contract lives in the orchestrator skill's "End-of-Turn Action Contract" section — read it there. For grooming specifically: complete → `change_status` to `Todo`; an implementation-critical choice unresolved → `change_status` to `Require Input` with the question + a proposed default. Never leave the ticket parked in `Grooming` with only a chat summary.

## Grooming Workflow

1. Use `get_ticket` to read the full ticket, including all history.
2. Read `.docs/INDEX.md` to identify relevant docs, then read only those files. Skip docs entirely for XS/S effort tickets.
3. Treat `Grooming` as a planning phase — do not code. Use `update_ticket` to tighten the ticket body into a concrete plan and fill inferable metadata (`priority`, `effort`, `tags`, hierarchy links).
4. If implementation-critical choices are unresolved, use `change_status` with `newStatus: 'Require Input'` and a `comment` containing one question + proposed defaults, then wait. For ambiguity that *isn't* blocking, see Plan Discipline item 3 below instead — don't flip status for something you can resolve with a stated default.
5. Once resolved, use `update_ticket` to rewrite `body` with, in this order:
   - **TL;DR** (FIRST, always): a 1–3 sentence plain-language / ELI5 summary as a leading `> **TL;DR** — …` blockquote, so the user grasps the ticket at a glance without reading the full plan (see the orchestrator skill's "Body convention").
   - **Problem / Motivation** (1–3 sentences): what problem, who benefits, why prioritised.
   - **Implementation plan**: concrete steps so another agent could pick up without re-discovery. Apply the Plan Discipline items below, scaled to the ticket's size and risk.
6. Use `change_status` with `newStatus: 'Todo'`. **CRITICAL: Stop execution after moving to Todo — do not begin implementation.** If the board's `plan` gate policy is `Auto` or `Auto→You` (FLUX-1263), this call may not move the ticket immediately — it instead kicks off an automated plan-review pass and the tool's response explains what happened. That's expected: stop the same way regardless of whether the move applied directly or the gate took over.

All persistence uses MCP tools — see the orchestrator skill's "Persisting Changes" section.

## Plan-reviewer Agent Handoff

When resuming a ticket that's already in `Grooming`, check `planReviewState` first. If it's `changes-requested`, read the latest plan-review comment (or the plan-approval panel's "Send back to Grooming" notes, FLUX-1273) before touching the plan — it explains what needs revising. Address every point raised, then re-run workflow step 6 (`change_status` to `Todo`) as normal.

The `Auto` gate's own revise-dispatch already carries this instruction via `gate-runner.ts`'s `PLAN_REVISE_FOCUS` session focus text — but that only fires when the gate itself dispatches the revision. A groomer resuming manually (not freshly dispatched by the gate — e.g. picking the ticket back up after a `you`-gate rejection, or continuing a stalled session) gets no equivalent guidance without this section.

## Plan Discipline — scale to the ticket, don't apply blanket (FLUX-978)

Borrowed from Builder.io's `agent-native` `/visual-plan` skill. Like the artifact heuristic below, **none of this is a blanket rule.** A small UI bug fix or a one-line change should stay a two-sentence plan — apply these in proportion to the ticket's size and risk, not because the section exists. Each item states its own skip condition; read the skip condition *before* reaching for the item.

1. **Anchor to real code, lead with reuse.** When the Implementation plan touches existing code, name the actual files/functions/symbols you found while reading the ticket and docs — not invented ones — and state what each step reuses (an existing action, component, or helper) before what it adds.
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

## "Reground before starting" — tickets filed from point-in-time analysis (FLUX-1048)

Tickets born from a **point-in-time codebase analysis** — tech-debt sweeps, refactor epics, audit/churn findings — cite file:line evidence that is only valid on the day of the analysis. When such a ticket is expected to be picked up **later** (Backlog/Todo queue, epic members), its body MUST include a `## ⚠️ Reground before starting` section (placed right after the TL;DR / Problem prose) that tells the implementer to:

1. **State the snapshot date** — "the findings below are a snapshot from YYYY-MM-DD" — so staleness is visible at a glance.
2. **Re-derive the evidence** — re-verify cited file:line references via Serena/grep against current code; recorded line numbers are historical, never trust them as-is.
3. **Check for partial fixes already landed** — check `<releaseNotesPath>/INDEX.md` (default `.docs/release-notes/INDEX.md`) first, the agent-consumable index of every released ticket with a one-line completion gist (FLUX-1151); it only covers already-*released* work, so also scan sibling tickets and recently Done/Released tickets — another ticket may have absorbed part (or all) of the work.
4. **Update the plan against current reality before coding** — rewrite the body (keep the TL;DR honest) to match what the code looks like now. If the finding no longer exists, re-scope or propose archiving — implementing a stale plan is worse than doing nothing.

See epic **FLUX-1043** and its subtasks **FLUX-1044/1045/1046** for the reference format. When grooming an analysis-derived ticket, add this section if it's missing. The section binds the *implementer* too — the implementation skill's "Reground Before Coding" section requires executing it before any code change.

- *Skip for:* tickets being implemented immediately after grooming, and tickets whose plan cites no point-in-time evidence (pure feature requests, UI tweaks, bug reports with a live repro).

## Rich Artifacts (`publish_artifact`) — the exception, not the norm

Shared mechanics — lifecycle framing, sandbox rules, CDN policy, revisions, the annotation round-trip, the layout-audit gate, and richer artifact kinds (Mermaid/SVG/charts/prototypes, plus live React/TSX component previews) — live in the orchestrator skill's "Rich Artifacts" section; read it there before your first emit. This section covers only grooming's emit/skip judgment.

For grooming: on tickets where the user has to *imagine* the result, publish a **self-contained HTML artifact** the user reasons *against* — a rendered mockup, an architecture/flow diagram, an interactive prototype, or acceptance criteria laid out visually. The user reacts to a concrete artifact and catches misunderstanding *before* code is written. Use the `publish_artifact` MCP tool; the artifact renders in the ticket's artifact panel.

- **Emit when** the ticket is about UI/UX, visual layout, an architecture/data-flow you can diagram, or a "shape of the thing" decision where a rendering surfaces misunderstanding cheaply.
- **Skip when** it's a bug fix, an XS/S ticket, backend plumbing, or any change with no visual/structural "shape" to react to. A markdown plan is the right output for these.

## Epic → Subtask Splitting — Affordance Coverage Check (FLUX-1274)

An epic with published artifact revisions can get cut into well-scoped subtasks that, individually, all look correct — and still **collectively drop an affordance the approved mockup showed**, because no subtask's own review has visibility into what its siblings cover. The plan-review gate (FLUX-1263) doesn't close this either: it reviews one ticket's plan in isolation, so it approves each subtask individually and still misses an epic-level coverage hole. This happened for real on `FLUX-1247`: rev 1-2 of its mockup showed the flagged plan surfacing three ways — a rich panel (artifact embedded inline + an annotation/notes thread), an in-chat prompt, and a board-card stripe — but the 4 subtasks cut from it (`FLUX-1261`-`1264`) only ever scoped the tray item; the panel and in-chat surfacing had no owning subtask and shipped nothing until the user tried the feature and a human filed the gap (`FLUX-1273`).

When you reach "design finalized — ready to split into subtasks" for an epic that has one or more `publish_artifact` revisions, before creating any subtask ticket:

1. **Enumerate every distinct affordance the *latest* revision of each published artifact shows.** A revision supersedes earlier ones — the latest is the approved scope, not the sum of every draft. List screens, panels, and interactions as separate line items, not one blob ("rich panel with inline artifact", "in-chat prompt", "board-card stripe" — not just "the UX").
2. **Map every affordance to the subtask(s) whose Acceptance Criteria will build it.** An affordance with no owner is a blocking gap — fold it into an existing subtask's Acceptance Criteria or `create_ticket` a new subtask for it before any subtask moves to `Todo`. A subtask's own scoping note (e.g. "no new component needed") is not a substitute for this — it only reasons about that subtask's own scope, with no visibility into whether a *sibling* covers what it's excluding.
3. **Write the map into the epic's own body** as a `## Subtask Coverage Map` table (`| Affordance | Subtask |`), inside or directly under its `## Acceptance criteria`. An uncounted mental pass is exactly what failed here — the map only works if it's checkable, not remembered.
4. Only move the epic (and let its subtasks proceed to `Todo`) once every row has an owning subtask.

- *Skip for:* epics with no published artifacts (nothing to drop), and subtask splits with no design/mockup phase behind them.

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
- **Substantial comments: add a faithful `summary`** on `add_note` (preserve the decision / why / actionable detail; concise but not lossy; length scales with importance — don't force one line; skip for short notes). Older summarized comments show collapsed in the agent digest; the full text stays fetchable via `get_ticket` with `expand: ["<id>"]`. Set `pin: true` on entries that must never collapse. When a comment **replaces an earlier decision** in this ticket, pass `supersedes: ["<id>"]` so the dead entry collapses to a marker (a pinned/user-authored target stays full, advisory-only — the engine won't bury human intent).
