---
title: Event Horizon Grooming
order: 2
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.5.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## End-of-Turn Action Contract — CRITICAL (FLUX-651)

**When you finish grooming, you MUST end the turn on a board action — never finish the plan and just summarize it in chat.** Grooming complete → `change_status` to `Todo`. Implementation-critical choice unresolved → `change_status` to `Require Input` with the question + a proposed default. Leaving the ticket parked in `Grooming` with only a chat summary gets flagged **"Needs Action"** on the board and notifies the user. "It was only a discussion turn" is not an exception.

## Grooming Workflow

1. Use `get_ticket` to read the full ticket, including all history.
2. Read `.docs/INDEX.md` to identify relevant docs, then read only those files. Skip docs entirely for XS/S effort tickets.
3. Treat `Grooming` as a planning phase — do not code. Use `update_ticket` to tighten the ticket body into a concrete plan and fill inferable metadata (`priority`, `effort`, `tags`, hierarchy links).
4. If implementation-critical choices are unresolved, use `change_status` with `newStatus: 'Require Input'` and a `comment` containing one question + proposed defaults, then wait.
5. Once resolved, use `update_ticket` to rewrite `body` with:
   - **Problem / Motivation** (1–3 sentences): what problem, who benefits, why prioritised.
   - **Implementation plan**: concrete steps so another agent could pick up without re-discovery.
6. Use `change_status` with `newStatus: 'Todo'`. **CRITICAL: Stop execution after moving to Todo — do not begin implementation.**

All persistence uses MCP tools — see the orchestrator skill's "Persisting Changes" section.

## Rich Grooming Artifacts (`publish_artifact`) — the exception, not the norm

For tickets where the user has to *imagine* the result, you can publish a **self-contained HTML artifact** the user reasons *against* — a rendered mockup, an architecture/flow diagram, an interactive prototype, or acceptance criteria laid out visually. The user reacts to a concrete artifact and catches misunderstanding *before* code is written. Use the `publish_artifact` MCP tool; the artifact renders in the ticket's **Grooming Artifact** panel.

**Whether to emit is YOUR judgment per ticket — there is no tag gate.** Default OFF when unsure; artifacts must stay the exception so they don't become ceremony.

- **Emit when** the ticket is about UI/UX, visual layout, an architecture/data-flow you can diagram, or a "shape of the thing" decision where a rendering surfaces misunderstanding cheaply.
- **Skip when** it's a bug fix, an XS/S ticket, backend plumbing, or any change with no visual/structural "shape" to react to. A markdown plan is the right output for these.

**How to emit:**
- Pass a **complete, self-contained HTML document** as `html`: inline `<style>`/`<script>`. Tailwind (`https://cdn.tailwindcss.com`) and Mermaid (`https://cdn.jsdelivr.net`) are loadable via `<script>` tags. Lean on the **`frontend-design`** skill for high-quality markup.
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
- **SVG mockups** — hand-author inline `<svg>` (or Tailwind-styled `<div>`s) for a UI wireframe the user can eyeball against their mental model.
- **Charts / data shapes** — inline SVG or a chart lib from an allowed CDN (jsDelivr/unpkg). No network calls at runtime (`connect-src` is blocked), so inline the data.
- **Clickable Tailwind prototypes** — Tailwind from `https://cdn.tailwindcss.com` plus a little inline `<script>` for tab/toggle interactions, so the user can click through a flow.

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
- **Substantial comments: add a faithful `summary`** on `add_comment` / `log_progress` (preserve the decision / why / actionable detail; concise but not lossy; length scales with importance — don't force one line; skip for short notes). Older summarized comments show collapsed in the agent digest; the full text stays fetchable via `get_ticket` with `expand: ["<id>"]`. Set `pin: true` on entries that must never collapse. When a comment **replaces an earlier decision** in this ticket, pass `supersedes: ["<id>"]` so the dead entry collapses to a marker (a pinned/user-authored target stays full, advisory-only — the engine won't bury human intent).
