---
title: Event Horizon Orchestrator
order: 1
---
> ⚠️ DO NOT DELETE — Required for Event Horizon agent workflow.

## Phase: Orchestrator

Scope: Route the agent to the correct phase-specific skill based on ticket status.

---

# Event Horizon Agent — Orchestrator

Version: 2.12.0

## Overview

Event Horizon is a local-first ticket board backed by markdown files. Tickets are stored either in `.flux/` (in-repo mode) or `.flux-store/` (orphan-branch mode using a git worktree on `flux-data`). The engine abstracts this — agents interact exclusively through MCP tools and never touch ticket files directly.

## Skill Routing

| Ticket Status | Load Skill |
|---|---|
| `Grooming`, `Require Input` | grooming skill |
| `Todo`, `In Progress` | implementation skill |
| `Ready` — review-phase / reviewer-of-record sessions | review skill |
| Release orchestration | release skill |
| Cross-project mapping (multi-repo group) | mapping skill |

Read-only tasks (explanation, search, discussion) need no phase skill.

## Ticket Model

Tickets have these fields (relevant when calling `update_ticket` or reading `get_ticket` output):

| Field | Type | Notes |
|---|---|---|
| `id` | string | e.g. `FLUX-41` — set by engine, never change |
| `title` | string | Short description |
| `status` | string | Board column (e.g. `Grooming`, `Todo`, `In Progress`, `Ready`, `Done`) |
| `priority` | string | `None`, `Low`, `Medium`, `High`, `Critical` |
| `effort` | string | `None`, `XS`, `S`, `M`, `L`, `XL` |
| `assignee` | string | User name or `unassigned` |
| `tags` | string[] | From board config |
| `body` | markdown | Description / plan. MUST open with a one-glance, plain-language **TL;DR** blockquote — see "Body convention" below |
| `subtasks` | string[] | Child ticket IDs — use `create_ticket` with `parentId` to add |
| `implementationLink` | string | Commit hash or PR URL — set by `finish_ticket` |
| `branch` | string | Git branch name (e.g. `flux/FLUX-41-add-effort-field`) — set by `branch` (`action:'create'`) or portal Start Task prompt |

**Body convention — lead with a TL;DR (FLUX-953).** Every time you write or rewrite a ticket `body` (via `update_ticket` or `create_ticket`), the FIRST thing in it MUST be a short, plain-language **TL;DR** — one to three jargon-free, ELI5 sentences saying what the ticket is and what "done" looks like — so the user (and the next agent) can grasp it at a glance without reading the whole body. Format it as a leading blockquote, then the detailed Problem / Plan prose follows. Bold the 2-4 key words/phrases within the sentence(s) itself — the concrete subject, the deliverable, a sharp constraint — so a skimmer catches the gist from the bold words alone (FLUX-1298); cap it at 2-4 short phrases, not every noun, so it doesn't get visually noisy:

> **TL;DR** — one to three plain sentences **summarizing what the ticket is** and what **done looks like**.

Keep it honest and current: if a later body rewrite changes the gist, update the TL;DR in the same edit. Skip it only for a trivially short body (a line or two) where a TL;DR would just repeat it.

History is an append-only event log (types: `comment`, `status_change`, `activity`, `agent_session`). You read it via `get_ticket` and append to it via `add_note`, `change_status`. Never construct history entries manually.

`get_ticket` returns a digest: `agent_session` entries come back without their `progress[]` array (a `progressCount` is kept), and history is windowed to the most recent ~20 entries (`olderHistoryEntries` reports how many were omitted; pass `historyLimit` for more). Use `get_session_log` only when you need a specific prior session's raw progress.

Older entries that carry an agent `summary` are shown **collapsed** — `{ type, user, date, summary, id, collapsed: true }` instead of the full text (`status_change` entries are dropped entirely). Read the summary first; only when it isn't enough, fetch the full text with `get_ticket(ticketId, expand: ["<id>"])` (avoid `fullHistory: true` — it re-inflates context). Recent comments, `pin`ned entries, and anything without a summary are never collapsed. When you write a substantial `add_note` comment or activity note, pass a faithful `summary` (and `pin: true` for review handoffs / key decisions) so it stays cheap-but-recoverable for the next agent.

