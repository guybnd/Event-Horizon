---
title: Event Horizon Grooming
order: 2
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.9.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## End-of-Turn Action Contract — CRITICAL (FLUX-651)

**When you finish grooming, you MUST end the turn on a board action — never finish the plan and just summarize it in chat.** Grooming complete → `change_status` to `Todo`. Implementation-critical choice unresolved → `change_status` to `Require Input` with the question + a proposed default. Leaving the ticket parked in `Grooming` with only a chat summary gets flagged **"Needs Action"** on the board and notifies the user. "It was only a discussion turn" is not an exception.

## Grooming Workflow

1. Use `get_ticket` to read the full ticket, including all history.
2. Read `.docs/INDEX.md` to identify relevant docs, then read only those files. Skip docs entirely for XS/S effort tickets.
3. Treat `Grooming` as a planning phase — do not code. Use `update_ticket` to tighten the ticket body into a concrete plan and fill inferable metadata (`priority`, `effort`, `tags`, hierarchy links).
4. If implementation-critical choices are unresolved, use `change_status` with `newStatus: 'Require Input'` and a `comment` containing one question + proposed defaults, then wait. For ambiguity that *isn't* blocking, see Plan Discipline item 3 below instead — don't flip status for something you can resolve with a stated default.
5. Once resolved, use `update_ticket` to rewrite `body` with, in this order:
   - **TL;DR** (FIRST, always): a 1–3 sentence plain-language / ELI5 summary as a leading `> **TL;DR** — …` blockquote, so the user grasps the ticket at a glance without reading the full plan (see the orchestrator skill's "Body convention").
   - **Problem / Motivation** (1–3 sentences): what problem, who benefits, why prioritised.
   - **Implementation plan**: concrete steps so another agent could pick up without re-discovery. Apply the Plan Discipline items below, scaled to the ticket's size and risk.
6. Use `change_status` with `newStatus: 'Todo'`. **CRITICAL: Stop execution after moving to Todo — do not begin implementation.**

All persistence uses MCP tools — see the orchestrator skill's "Persisting Changes" section.

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

## "Reground before starting" — tickets filed from point-in-time analysis (FLUX-1048)

Tickets born from a **point-in-time codebase analysis** — tech-debt sweeps, refactor epics, audit/churn findings — cite file:line evidence that is only valid on the day of the analysis. When such a ticket is expected to be picked up **later** (Backlog/Todo queue, epic members), its body MUST include a `## ⚠️ Reground before starting` section (placed right after the TL;DR / Problem prose) that tells the implementer to:

1. **State the snapshot date** — "the findings below are a snapshot from YYYY-MM-DD" — so staleness is visible at a glance.
2. **Re-derive the evidence** — re-verify cited file:line references via Serena/grep against current code; recorded line numbers are historical, never trust them as-is.
3. **Check for partial fixes already landed** — scan sibling tickets and recently Done/Released tickets; another ticket may have absorbed part (or all) of the work.
4. **Update the plan against current reality before coding** — rewrite the body (keep the TL;DR honest) to match what the code looks like now. If the finding no longer exists, re-scope or propose archiving — implementing a stale plan is worse than doing nothing.

See epic **FLUX-1043** and its subtasks **FLUX-1044/1045/1046** for the reference format. When grooming an analysis-derived ticket, add this section if it's missing. The section binds the *implementer* too — the implementation skill's "Reground Before Coding" section requires executing it before any code change.

- *Skip for:* tickets being implemented immediately after grooming, and tickets whose plan cites no point-in-time evidence (pure feature requests, UI tweaks, bug reports with a live repro).

## Rich Artifacts (`publish_artifact`) — the exception, not the norm

`publish_artifact` spans **both ends of the lifecycle** — it is not grooming-exclusive. In grooming it publishes a plan-time **mockup / diagram / prototype** the user reasons *against* before code is written; at `Ready` the implementation skill uses the same tool to publish a **visual recap** of the diff (see the implementation skill's "Visual Recap Artifact" section). Same tool, same sandboxed viewer, same revision history — only the timing and content differ.

For grooming: on tickets where the user has to *imagine* the result, publish a **self-contained HTML artifact** the user reasons *against* — a rendered mockup, an architecture/flow diagram, an interactive prototype, or acceptance criteria laid out visually. The user reacts to a concrete artifact and catches misunderstanding *before* code is written. Use the `publish_artifact` MCP tool; the artifact renders in the ticket's artifact panel.

**Whether to emit is YOUR judgment per ticket — there is no tag gate.** Default OFF when unsure; artifacts must stay the exception so they don't become ceremony.

- **Emit when** the ticket is about UI/UX, visual layout, an architecture/data-flow you can diagram, or a "shape of the thing" decision where a rendering surfaces misunderstanding cheaply.
- **Skip when** it's a bug fix, an XS/S ticket, backend plumbing, or any change with no visual/structural "shape" to react to. A markdown plan is the right output for these.

**How to emit:**
- Pass a **complete, self-contained HTML document** as `html`: inline `<style>`/`<script>`. **Default to hand-written inline CSS** — an artifact is a single document, so a small `<style>` block is enough and renders instantly. Mermaid (`https://cdn.jsdelivr.net`) is loadable via `<script>` tag for diagrams. The Tailwind Play CDN (`https://cdn.tailwindcss.com`) is still allowed but is a **heavy last resort, not the default**: it's an in-browser compiler that recompiles on every DOM mutation and has measured 1-2s+ main-thread freezes per load — reach for it only when a utility framework meaningfully speeds up a complex prototype. Lean on the **`frontend-design`** skill for high-quality markup.
- It renders in a **sandboxed, opaque-origin iframe**: it CANNOT reach the portal, cookies, or storage, and CANNOT make network requests (no fetch/XHR — `connect-src` is blocked). Everything it needs must be inlined or come from the allowed CDNs. Do not rely on external API calls or `localStorage`.
- Do **not** inline the HTML into the ticket body (the body is injected into every session and has a 10K soft limit) — `publish_artifact` stores it in a sidecar.
- Every call is a **new revision** (history is kept — never an overwrite). Add a `title` and, when revising, a `note` on what changed. The viewer defaults to the latest revision.
- **Annotation round-trip (FLUX-874/875/892):** the user can annotate the rendered artifact two ways — **select text** (a floating composer pops up at the selection) or **right-click any element** (FLUX-892), which anchors to non-text controls — toggles, SVG chart bars, buttons — that have no selectable text. Either way they **collect several notes before sending them together**. They arrive as **one** chat message starting with `🎯 Artifact annotations`: text picks list the selected excerpt (`> …`), element picks show the element label (`⊙ \`button "Save"\``); both carry a CSS-path anchor (`_anchor:_`) plus the user's note. When you receive one, revise the artifact to address **every** listed region and call `publish_artifact` again (with a `note` on what changed) so the new revision streams back to the viewer. (The viewer also offers a full-screen mode for reviewing large artifacts.) Right-click annotates the artifact **as-is** — no handles or chrome are injected into your markup, so author the design however you like.

### Richer artifact kinds (FLUX-875) — diagrams, mockups, charts, prototypes

Because the artifact is a **real HTML page** rendered entirely by the sandboxed iframe, you are not limited to static markup — pick the form that makes the *shape of the thing* easiest to react to:

- **Mermaid diagrams** (flowcharts, sequence, ERD, state) — best for architecture/data-flow tickets. Load Mermaid from jsDelivr and let it render a `<pre class="mermaid">` block:
  ```html
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: true });
  </script>
  <pre class="mermaid">
  flowchart LR
    A[publish_artifact] --> B[(sidecar .flux/artifacts)]
    B --> C[GET /api/tasks/:id/artifact] --> D[sandboxed iframe]
  </pre>
  ```
- **SVG mockups** — hand-author inline `<svg>` (or inline-CSS-styled `<div>`s) for a UI wireframe the user can eyeball against their mental model.
- **Charts / data shapes** — inline SVG or a chart lib from an allowed CDN (jsDelivr/unpkg). No network calls at runtime (`connect-src` is blocked), so inline the data.
- **Clickable prototypes** — hand-written inline CSS plus a little inline `<script>` for tab/toggle interactions, so the user can click through a flow. Reach for the Tailwind Play CDN (`https://cdn.tailwindcss.com`) only for a complex, heavily-styled multi-state prototype where a utility framework earns its keep — it's a heavy last resort (see above), not the default.

Everything still renders inside the same opaque-origin sandbox (no portal/cookie/storage access, no fetch/XHR) — keep it self-contained.

### Layout-audit gate (FLUX-875) — keep artifacts visually clean

On open (and on every new revision) the viewer runs an automatic **layout audit** inside the iframe and **masks the artifact until it passes**. It checks four conservative failure modes: **`overflow-x`** (page wider than the viewport), **`off-canvas`** (an element spilling past a viewport edge), **`clipped`** (`overflow:hidden`/`clip` cutting off real text), and **`overlap`** (two text blocks rendering on top of each other). When it fails, the user can send the warnings back to you — they arrive as a chat message starting with **`🧪 Layout audit failed`**, listing each `kind`, the element selector, and the measured problem.

**When you receive a `🧪 Layout audit failed` message, treat it like an annotation:** fix the offending layout (constrain widths, wrap/scroll long content, fix positioning) and call `publish_artifact` again with a `note` on what you changed, so the corrected revision re-runs the audit. To avoid tripping the gate in the first place: give the document a sane root width, prefer responsive/flow layouts over fixed pixel widths wider than the frame, and don't absolutely-position text blocks over each other.

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
