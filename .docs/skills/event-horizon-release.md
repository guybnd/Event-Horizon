---
title: Event Horizon Release
order: 4
---
> ⚠️ DO NOT DELETE — Required for release orchestration.

## Phase: Release Orchestration

---

# Event Horizon Agent — Release Skill

Version: 2.4.0

## When This Skill Applies

Load when the user asks to create a release or run a release.

## Release Workflow

1. Determine version (e.g. `v1.2.0`). If not provided, propose one based on semantic versioning.
2. Summarize what's in `Done` status and confirm ready for release.
3. Run `npm run flux:release <version>` in `engine/`. This gathers Done tickets, generates release notes in `.docs/`, and moves tickets to `Released`.
4. Review generated release notes; adjust if needed.
5. Create a git commit immediately (e.g. `Release <version>`).
6. Notify the user: tickets released, committed, point to release notes.
