---
assignee: Agent
tags:
  - portal
  - ux
priority: Medium
effort: S
implementationLink: 4c578d5
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-12T03:34:08.612Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-12T04:00:46.624Z'
    comment: Launched Claude Code session (599c4b8e).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T04:02:06.607Z'
  - type: activity
    user: Agent
    date: '2026-05-12T04:02:06.607Z'
    comment: >-
      Updated description. Changed assignee from unassigned to Agent. Updated
      tags to portal, ux. Changed priority from None to Medium. Changed effort
      from None to S.
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:02:44.555Z'
    comment: >-
      Grooming complete. Here's the plan for FLUX-213:


      **New wizard step added between step 1 (folder) and step 2 (AI
      assistant):**

      - Two clickable cards — **In-Repo** (`.flux/`, simple, no git setup,
      tickets show in history) vs **Git Sync** (orphan `flux-data` branch,
      tickets isolated from code history, multi-machine sync via push/pull)

      - Each card shows pros, cons, and a "best for" blurb

      - Default is In-Repo; selecting Git Sync and clicking Continue triggers
      `migrateStorage()` with a spinner + inline error fallback

      - Total wizard steps bumps from 6 → 7


      Only file to touch: `portal/src/components/OnboardingWizard.tsx`. Ticket
      is now `Todo`.
  - type: activity
    user: Agent
    date: '2026-05-12T04:02:44.558Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T04:09:03.266Z'
    comment: Launched Claude Code session (70f30199).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-12T04:10:02.945Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T04:12:15.095Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:12:21.335Z'
    comment: >-
      Implementation is done. Here's a summary of what changed in
      `portal/src/components/OnboardingWizard.tsx`:


      - **New step 2 — "Choose your storage mode"** inserted between the folder
      picker (step 1) and the AI assistant picker (now step 3).

      - Two clickable cards: **In-Repo** (HardDrive icon, default, selected) and
      **Git Sync** (GitBranch icon) — each with bullet pros/cons and a "Best
      for" line.

      - "Continue →" on In-Repo advances immediately; on Git Sync it calls
      `migrateStorage()` with a spinner and shows an inline error + fallback
      link if it fails.

      - `StepDots total` bumped 6 → 7. All downstream step conditions and
      `setStep()` calls shifted up by 1 accordingly.

      - New imports: `GitBranch`, `HardDrive` from lucide-react, and
      `migrateStorage` from `../api`.

      - TypeScript compiles with no errors.
  - type: activity
    user: Agent
    date: '2026-05-12T04:12:21.352Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T04:16:00.605Z'
  - type: activity
    user: Agent
    date: '2026-05-12T04:16:00.655Z'
    comment: Launched Claude Code session (59fb7ef3).
  - type: comment
    user: Agent
    comment: >-
      ## UX Review — Issues Found


      **1. [Broken affordance] "Switch to In-Repo and continue" does not
      actually continue**


      The click handler on the error-state fallback button (line 344) only calls
      `setSelectedMode('in-repo'); setModeError(null)`. It clears the error and
      switches the selection but does NOT advance to step 3. The label says
      "...and continue" — users who hit a migration failure will click it
      expecting to be moved along, then find themselves back on the selection
      screen still needing to press "Continue →". This breaks the mental model
      the label establishes.


      Fix: either wire the handler to also call `setStep(3)` (making the label
      accurate), or rename the label to "Switch to In-Repo" and let the user
      click Continue themselves.


      **2. [Minor inconsistency] Continue button missing
      `disabled:cursor-not-allowed`**


      Step 1's submit button includes both `disabled:cursor-not-allowed` and
      `disabled:opacity-50` (line 261). The step 2 Continue button only has
      `disabled:opacity-50` (line 355) — the cursor does not change while
      `migrateStorage()` is in flight. Fix: add `disabled:cursor-not-allowed` to
      match the rest of the wizard.


      **3. [Accessibility] Mode cards have no ARIA selected-state**


      The two cards behave as radio buttons (mutually exclusive, persistent
      selection) but are plain `<button>` elements with no `role`,
      `aria-checked`, or `role="radiogroup"` on the wrapper. Screen readers
      cannot distinguish which card is currently selected. Note: the step 3
      framework picker has the same pattern, so this is consistent within the
      file — but both steps share the gap. A minimal fix is adding
      `aria-pressed={selectedMode === 'in-repo'}` and
      `aria-pressed={selectedMode === 'orphan'}` to each card button.


      Issue #1 is a must-fix before shipping. Issues #2 and #3 are minor polish.
    date: '2026-05-12T04:17:26.396Z'
    id: c-2026-05-12t04-17-26-396z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:17:32.529Z'
    comment: >-
      Review posted and ticket moved back to **In Progress**. Here's a summary
      of what I found:


      ---


      **Issue 1 — Broken affordance (must fix)**

      The "Switch to In-Repo and continue" button inside the migration error
      state (line 344) only resets the selection — it doesn't advance to step 3.
      The label promises "...and continue" but the handler is
      `setSelectedMode('in-repo'); setModeError(null)`. Users who hit a
      migration failure will click this expecting to be moved forward and
      instead find themselves back on the same screen. Fix: either add
      `setStep(3)` to the handler (making the label true), or rename the button
      to "Switch to In-Repo" and require a second click on "Continue →".


      **Issue 2 — Minor inconsistency**

      The Continue button (line 355) has `disabled:opacity-50` but is missing
      `disabled:cursor-not-allowed` that every other wizard button uses. Trivial
      fix.


      **Issue 3 — Accessibility gap**

      Both mode cards and the step 3 framework cards behave as radio buttons but
      have no `aria-pressed`, `role="radio"`, or `role="radiogroup"`. Screen
      readers see two unlabeled buttons with no selected state. Adding
      `aria-pressed` to each card is a minimal fix.
  - type: activity
    user: Agent
    date: '2026-05-12T04:17:32.532Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T04:19:04.618Z'
    comment: Launched Claude Code session (886d7889).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T04:20:02.212Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:20:09.147Z'
    comment: >-
      Ticket FLUX-213 is now in **Ready** status. Here's a summary of the three
      fixes applied to `OnboardingWizard.tsx`:


      1. **"Switch to In-Repo and continue" now actually continues** — the
      error-state fallback button now calls `setStep(3)` alongside resetting the
      mode, so users aren't left stranded on the selection screen after a
      migration failure.


      2. **Continue button cursor fixed** — added `disabled:cursor-not-allowed`
      to match the rest of the wizard's disabled button styling.


      3. **ARIA accessibility** — both mode card buttons now have `aria-pressed`
      so screen readers can announce which card is currently selected.
  - type: activity
    user: Agent
    date: '2026-05-12T04:20:09.155Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T04:20:21.413Z'
    comment: Launched Claude Code session (c4cde69b).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-12T04:20:59.202Z'
  - type: activity
    user: Agent
    date: '2026-05-12T04:20:59.202Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:21:02.919Z'
    comment: >-
      FLUX-213 is Done. Commit `4c578d5` — "Add sync mode selection step to
      onboarding wizard" — is on master with the sync mode selection step
      shipped and the ticket closed.
  - type: activity
    user: Agent
    date: '2026-05-12T04:21:02.923Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-12T07:32:59.619Z'