**Delegating:** a delegate reads the ticket itself via `get_ticket` and gets the same collapsed digest. Put the task-relevant context in the delegation `task` string; if the delegate needs a specific collapsed comment, inline it (or its id) rather than making it hunt. Delegates can `expand` selectively.

## Working Surfaces

- Ticket storage: `.flux/` (in-repo) or `.flux-store/` (orphan mode) — agents NEVER access these directly
- Board config: `config.json` in the active flux directory
- Project docs: `.docs/**/*.md`
- Engine source: `engine/src/`
- Portal source: `portal/src/`
- Skill sources: `.docs/skills/*.md`
- Skill templates: `.flux/skills/*.md`

## APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/tasks` | List all tickets |
| `POST /api/tasks` | Create a ticket |
| `PUT /api/tasks/:id` | Update a ticket |
| `DELETE /api/tasks/:id` | Delete a ticket |
| `POST /api/tasks/:parentId/subtasks` | Create a linked subtask |
| `GET /api/config` | Get board config |
| `PUT /api/config` | Update board config |
| `POST /api/bulk-rename` | Bulk rename statuses/tags |

Portal: `localhost:5167` — Engine: `localhost:3067`

## User Input Routing

- Chat for broad discussion. Ticket system for ticket-specific decisions.
- `Require Input` → history comment with one clear question + proposed defaults → user answers → route back to next status.
- `Ready` → user reviews → `finish <ticket>` → agent commits + closes atomically.

## Ticket Resolution

- `FLUX-41` → use that ticket. Bare number like `41` or `do 41` → resolve to `FLUX-41`.
- Repo-changing work without a named ticket → find or create a ticket first.
- Pure explanation, brainstorming, or read-only discussion does not require ticket state changes.

## Persisting Changes — CRITICAL

All ticket updates — status changes, metadata, body rewrites, history comments — **MUST** use the MCP tools listed below.

**NEVER do any of the following:**
- Use the `Write` tool on any file in `.flux/` or `.flux-store/`
- Use the `Edit` tool on any file in `.flux/` or `.flux-store/`
- Use `Bash` with `echo`, `sed`, `cat >`, or any shell command that writes to ticket files
- Use `curl` to hit the REST API when MCP tools are available
- Construct YAML frontmatter manually and write it to disk

The MCP tools handle schema validation, timestamps, history normalization, and portal sync. Direct file writes bypass all of this and can corrupt tickets.

### MCP Tools (use these — they appear in your tool list)

| Tool | Use When |
|---|---|
| `get_ticket` | Reading a ticket (frontmatter + body + digested recent history) |
| `get_session_log` | Reading one prior agent session's full progress log (rare — debugging only) |
| `list_tickets` | Finding tickets by status, assignee, tag, or priority |
| `get_board_config` | Checking valid statuses, tags, project key |
| `create_ticket` | Creating a new ticket — pass `parentId` to create it as a linked subtask |
| `update_ticket` | Changing metadata ONLY (title, priority, effort, tags, assignee, body) — does NOT move status |
| `change_status` | Moving to a new status (comment required for Require Input/Ready) |
| `archive` | `action:'archive'` removes a ticket from the active board (moves to `Archived`; reversible — there is no hard-delete tool); `action:'unarchive'` restores it (default `Todo`, or `toStatus`) |
| `extract_ticket` | Carving a topic-slice out of a chat stream into a NEW card (the promotion gate). Human-approved only (CONFIRM gate / board-rebase `promote`); additive + un-doable |
| `merge_tickets` | Folding several tickets/chat-streams into ONE survivor effort (the inverse of extract). Sources are tombstoned + archived (never deleted); the survivor re-derives the chronological union. Human-approved only (CONFIRM gate / board-rebase `fold`) |
| `add_note` | Adding a `type:'comment'` (human-facing comment) or `type:'activity'` (agent progress update) to ticket history |
| `finish_ticket` | Completing a ticket (sets implementationLink + Done atomically) |
| `branch` | `action:'create'` makes a feature branch (`flux/<ID>-<slug>`) + worktree; `action:'status'` returns name/existence/ahead-behind; `action:'delete'` removes it (refuses unmerged unless `force:true`) |

