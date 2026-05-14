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
3. Treat `Grooming` as a planning phase, not implied permission to code. Tighten the ticket body into a concrete plan, capture likely touchpoints and intended validation, review the applicable ticket metadata, and fill anything that is already inferable from the current context.
4. Applicable metadata fields to review and fill: `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when they matter for the work.
5. If implementation-critical choices or applicable metadata values are unresolved, do not silently pick a direction. Move the ticket to the configured user-input status (`requireInputStatus` in `.flux/config.json`, default `Require Input`), leave one explicit question in ticket history, include the proposed fill values or defaults for the missing fields, and wait for the answer.
6. Once all choices are resolved, rewrite the ticket body with two sections in order:
   - **Problem / Motivation** (1–3 sentences): explain what user problem or pain point this ticket addresses, who benefits, and why it was prioritised. This gives any reader — human or agent — immediate context on why the work matters, not just what to do.
   - **Implementation plan**: the concrete steps, files, and approach so another agent could pick up the work without re-discovery.
7. Move the ticket to `Todo` when grooming is complete. **CRITICAL: Once the ticket is moved to `Todo`, you MUST immediately stop execution and wait for further instructions from the user. Do not transition straight to `In Progress` or begin implementation.**

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

## Comment Conventions for Grooming

- Keep comments factual and short.
- When asking for input, end with a concrete question and proposed default if one exists.
- Record decisions, open questions, and rationale for metadata choices.
- Prefer comments that help the next agent continue without re-discovery.
