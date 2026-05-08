---
assignee: unassigned
tags:
  - workflow
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:10:51.462Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T15:30:00.000Z'
    comment: >-
      Groomed. Problem: groomed ticket bodies currently only capture the
      implementation plan — what to do and how. They omit the "why": what
      problem the ticket solves, who it benefits, and the reasoning behind the
      approach. A user reading the board can't tell why a ticket exists or why
      it was prioritised without digging into chat history. Fix: update step 6
      in grooming.md and the matching line in event-horizon-copilot-instructions.md
      to require that groomed ticket bodies open with a Problem section (1-2
      sentences on the motivation and user value) before the implementation
      plan. Moving to In Progress.
    id: c-flux111-groom
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T15:30:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T15:35:00.000Z'
    comment: >-
      Done. Updated grooming.md step 6 to require a Problem / Motivation
      section before the implementation plan in all groomed ticket bodies.
      Updated the matching line in event-horizon-copilot-instructions.md and
      both instances in copilot-instructions.md. No code changes — docs only.
    id: c-flux111-done
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T15:35:00.000Z'
id: FLUX-111
title: improve grooming instructions
status: Done
createdBy: Guy
updatedBy: Agent
---

## Problem

Groomed ticket bodies focus only on the implementation plan — what to change and how. They omit the "why": what user problem the ticket addresses, who benefits, and the reasoning behind the approach chosen. A user reviewing the board sees a wall of implementation notes with no indication of why the work matters or how it was prioritised.

## Goal

Update the grooming skill instructions so that every groomed ticket body opens with a short **Problem / Motivation** paragraph before the implementation detail. This gives users and future agents immediate context on the value and rationale of the work.

## Changes

- `.github/skills/event-horizon/grooming.md` — extend step 6 to require a Problem / Motivation section in the ticket body, followed by the implementation plan.
- `.flux/skills/event-horizon-copilot-instructions.md` — update the matching grooming documentation expectation line.

## Validation

Groom a test ticket and confirm the body includes a problem statement and user value before the plan section.