Notes:
- `change_status` enforces comment requirements: you MUST provide a `comment` when transitioning to `Require Input` (the question) or `Ready` (the completion summary).
- `finish_ticket` is atomic: it sets the implementation link, adds a completion comment, and moves status to Done in one operation. When the ticket has a `branch`, it also pushes the branch and creates a PR via `gh` — the PR URL becomes the `implementationLink`.
- `create_ticket` with `parentId` creates a child ticket file and links it to the parent's `subtasks` array atomically.
- All tools handle timestamps, history normalization, and schema validation server-side.
- There is **no** `switch_branch` tool. Agents stay on their ticket branch for the full session. Switching branches requires explicit user confirmation in chat.

### REST API (last-resort fallback)

ONLY use the REST API if MCP tools genuinely fail to load (i.e., `ToolSearch` returns no `event-horizon` tools). If MCP tools appear in your tool list, use them — never fall back to curl/REST "for convenience."

REST base: `http://localhost:3067`

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/tasks/:id?view=agent` | Read a ticket — ALWAYS pass `view=agent` (digested surface; omitting it returns the full portal payload incl. raw session logs) |
| `POST` | `/api/tasks` | Create a ticket |
| `PUT` | `/api/tasks/:id` | Update a ticket (use `appendHistory` for comments) |
| `POST` | `/api/tasks/:parentId/subtasks` | Create a linked subtask |

If neither MCP tools nor the API are reachable, surface the problem to the user and wait. Do not edit files directly under any circumstances.

Ticket changes that only exist in chat or agent memory are **lost**. The engine is the single source of truth.

## End-of-Turn Action Contract — CRITICAL (FLUX-651/826)

This is the authoritative text — phase skills (grooming, implementation) each carry only a one-line reminder plus their own status-transition mapping and link back here. Read this section once; it applies to every phase.

- **End every working turn on a board action (FLUX-651).** When you finish grooming/implementing/reviewing a ticket — including in a chat/discussion session — you MUST end the turn by moving the ticket to its next status (or `Require Input`, or creating subtasks). Never finish the work and just summarize it in chat: "it was only a discussion turn" is not an exception. If you leave a ticket parked in a working status (`Grooming` / `In Progress`) without an action, the engine flags it **"Needs Action"** on the board and notifies the user.
- **Raise decisions through a structured surface, regardless of status (FLUX-826).** Any question or decision for the user goes through `ask_user_question` or `Require Input` — never chat prose. This holds on **resting/terminal** tickets too (Done/Ready/Todo/Backlog/Released/Archived): a "should I file a ticket / commit / leave it?" call on a closed ticket typed only into chat has no picker, no notification, and no board flag, so it's lost the moment the user looks away. `Require Input` parks the *current* status (wrong for a Done ticket) — on a resting ticket use `ask_user_question` instead, whose timeout also leaves a persistent "Needs Action" flag as a safety net. A softer backstop also fires on resting/terminal tickets: ending a turn having posted a fresh comment but taken no board action and raised no structured prompt surfaces a needs-action nudge, so a decision buried in a comment on a closed ticket isn't lost. Do not rely on either backstop — route the decision yourself.

## Rich Artifacts (`publish_artifact`) — shared mechanics

`publish_artifact` spans **both ends of the lifecycle** — it is not grooming-exclusive. In grooming it publishes a plan-time **mockup / diagram / prototype** the user reasons *against* before code is written; at `Ready` the implementation skill uses the same tool to publish a **visual recap** of the diff. Same tool, same sandboxed viewer, same revision history — only the timing, content, and phase-specific emit/skip judgment differ (see the grooming and implementation skills for those).

**Whether to emit is calibrated per phase — there is no tag gate.** For **grooming plan proposals** the default is **ON** (almost always — see the grooming skill's UI-or-M+ rule), because a rendered plan is far easier for the user to react to and annotate than prose. For **implementation visual recaps** it stays a judgment call — the exception, not ceremony; default OFF when unsure. Either way, never emit an artifact for something with no visual or structural shape to react to.

**How to emit — shared mechanics for both phases:**
- Pass a **complete, self-contained HTML document** as `html`: inline `<style>`/`<script>`. **Default to hand-written inline CSS** — an artifact is a single document, so a small `<style>` block is enough and renders instantly. Mermaid (`https://cdn.jsdelivr.net`) is loadable via `<script>` tag for diagrams. The Tailwind Play CDN (`https://cdn.tailwindcss.com`) is still allowed but is a **heavy last resort, not the default**: it's an in-browser compiler that recompiles on every DOM mutation and has measured 1-2s+ main-thread freezes per load — reach for it only when a utility framework meaningfully speeds up a complex prototype. Lean on the **`frontend-design`** skill for high-quality markup.
- It renders in a **sandboxed, opaque-origin iframe**: it CANNOT reach the portal, cookies, or storage, and CANNOT make network requests (no fetch/XHR — `connect-src` is blocked). Everything it needs must be inlined or come from the allowed CDNs. Do not rely on external API calls or `localStorage`.
- Do **not** inline the HTML into the ticket body (the body is injected into every session and has a 10K soft limit) — `publish_artifact` stores it in a sidecar.
- Every call is a **new revision** (history is kept — never an overwrite). Add a `title` and, when revising, a `note` on what changed. The viewer defaults to the latest revision.
- **Annotation round-trip (FLUX-874/875/892):** the user can annotate the rendered artifact two ways — **select text** (a floating composer pops up at the selection) or **right-click any element** (FLUX-892), which anchors to non-text controls — toggles, SVG chart bars, buttons — that have no selectable text. Either way the notes **collect in a host-side floating "N changes" pill** (FLUX-1362 — a unified, editable list shared with the plan-review panel; click a pin to edit its note) and **send together**. They arrive as **one** chat message starting with `🎯 Artifact annotations`: text picks list the selected excerpt (`> …`), element picks show the element label (`⊙ \`button "Save"\``); both carry a CSS-path anchor (`_anchor:_`) plus the user's note. When you receive one, revise the artifact to address **every** listed region and call `publish_artifact` again (with a `note` on what changed) so the new revision streams back to the viewer. (The viewer also offers a full-screen mode for reviewing large artifacts.) Right-click annotates the artifact **as-is** — no handles or chrome are injected into your markup, so author the design however you like.

