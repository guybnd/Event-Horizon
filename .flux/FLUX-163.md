---
assignee: Agent
tags:
  - feature
  - ux
  - portal
  - ui-polish
  - installer
  - onboarding
priority: High
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T08:32:55.255Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-09T08:33:50.389Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-09T08:33:52.440Z'
    comment: Launched Claude Code session (bd309b1c).
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-09T08:36:51.753Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:36:51.754Z'
    comment: >-
      Two questions before locking in the plan:


      1. **Wizard trigger**: Should the onboarding wizard show every time no
      workspace is configured (replacing WorkspaceSelector permanently — meaning
      returning users who change folders also see it), or only on first-ever
      launch (detected via a localStorage flag, after which the simpler
      folder-picker takes over)?


      2. **Install step**: Step 3 is 'make him do the integration'. Should the
      install step be **mandatory** (user must click Install before proceeding),
      or should there be a **Skip for now** escape hatch in case install fails
      or they want to come back to it later?


      Proposed defaults: (1) first-launch only, (2) skippable.
    id: c-2026-05-09t08-36-51-754z
  - type: activity
    user: Agent
    date: '2026-05-09T08:36:57.116Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-09T08:38:48.017Z'
    comment: agreed
    replyTo: c-2026-05-09t08-36-51-754z
    id: c-2026-05-09t08-38-48-017z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-09T08:38:48.017Z'
    comment: Response submitted
  - type: activity
    user: Agent
    date: '2026-05-09T08:38:50.740Z'
    comment: Launched Claude Code session (93dd1008).
  - type: activity
    user: Agent
    date: '2026-05-09T08:41:34.062Z'
    comment: 'Updated tags to feature, ux, portal, ui-polish, installer, onboarding.'
  - type: activity
    user: Agent
    date: '2026-05-09T08:42:27.970Z'
    comment: Updated description.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T08:42:34.547Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:42:34.548Z'
    comment: >-
      Grooming complete. Plan: (1) new OnboardingWizard.tsx component — 5-step
      wizard with step dots, folder picker, CLI card selector (default claude),
      skippable install step, docs screen callout, celebration finish. (2)
      2-line gate in App.tsx before WorkspaceSelector. Triggered by missing
      eh-onboarding-complete localStorage flag on first launch only. Skippable
      at any point. No backend changes needed.
    id: c-2026-05-09t08-42-34-548z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-09T08:42:47.668Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:42:47.669Z'
    comment: >-
      Starting implementation: creating OnboardingWizard.tsx and updating
      App.tsx gate.
    id: c-2026-05-09t08-42-47-669z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T08:44:09.774Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:44:09.775Z'
    comment: >-
      Implementation complete. Created
      portal/src/components/OnboardingWizard.tsx — 5-step first-launch wizard
      (folder picker, CLI selector, skippable install, docs callout,
      celebration). Updated portal/src/App.tsx to gate on eh-onboarding-complete
      localStorage flag before showing WorkspaceSelector. TypeScript compiles
      cleanly. Validation steps: clear localStorage to trigger wizard, complete
      all steps, verify flag is written and board loads.
    id: c-2026-05-09t08-44-09-775z
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T08:44:19.599Z'
    comment: >-
      Implementation is done and ticket is in **Ready**. Here's a summary of
      what was built:


      ---


      **FLUX-163 — New User Onboarding**


      Two files changed:


      - **`portal/src/components/OnboardingWizard.tsx`** (new) — A 5-step wizard
      with animated step dots:
        1. **Pick a project folder** — reuses `pickWorkspaceFolder` + `setWorkspace`, advances on success
        2. **Pick your CLI** — card grid defaulting to Claude Code, same options as Settings Agent tab
        3. **Install the integration** — calls `installWorkspaceSkill`, shows spinner/success; "Skip for now" skips without blocking
        4. **Explore the docs** — "Open the docs" lands on the Docs view; "I'll check later" advances
        5. **You're ready** — celebration screen, "Try your first ticket" button completes setup

        Controlled by `eh-onboarding-complete` localStorage flag; a "Skip setup" link is always visible at the bottom.

      - **`portal/src/App.tsx`** — Added a 2-line gate before the existing
      `WorkspaceSelector` check. Returns `<OnboardingWizard />` when connected
      and the flag is absent; returning users see `WorkspaceSelector` as before.


      To test: open DevTools → Application → Local Storage → delete
      `eh-onboarding-complete` → refresh.
