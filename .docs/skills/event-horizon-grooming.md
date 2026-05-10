---
title: Event Horizon Grooming
order: 2
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.0.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.

## Grooming Workflow

1. Read the full ticket, including all history comments and status changes.
2. Read the relevant docs to understand scope and touchpoints before editing. Start with `.docs/`, then `README.md`, then `.docs/skills/*.md` when the task touches workflow behaviour or installer output.
3. Treat `Grooming` as a planning phase, not implied permission to code. Review the ticket body, capture likely touchpoints and intended validation, review the applicable ticket metadata, and fill anything that is already inferable from the current context.
4. Applicable metadata fields to review and fill: `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when they matter for the work.
5. If implementation-critical choices or applicable metadata values are unresolved, do not silently pick a direction. Leave one explicit question in ticket history and include the proposed fill values or defaults for the missing fields — **and in the same API call set `"requireInput": true`** in the `PUT /api/tasks/:id` payload. The engine will atomically transition the ticket to the configured user-input status. **[HARD GATE] Never post a question as a history comment without also sending `"requireInput": true` in the same request. A history comment ending in `?` without a concurrent status transition to `Require Input` is a grooming failure. The engine enforces this: a `PUT` that sets status to `Require Input` without a new `comment` entry in `history` is rejected with `REQUIRE_INPUT_MISSING_COMMENT`.**
6. **[MANDATORY] Rewrite the ticket body into a self-contained implementation plan.** The body IS the plan — not a history comment, not a chat message, not a text response to the user. Use `PUT /api/tasks/:id` with a `body` field to update the body via the API. Another agent must be able to pick up this ticket and implement it without any re-discovery. Writing the plan only as a chat message or history comment is a grooming failure.
7. **[HARD GATE] Do not move the ticket to `Todo` until step 6 is complete.** Verify the ticket body has been rewritten before setting `Todo`. A body that still reads as the original user-typed description means grooming is not finished.
8. Move the ticket to `Todo` when grooming is complete and the body has been rewritten.

## Ticket Metadata Conventions

- `priority`: fill based on user impact and urgency — `None`, `Low`, `Medium`, `High`, `Critical`
- `effort`: T-shirt estimate — `None`, `XS`, `S`, `M`, `L`, `XL`
- `tags`: use existing project tags from `.flux/config.json`; propose new ones only when clearly distinct
- `assignee`: set if the user has indicated ownership; leave `unassigned` otherwise
- `subtasks`: use for large tickets that break naturally into tracked sub-items

## Editing Conventions

- Preserve YAML validity in ticket frontmatter.
- Use spaces, not tabs, in YAML frontmatter. Tab indentation in `history`, lists, or nested fields can make a ticket disappear from the board.
- Keep `updatedBy` accurate for the last actor.
- Do not delete history; append new entries instead.
- Promote durable behaviour changes into the nearest project docs instead of leaving context only in ticket history.

## Ticket File Safety

- Treat `.flux/*.md` edits as schema-sensitive changes, not casual markdown edits.
- Keep the frontmatter block at the top of the file between the opening and closing `---` markers.
- When adding `history` entries, preserve YAML list indentation exactly with spaces.
- Do not place non-ticket assets under paths that the engine indexes as tasks.
- After editing a ticket file, verify that the ticket still parses through the system. Prefer checking the live task list or API payload over assuming the markdown file is valid.
- If a ticket disappears after editing, suspect malformed frontmatter first.

## Text Output vs Ticket Body

These are two distinct operations that must not be confused:

- **Text output to the user** — what you write as a chat/response message. This may be visible in the session panel but is NOT saved to the ticket body.
- **Ticket body update** — an explicit API call (`PUT /api/tasks/:id` with a `body` field). This is the only operation that rewrites the plan into the ticket.

Both must happen during grooming, but they are separate steps. Sending a chat message about the plan does not update the ticket body.

## Comment Conventions for Grooming

- Keep comments factual and short.
- When asking for input, end with a concrete question and proposed default if one exists.
- Record decisions, open questions, and rationale for metadata choices.
- Prefer comments that help the next agent continue without re-discovery.
