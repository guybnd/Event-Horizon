---
id: FLUX-1
title: >-
  Workspace binding: active workspace can be removed-but-still-active; boot flag
  silently overrides UI choice
status: Grooming
priority: High
effort: M
assignee: unassigned
tags:
  - engine
  - portal
  - multi-workspace
  - ux
  - reliability
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-08-22T04:51:02.477Z'
    comment: Created ticket.
---
> **TL;DR** Two related defects in workspace binding that make the engine silently contradict the user's UI actions: (1) removing the ACTIVE workspace from the registry leaves it active but unlisted — an inconsistent state the portal "resurrects" on refresh/boot; (2) a `--workspace` CLI flag re-pins the workspace on every boot, permanently beating `lastWorkspace` (the UI choice) with zero trace in the UI. Define removal semantics for the active workspace, make the flag a one-time selection that writes `lastWorkspace`, and surface the binding source in Settings.

## Problem / Motivation (hit live, 2026-08-22)

Observed state after the user removed the non-dev workspace in the portal:

- `GET /api/health` → `workspace: "/home/guy/Event-Horizon"` (active)
- `GET /api/workspaces` → only `/home/guy/EventHorizon-dev` listed; the ACTIVE workspace absent

The engine was launched with `--workspace ..` (hardcoded in the dev script). Boot resolution (`engine/src/index.ts`, `candidates` array ~line 715) tries `--workspace` → `lastWorkspace` → `cwd` → sole-registered, first valid wins — so the flag beats the UI's `lastWorkspace` every boot, and `autoRegisterWorkspace` re-adds the removed workspace to the registry. To the user: "I removed it and on refresh it comes back." No surface anywhere explains why.

Even without the flag, the first defect stands alone: the registry-removal path does not consider whether the workspace being removed is the active one, so it produces active-but-unregistered — a state no other part of the system expects (e.g. the FLUX-705/712 recovery fallbacks reason over the registry).

## Proposed shape

1. **Removal of the active workspace gets explicit semantics.** Pick one and implement consistently across the portal Settings surface and the workspaces API:
   - *Refuse with guidance*: "This is the active workspace — switch to another workspace first." (simplest, safe default), OR
   - *Switch-then-remove atomically*: activate another open workspace if exactly one exists, else drop to the unbound state (portal shows the picker), then remove.
   Never allow active-but-unregistered to exist after the operation.
2. **`--workspace` becomes a one-time selection, not a permanent pin.** When the flag is present and valid at boot, write it to `lastWorkspace` (same code path as a UI switch). Resolution order collapses to "last explicit choice wins, however expressed (flag or UI)". A stale flag in a wrapper script then bites once, not on every refresh/restart, and a subsequent UI switch durably wins.
3. **Surface the binding source.** `/api/health` (or `/api/workspace`) gains a `workspaceSource: 'flag' | 'remembered' | 'cwd-fallback' | 'registry-fallback'` field; portal Settings shows it ("Workspace pinned by launch flag" etc.), so an override is visible instead of mystifying.

## Acceptance criteria

- [ ] After any remove operation, the active workspace is always present in `GET /api/workspaces` — active-but-unregistered is unrepresentable (guarded by a test on the removal route).
- [ ] Removing the active workspace either refuses with an actionable error or atomically switches per the chosen semantics; portal shows the corresponding UX (disabled control with tooltip, or confirm dialog naming the switch target).
- [ ] Booting with `--workspace X` then switching to Y in the UI, then restarting WITHOUT the flag → engine binds Y. Restarting WITH the flag → binds X but a UI switch afterwards durably wins the next flagless boot.
- [ ] Binding source is reported over the API and visible in Settings.
- [ ] Existing FLUX-705/FLUX-712 recovery behaviors (lost `lastWorkspace`, ambiguous registry) are preserved — covered by existing/extended tests.
- [ ] `npm run check` passes.

## Risks / notes

- The EventHorizon dev repo's own `engine/package.json` dev scripts hardcode `--workspace ..`; after change (2) that stops fighting the UI. Deciding whether to also remove the hardcoding is dev-repo hygiene, out of scope here.
- Multi-workspace (FLUX-1452 live-workspace iteration, S1 registry) reasons over the registry — audit those consumers for assumptions that active ∈ registry when implementing (1).
- Related in theme: FLUX-1686 (gh availability self-heal) — both are "engine state silently contradicts what the user sees/did"; no code dependency.