title: add a nice window in the intro explaining the sync modes
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 2553076
  outputTokens: 24373
  costUSD: 1.760654
  costIsEstimated: false
  cacheReadTokens: 2372555
  cacheCreationTokens: 176146
---
## Implementation Plan

### Goal
Insert a new wizard step in `OnboardingWizard.tsx` after the folder-open step (step 1) that lets the user understand and choose between the two storage modes before proceeding.

### Two Modes to Explain
- **In-Repo** (`.flux/`): tickets live in the project repo alongside your code. Simple, no extra git setup, works out of the box. Downside: ticket history appears in your code commits.
- **Git Sync / Orphan** (`.flux-store/` on a `flux-data` orphan branch): tickets live on a separate branch, never touching your main commit graph. Enables multi-machine sync via `git push/pull`. Requires a git repo; migration can be done at any time from Settings.

### Scope
1. Add a new step between current step 1 (folder) and step 2 (AI assistant). Total steps bumps from 6 → 7. Update `StepDots total` accordingly.
2. The step renders two mode cards side-by-side (or stacked on small screens) — one for In-Repo and one for Git Sync — each with an icon, name, bullet pros/cons, and a "best for" line.
3. Default selection is `in-repo`. User can click a card to select it.
4. On "Continue →": if `orphan` was selected, call `migrateStorage()` (show spinner + error handling) then advance. If `in-repo`, advance immediately (no API call needed).
5. If `migrateStorage()` fails (e.g. no git remote), show an inline error explaining the cause and allow the user to fall back to In-Repo or retry.

### Files to Touch
- `portal/src/components/OnboardingWizard.tsx` — add new step JSX block and state; bump total step count from 6 → 7; adjust `setStep` calls.
- No engine changes needed — `migrateStorage()` API is already wired up.

### Validation
- Render the wizard (dismiss and re-open via clearing `localStorage[eh-onboarding-complete]` in DevTools).
- Verify step dots show 7 steps.
- Verify both mode cards render with prose.
- Select Git Sync, click Continue — observe spinner and mode switch (or graceful error if no git remote).
- Select In-Repo, click Continue — observe immediate advancement to step 3.
- Verify skipping via global "Skip setup" still works.
