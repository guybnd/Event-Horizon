---
title: Event Horizon Grooming
order: 2
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.4.0

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