- **Guided annotation — declare feel + decision controls (FLUX-1440):** for two specific shapes of feedback, you can skip right-click entirely by declaring plain, framework-free markup and letting the injected viewer script upgrade it into a live, auto-staging control — no hand-wired JS, no new machinery on top of the round-trip above.
  - **`data-eh-feel`** — for an open-ended variable with no right answer on paper (scroll speed, easing, spacing) that the user should *feel out* with a live control rather than have you guess a number:
    ```html
    <div data-eh-feel data-eh-label="Scroll speed" data-eh-min="0" data-eh-max="100" data-eh-default="40" data-eh-unit="ms"></div>
    ```
    The viewer renders a range slider + live readout inside that element. Settling on a value auto-**stages** an annotation (`kind:'feel'`, value read straight from the control — no right-click, no textContent guessing); re-dragging restages the same annotation in place, not a growing pile.
  - **`data-eh-decision`** — for a pivotal choice buried in prose that deserves a deliberate, located answer instead of being skimmed:
    ```html
    <div data-eh-decision data-eh-question="Empty-state treatment?" data-eh-index="1" data-eh-of="3" data-eh-default="illustration">
      <button data-eh-opt>illustration</button>
      <button data-eh-opt>hidden</button>
      <button data-eh-opt>text-only</button>
    </div>
    ```
    The viewer renders a consistent decision card (question + index/of tag + options); picking an option auto-stages `{kind:'decision', value: chosenOption}`, restaging in place on a different pick.
  - Both auto-stage into the **same** `annotations[]` set and **same** `postLive()` preview pill as manual annotations — staging is automatic, but the staged set is **only** transmitted back to you via the user's explicit Send action (auto-stage ≠ auto-send). When it lands in a `🎯 Artifact annotations` message, a feel pick renders its dialed value and a decision renders the chosen option alongside the usual anchor/note. These are **opt-in conventions, not required templates** — reach for them when a plan genuinely has an open-ended variable or a handful of pivotal choices (cap around 3-4 decisions per plan); don't sprout sliders and decision forms on a plan that doesn't call for them.

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
- **React / TSX component previews** (FLUX-961) — for a component-shaped UI ticket, render a live React component instead of hand-drawing it: load React + ReactDOM UMD + `@babel/standalone` from jsDelivr and transpile **one inline** `<script type="text/babel" data-presets="react,typescript">` block that defines the component and mounts it to `#root`. Copy this canonical, self-contained template and drop your component in:
  ```html
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
    <style> body { margin: 0; font-family: system-ui, sans-serif; } </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel" data-presets="react,typescript">
      // Define your component inline — no imports of project modules (see caveat below).
      type Props = { label: string };
      function Preview({ label }: Props) {
        const [n, setN] = React.useState(0);
        return (
          <button onClick={() => setN(n + 1)} style={{ padding: '8px 16px' }}>
            {label}: {n}
          </button>
        );
      }
      ReactDOM.createRoot(document.getElementById('root')).render(<Preview label="clicks" />);
    </script>
  </body>
  </html>
  ```
  **Inline-only — no exceptions.** `connect-src 'none'` kills every network fetch, so Babel's external `src=`-transform path and any in-iframe `import` resolution are dead. Do **not** `import` project modules (`AppContext`, design tokens, sibling `.tsx`) or fetch an external `.tsx` — the component, its types, and any mock data must all live in that one `text/babel` block. This is **additive/opt-in**: plain HTML, Mermaid, and SVG artifacts are unaffected and need none of this scaffolding. React/Babel load from the CDN at view time (`'unsafe-eval'` transpiles in-browser), so the artifact won't render offline — same tradeoff as every other CDN-backed kind. Keep the block lean so the transpile-then-mount first paint stays quick; the layout audit re-fires after the async React mount settles, so a late mount won't false-warn.

