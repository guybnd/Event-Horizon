---
assignee: unassigned
tags:
  - feature
  - ux
priority: Medium
effort: L
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T08:38:15.189Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T16:03:46.285Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. Scope is large (L effort). Key open decision: is the Welcome
      screen a new dedicated route/view added to the nav, or an overlay/modal
      shown automatically on first launch (detected by absence of tasks or a
      localStorage flag)? This affects routing and dismissal logic. A dedicated
      nav tab ("Welcome" or "Get Started") is the simpler approach and can be
      revisited later. The step-by-step ticket flow demo could be a static
      illustrated walkthrough or an interactive guided tour — static is safer
      for L scope. Marking as Require Input for the open UX decision.
    id: c-flux82-groom
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
title: Tutorial & initial setup
status: Require Input
createdBy: Guy
updatedBy: Agent
---

# Goal

A Welcome / Getting Started screen for first-time users that:
1. Prompts them to install the skill into their agentic IDE (with a Settings shortcut button).
2. Shows a typical ticket lifecycle: Create → Groom → Require Input → Groom → Todo → In Progress → Ready → Release.
3. Optionally shows example ticket cards or screenshots at each step.

# Open Question (Require Input)

**How should the Welcome screen be surfaced?**

- **Option A (recommended default):** Add it as a dedicated nav tab ("Get Started" or "Welcome") in the Header nav. Always accessible, not intrusive. User can ignore it.
- **Option B:** Show as a modal/overlay automatically on first load when the board is empty (localStorage flag `flux:welcomed` gates it). Dismissible.
- **Option C:** Both — show modal on first launch, accessible as a nav tab afterward.

**And for the step-by-step demo:**
- **Static illustrated walkthrough** (cards + descriptions per stage) — simpler.
- **Interactive tour** (highlights real board elements) — richer but significantly more complex.

Please confirm preferred approach before implementation starts.

# Proposed Metadata Defaults

- `priority`: Medium
- `effort`: L
- `tags`: feature, ux

# Implementation Plan (pending decision)

Once the surface and demo style are confirmed:

1. Create `portal/src/components/WelcomeScreen.tsx`.
2. Add the "Get Started" nav entry in `Header.tsx` and wire it to the new view in `App.tsx`/routing.
3. Section 1: install skill — button opens Settings, text explains what to do.
4. Section 2: ticket lifecycle — horizontal stepper or vertical card list, one entry per status stage with a short description and optional illustration.
5. If auto-modal (Option B/C): add localStorage gate in `App.tsx`.

# Validation

- Welcome screen accessible from nav.
- Install skill button navigates to Settings.
- All lifecycle stages shown in order.
- No broken routing on direct URL visit.
