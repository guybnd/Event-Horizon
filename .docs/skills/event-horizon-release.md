---
title: Event Horizon Release
order: 5
delivery: [pull-only, concatenated, modular]
deliveryNote: "🚚 pull-only for Claude — reached only via read_skill('release'), never auto-injected · concatenated into gemini/cursor/antigravity/windsurf/generic installs · installed per-file for copilot/cline (modular, on-demand)."
---
> ⚠️ DO NOT DELETE — Required for release orchestration.

## Phase: Release Orchestration

---

# Event Horizon Agent — Release Skill

Version: 2.5.0

## When This Skill Applies

Load when the user asks to create a release or run a release.

## Release Workflow

1. Determine version (e.g. `v1.2.0`). If not provided, propose one based on semantic versioning. Either `1.2.0` or `v1.2.0` is accepted — the script normalizes internally (FLUX-1317), so you don't have to match a prefix convention by hand.
2. Summarize what's in `Done` status and confirm ready for release.
3. Run `npm run flux:release <version>` in `engine/`. This gathers Done tickets, generates release notes in `.docs/`, appends a one-line-per-ticket block (with completion gist) to the canonical `<releaseNotesPath>/INDEX.md`, moves tickets to `Released`, and — since **FLUX-1317** — bumps the `version` field in the root/engine/portal `package.json` to the bare semver (all release artifacts stay `v`-prefixed; only `package.json` is bare). A non-semver arg skips the `package.json` bump with a warning but still writes notes and releases tickets. No separate manual version bump is needed.
4. Review generated release notes; adjust if needed.
5. Create a git commit immediately (e.g. `Release <version>`) — it captures the released-ticket files, generated notes, and the `package.json` bumps from step 3.
6. Notify the user: tickets released, committed, point to release notes.