Everything still renders inside the same opaque-origin sandbox (no portal/cookie/storage access, no fetch/XHR) — keep it self-contained.

### Layout audit (FLUX-875, non-blocking as of FLUX-1362) — keep artifacts visually clean

On open (and on every new revision) the viewer runs an automatic **layout audit** inside the iframe. It checks four conservative failure modes: **`overflow-x`** (page wider than the viewport), **`off-canvas`** (an element spilling past a viewport edge), **`clipped`** (`overflow:hidden`/`clip` cutting off real text), and **`overlap`** (two text blocks rendering on top of each other). The audit is **advisory and non-blocking** (FLUX-1362): the artifact **always renders immediately** — warnings surface only as a small **warning icon** on the viewer header (hover to describe each `kind`/selector/detail, click to copy the fix prompt to the clipboard). The user can still send the warnings to you from that popover; they arrive as a chat message starting with **`🧪 Layout audit`**, listing each `kind`, the element selector, and the measured problem.

**When you receive a `🧪 Layout audit` message, treat it like an annotation:** fix the offending layout (constrain widths, wrap/scroll long content, fix positioning) and call `publish_artifact` again with a `note` on what you changed, so the corrected revision re-runs the audit. To avoid warnings in the first place: give the document a sane root width, prefer responsive/flow layouts over fixed pixel widths wider than the frame, and don't absolutely-position text blocks over each other.

### Craft (FLUX-1398) — what makes a mockup actually good

Read this before your **first emit** on a ticket and before every **revision**. These are guidance, not a gate — but the failure modes below (an emoji standing in for an icon, a revision that silently redraws an approved layout, an annotation answered with the wrong fix) are rule-shaped and repeat across sessions:

- **Mock in the app's own visual language** — reuse the real palette, radii, chips, and iconography. Inline SVG icons; never emoji-as-icons.
- **Render at the true target viewport** (e.g. a real ~390px frame for mobile-first), never an idealized wide canvas.
- **Use the same realistic test data across every option**, including worst cases: the longest plausible title, an empty/default item, every status value.
- **When exploring alternatives, show 2–4 options side by side**, each with a one-line thesis and pros/cons, and recommend exactly one with reasons. Keep superseded options visible rather than deleting them.
- **Measure the contested resource** — a px-budget bar, a tap count. A number ("name gets ~85px → ~118px") settles what adjectives can't.
- **Ground every claim in code** — cite file:line for each mockup element, and verify existing affordances (drag/swipe/tap targets) survive the proposal.
- **Open with a chip-list of locked decisions** so reviews don't relitigate settled points.
- **Show interaction states** (pressed, sheet open, hover reveal) — not just a static layout.
- **Every revision answers annotations explicitly** — show the annotated element before → after at the top, and state in the `note` what changed and why. Never silently redesign elements the user already approved.
- **Style-guide lookup** — if `.docs/design/style-guide.md` exists, derive mockup tokens from it rather than re-deriving from source; if it's missing on a UI/UX ticket, see the grooming skill's "Design Style Guide" section for the non-blocking bootstrap offer.