title: new user proper onboarding
status: Ready
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 2204
  outputTokens: 5430
  costUSD: 0.423122
  costIsEstimated: false
---
## Overview

Add a first-launch onboarding wizard that guides brand-new users through the five setup steps before they reach the board. The wizard shows only once (gated by a `eh-onboarding-complete` localStorage flag). After dismissal or completion the existing `WorkspaceSelector` flow takes over for returning users who need to change folders.

---

## Behaviour Contract

- **Trigger**: `localStorage.getItem('eh-onboarding-complete')` is falsy AND `isConnected === true`.
- **Skip/close**: A persistent "Skip setup" link is always visible, jumping the user straight to `WorkspaceSelector` and writing the flag so the wizard never shows again.
- **Completion**: Finishing step 5 writes the flag and transitions to the normal app (calls `notifyWorkspaceSet()` after the workspace step succeeds).
- All five steps live inside a single `OnboardingWizard` component.

---

## Five Steps

### Step 1 — Pick a project folder
Reuse the folder-picking logic from `WorkspaceSelector` (browse button → `pickWorkspaceFolder()`, text input fallback, `setWorkspace()` call). On success, advance to step 2.

### Step 2 — Pick your CLI
Single-choice card grid. Default selected: **Claude Code**. Other options from the same framework list used in Settings Agent Integration tab (Copilot, Cursor, Cline, Windsurf, Gemini, Generic). Selection stored in local component state and passed into the install step.

### Step 3 — Install the integration (skippable)
Show the install button using `installWorkspaceSkill(selectedFramework)`. Display a spinner while installing and a success checkmark on completion. A **Skip for now** link is visible at all times on this step; clicking it records `onboarding-install-skipped: true` in localStorage and advances to step 4.

### Step 4 — Explore the docs
Static card with a brief description of the Docs screen and a **Go to Docs** button. Clicking it: writes the completion flag, transitions to the normal app, then sets view to docs. Also a **Continue** button to advance to step 5.

### Step 5 — You're ready
Celebration screen. Short encouraging copy, a **Try your first ticket** CTA that writes the completion flag, calls `notifyWorkspaceSet()` if workspace is not yet confirmed, and navigates to the board.

---

## Implementation Plan

### 1. New file: `portal/src/components/OnboardingWizard.tsx`

- State: `step` (1–5), `folderPath`, `selectedFramework` (default `'claude'`), `installing`, `installDone`, `installError`, step-level `error`.
- localStorage key written on completion/skip: `eh-onboarding-complete = '1'`.
- Renders a centred card with step indicator dots at top, step content, and Skip link at bottom.
- Styled with existing Tailwind classes from WorkspaceSelector and Settings; no new CSS files.
- Imports from lucide-react: FolderOpen, Rocket, Terminal, BookOpen, PartyPopper, CheckCircle, Loader2, AlertCircle.

### 2. Edit `portal/src/App.tsx`

Add the onboarding gate before the WorkspaceSelector check:

```tsx
const showOnboarding = isConnected && !localStorage.getItem('eh-onboarding-complete');
if (showOnboarding) return <OnboardingWizard />;
if (!workspaceConfigured && isConnected) return <WorkspaceSelector />;
```

### 3. No backend changes needed

All new behaviour is purely frontend. The installer API and workspace API are already in place.

---

## Validation

1. Clear localStorage, hard-refresh → wizard appears.
2. Complete all 5 steps → board loads, wizard never reappears on refresh.
3. Click "Skip setup" on any step → WorkspaceSelector appears, wizard never reappears.
4. On step 3, click "Skip for now" → advances to step 4 without error.
5. Returning user (flag set) → WorkspaceSelector shows directly, no wizard.
6. Engine offline → neither wizard nor WorkspaceSelector blocks the UI (existing isConnected guard).

---

## Files Changed

- `portal/src/components/OnboardingWizard.tsx` (new)
- `portal/src/App.tsx` (2-line gate change)
