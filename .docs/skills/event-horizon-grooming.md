---
title: Event Horizon Grooming
order: 2
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.1.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Grooming Workflow

1. Read the full ticket, including all history.
2. Read `.docs/INDEX.md` to identify relevant docs, then read only those files. Skip docs entirely for XS/S effort tickets.
3. Treat `Grooming` as a planning phase — do not code. Tighten the ticket body into a concrete plan, fill inferable metadata (`priority`, `effort`, `tags`, hierarchy links).
4. If implementation-critical choices are unresolved, move to `Require Input`, post one question with proposed defaults in ticket history, and wait.
5. Once resolved, rewrite the ticket body with:
   - **Problem / Motivation** (1–3 sentences): what problem, who benefits, why prioritised.
   - **Implementation plan**: concrete steps so another agent could pick up without re-discovery.
6. Move to `Todo` when grooming is complete. **CRITICAL: Stop execution after moving to Todo — do not begin implementation.**

## Metadata Conventions

- `priority`: `None` | `Low` | `Medium` | `High` | `Critical`
- `effort`: `None` | `XS` | `S` | `M` | `L` | `XL`
- `tags`: use existing tags from `.flux/config.json`; propose new ones only when clearly distinct
- `assignee`: set if user indicated ownership; leave `unassigned` otherwise

## Editing & Safety

- Preserve YAML validity. Spaces only (no tabs) in frontmatter — tabs can make tickets disappear.
- Keep `updatedBy` accurate. Do not delete history; append only.
- After editing a ticket file, verify it still parses through the system.

## Comment Conventions

- Keep comments factual and short. End input requests with a concrete question and proposed default.
- Prefer comments that help the next agent continue without re-discovery.