## Ceremony by effort — scale mandated writing to ticket size (FLUX-1382)

Output tokens bill roughly 5x input, so an XS one-line fix paying full L-ticket ceremony (standalone plan comment, full Plan-Discipline writeup, structured completion payload, visual recap) is real, avoidable cost. This table is the **canonical lookup** — the per-section `Skip for: XS/S` footnotes scattered through the grooming/implementation skills remain the detail and rationale; this table just indexes them in one place so the scaling is consistent and easy to find. It does not invent new ceremony or new skip rules beyond what those sections already state.

| Output | XS / S | M | L / XL |
|---|---|---|---|
| TL;DR blockquote | Every size — 1 line | Every size | Every size |
| Problem/Motivation + plan prose | Terse, a sentence or two | Anchored steps (Plan Discipline, scaled) | Full Plan Discipline treatment |
| Standalone implementation plan comment (before coding) | **Skip** — fold into the first activity note or the completion summary | Optional, judgment call | Post before substantial work |
| Acceptance criteria / Recommended Tests / Adversarial self-review / Anchor-to-code / Hard-to-reverse callouts | Skip (each section states its own skip condition) | Situational — apply what's genuinely relevant | Full treatment |
| Structured `completion` payload + Visual Recap artifact | Skip (non-UI) | Judgment call; UI/UX → lean toward emitting | Emit for structurally interesting changes |
| Ready completion summary / `finish` completionComment / "no docs needed because…" line | Present, terse | Present, normal length | Present, full detail |
| Activity notes + faithful `summary` | By event / by note substance, not by effort — same rule at every size | Same | Same |

**Load-bearing at every size — never diet, regardless of effort:**
- `Require Input` questions (with proposed defaults)
- Review verdict + `reviewState` + changes-requested handoff (see the review skill's "reviewState Contract")
- Pinned review/key-decision handoffs
- The End-of-Turn Action Contract (a board action every turn)

These four are marked here precisely because they are the ones a diet-minded agent could mistakenly shrink or skip — they scale in length like everything else above, but never in presence.

## Critical Rules

- **End-of-Turn Action Contract (FLUX-651/826)** — see the dedicated section above; it applies to every phase and every session, chat/discussion turns included.
- NEVER use Write, Edit, or Bash to modify files in `.flux/` or `.flux-store/`. These paths are engine-managed.
- Treat ticket files as schema-sensitive. The engine validates and rejects malformed writes.
- Do not delete ticket history; append only.
- The `finish <ticket>` handoff is required before committing. Commit creation, `implementationLink` update, and status → `Done` happen as one atomic step.
- **Reference docs (`.docs/event-horizon/reference/*`) are kept in sync with code.** If the ticket changes ticket-schema, MCP tools, REST endpoints, realtime channels, or the agent-adapter contract, the matching reference page MUST be updated in the same ticket. Fix the drift; do not file a follow-up.

## End-to-End Checklist

- Ticket read fully — Relevant docs reviewed — Plan comment added (M+; XS/S folds the plan into the first activity/completion note instead — see "Ceremony by effort")
- Grooming produced a concrete plan with filled metadata
- Implementation-critical choices clarified before coding
- Status moved at the right time — Code changed in smallest surface — Validation passed
- **Docs refreshed before `Ready`/`Done` — reference pages match the new behavior, code-map points at any new modules, and the completion comment says either "docs updated: …" or "no docs needed because …"**
- Questions went through `Require Input`, not only chat
- `finish <ticket>` received before commit — Completion comment added — Status → `Done`
