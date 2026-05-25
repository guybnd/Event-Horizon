---
id: FLUX-267
title: 'First-run experience: fix default config and add user name prompt'
status: Released
priority: High
assignee: unassigned
tags:
  - feature
  - bug
effort: M
createdBy: Guy
updatedBy: Agent
implementationLink: aa133e3
history:
  - type: activity
    user: Guy
    date: '2026-05-14T11:27:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-14T11:27:00.000Z'
    comment: >-
      When the compiled exe launches for the first time (no workspace
      configured), the instance loads without any startup/onboarding screen.
      Users land on an empty board with no guidance. Additionally, the default
      board config should include the full set of statuses: Grooming, Todo, In
      Progress, Ready, Done, Archived, Backlog, Released.
    id: c-2026-05-14t11-27-00-000z
  - type: comment
    user: Agent
    date: '2026-05-14T11:33:00.000Z'
    comment: >-
      Grooming complete. The OnboardingWizard (7-step) already exists and works.
      The real issue is that the default configCache in engine/src/config.ts
      only has 3 columns (Todo, In Progress, Done) and hardcodes dev-specific
      users (Guy, Agent). Three changes needed: (1) update default columns to
      full set, (2) make default users empty so the wizard prompts the user for
      their name, (3) add a user name input field to the wizard's step 1
      (workspace step) and pass it through to the config. Keeping project key as
      FLUX for now.
    id: c-2026-05-14t11-33-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-14T11:33:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-14T11:42:00.000Z'
    comment: >-
      Implementation complete. Commit aa133e3: updated default configCache to 6
      visible columns + 2 hidden, removed hardcoded users, added name input to
      wizard step 1, added restart onboarding button in Settings > Preferences.
      Aligned init.ts colors.
    id: c-2026-05-14t11-42-00-000z
  - type: status_change
    from: Todo
    to: Done
    user: Agent
    date: '2026-05-14T11:42:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-25T09:54:03.196Z'
version: v0.8.0
releasedAt: '2026-05-25T09:54:03.196Z'
releaseDocPath: release-notes/v0.8.0
---

New users who install Event Horizon get a default config with only 3 statuses and hardcoded dev-specific user names. The OnboardingWizard exists but doesn't ask for the user's name, so `createdBy`/`assignee` dropdowns are empty (or wrong) until manually configured in Settings.

## Implementation Plan

### 1. Fix default `configCache` in `engine/src/config.ts`

Update the hardcoded `configCache` to match the full workflow:

**Columns (visible):**
- Grooming, Todo, In Progress, Ready, Done, Archived (with appropriate colors)

**Hidden statuses:** Backlog, Released (already correct)

**Users:** `[]` (empty — no hardcoded dev names)

**Tags:** Keep `bug`, `feature`, `docs` as reasonable defaults.

### 2. Add user name field to OnboardingWizard step 1

In `portal/src/components/OnboardingWizard.tsx`, add a "Your name" text input to step 1 (the workspace/welcome step). After `setWorkspace()` succeeds, call `PUT /api/config` to update the config with `users: [{ name: enteredName }, { name: 'Agent' }]`.

### 3. Update `init.ts` defaults to match

Align `buildDefaultConfig()` in `engine/src/init.ts` so the CLI init path produces the same default statuses (it already has them, just verify colors match).

### Files to modify

- `engine/src/config.ts` — default `configCache` columns + users
- `portal/src/components/OnboardingWizard.tsx` — add name input to step 1
- `portal/src/api.ts` — may need to call `saveConfig` with user name after workspace init
- `engine/src/init.ts` — verify/align column colors
