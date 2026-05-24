---
priority: Medium
effort: M
tags:
  - dx
  - ux
  - architecture
assignee: unassigned
createdBy: Unknown
title: 'Design testing strategy, validation UX, and diff visibility for tickets'
status: Backlog
updatedBy: Guy
history:
  - type: activity
    user: Unknown
    date: '2026-05-11T01:39:09.281Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Backlog
    user: Guy
    date: '2026-05-24T13:26:19.574Z'
order: 2
---
## Goal

Design a cohesive testing and validation strategy that covers three distinct concerns:

1. **Testing Event Horizon itself** — engine API, portal UI, and adapter layer (prerequisite for FLUX-182)
2. **Testing interface for project developers** — how users of Event Horizon on their own codebases should think about test gates, CI integration, and the agent reporting validation results
3. **Ticket-level validation UX** — how test results, affected files, and diffs are surfaced in the ticket modal and board

This is a planning-only ticket. Output is a concrete spec that feeds into follow-on implementation tickets.

---

## Open Questions to Resolve

### 1. Test suite approach for Event Horizon itself

- What is the right test framework for the engine? (Vitest, Jest, plain Node test runner)
- Integration tests against a live engine with fixture .flux/ data vs unit tests with mocked file system?
- What is the minimal suite that meaningfully covers the FLUX-182 refactor risk? (Proposed: tsc --noEmit + ~6 critical API route integration tests + CLI session mock adapter smoke test)
- How should the portal be tested? TypeScript compile + component rendering, or full E2E (Playwright)? Is E2E worth the maintenance cost at current scale?

### 2. Testing interface for project developers

- Should the agent have a first-class way to run the project's test suite and record results against a ticket?
- Should a failing test block the `finish <ticket>` handoff? Or just be recorded?
- What is the right primitive: a `testCommand` field in `.flux/config.json` that the agent runs before marking a ticket Ready/Done?
- How does this work for projects where tests are slow or require external services?

### 3. Validation checklist UX in the ticket

- Add a structured `validation` section to the ticket data model — a checklist of items the agent (or human) marks off before closing.
- Who populates the checklist? Options: agent fills during grooming, agent checks off autonomously, human confirms.
- Should there be a dedicated Testing board column (between Ready and Done) for tickets awaiting automated validation?
- Should unchecked validation items visually block the Done transition in the UI, or just warn?

### 4. Affected files and diff visibility

- `implementationLink` already points to a commit — the diff is one click away. Is inline diff display worth the bulk?
- Lighter alternative: flat list of affected file paths (derivable from commit). Useful for review without noise.
- Heavier alternative: expandable inline diff panel, loaded on demand.
- Should affected files be stored in ticket frontmatter (agent-populated during finish) or always derived live from the commit?
- For in-progress tickets without a commit yet, agent could maintain a running `affectedFiles` list as it edits.

---

## Constraints

- Any validation UX must work for both autonomous agent runs and human-only workflows
- Ticket data model changes must remain backwards-compatible (new fields optional, defaulting gracefully)
- Keep the board simple — avoid adding columns that only matter for a subset of projects

---

## Expected Output

- Recommended test framework and minimal suite spec (feeds FLUX-182 prerequisite)
- Decision on testCommand config field and agent-run validation flow
- Spec for validation checklist field in ticket model
- Decision on affected files / diff display approach
- List of follow-on implementation tickets to create
