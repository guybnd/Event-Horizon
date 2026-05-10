---
assignee: unassigned
tags:
  - onboarding
  - ux
  - installer
  - devx
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T05:07:09.229Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T05:07:11.492Z'
    comment: Launched Claude Code session (e592eb8f).
  - type: comment
    user: Agent
    date: '2026-05-10T05:08:47.230Z'
    comment: >-
      Grooming analysis: The request is to add the event-horizon binary to the
      system PATH during onboarding so users can run it from any terminal. Key
      findings: (1) Multiple-instance concern is a non-issue — the binary is
      global, projects are just workspaces passed via --workspace flag. One PATH
      entry covers all projects. (2) Two distinct user populations exist: pkg
      binary users (downloaded mac/win executables) who must manually locate the
      binary, and npm global install users who already have PATH handled by npm.
      (3) Two implementation approaches are viable: (A) Automatic — engine
      appends to ~/.zprofile or ~/.zshrc on macOS, uses SETX on Windows during
      init or onboarding; (B) Instructional — onboarding wizard shows a copyable
      shell snippet the user runs themselves. Automatic is more magical but
      invasive and shell-detection-sensitive; instructional is safer and more
      transparent. Leaving a question on approach before planning the
      implementation.
    id: c-2026-05-10t05-08-47-230z
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-10T05:08:55.779Z'
  - type: activity
    user: Agent
    date: '2026-05-10T05:08:55.779Z'
    comment: >-
      Updated tags to onboarding, ux, installer, devx. Changed priority from
      None to Low. Changed effort from None to S.
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T05:09:00.455Z'
    comment: >-
      Ticket is now in **Require Input**. Here's the design question I need your
      call on:


      ---


      **How should the onboarding wizard handle PATH setup?**


      **A — Instructional (recommended):** A new onboarding step shows a
      copyable shell command the user runs themselves to add the binary to their
      PATH. No automatic modification of shell config files.


      **B — Automatic:** During `init` or onboarding, the engine auto-appends to
      `~/.zprofile`/`~/.zshrc` on macOS and runs `SETX` on Windows without
      asking.


      **On the multiple-instance question:** Not an issue. The binary is global
      — projects are just workspaces selected at startup. One PATH entry covers
      every project.


      I'd recommend (A) — it's cross-shell safe, transparent, and avoids
      touching files the user may have carefully curated. What's your
      preference?
  - type: comment
    user: Guy
    date: '2026-05-10T05:12:44.719Z'
    comment: >-
      can we have both options and let the user select inm the onboarding how he
      wish to proceed, or to skip entirely
    replyTo: c-2026-05-10t05-08-47-230z
    id: c-2026-05-10t05-12-44-694z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-10T05:12:44.719Z'
    comment: Response submitted
  - type: activity
    user: Agent
    date: '2026-05-10T05:12:52.026Z'
    comment: Launched Claude Code session (07c23365).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T05:14:47.087Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:14:47.088Z'
    comment: >-
      Grooming complete. Plan: Add a PATH setup step (step 4 of 6) to the
      OnboardingWizard. The step offers 3 choices: (1) Automatic — engine writes
      the binary dir to ~/.zprofile on macOS or HKCU Environment on Windows; (2)
      Instructional — shows a copyable shell snippet the user runs themselves;
      (3) Skip. Engine gets two new endpoints: GET /api/path-info returns
      {binaryDir, isPkg, platform} and POST /api/path-setup executes the
      automatic write. Portal gets fetchPathInfo() and setupPath() in api.ts.
      Wizard total steps goes from 5 to 6.
    id: c-2026-05-10t05-14-47-088z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T05:15:20.219Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:15:20.220Z'
    comment: >-
      Starting implementation. Adding engine endpoints, API functions, and
      wizard step.
    id: c-2026-05-10t05-15-20-220z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T05:17:15.120Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:17:15.121Z'
    comment: >-
      Implementation complete. Changes: (1) engine/src/index.ts — added GET
      /api/path-info (returns binaryDir, isPkg, platform) and POST
      /api/path-setup (auto writes to ~/.zprofile on macOS / ~/.profile on Linux
      / Windows user PATH via PowerShell, or returns copyable snippet in
      instructional mode with idempotency check). (2) portal/src/api.ts — added
      fetchPathInfo() and setupPath() functions. (3)
      portal/src/components/OnboardingWizard.tsx — inserted step 4 of 6 'Add to
      PATH' with three options: Add automatically, Show me the command, Skip.
      Non-pkg (npm global) users see a 'already in PATH' notice. Step dots total
      updated from 5 to 6, old step 4/5 renumbered to 5/6. Portal TypeScript
      clean.
    id: c-2026-05-10t05-17-15-121z
  - type: activity
    user: Agent
    date: '2026-05-10T05:17:34.990Z'
    comment: Launched Claude Code session (0b4e8674).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T05:18:29.471Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:18:29.472Z'
    comment: >-
      Implementation complete. Added GET /api/path-info and POST /api/path-setup
      to engine/src/index.ts. Added fetchPathInfo() and setupPath() to
      portal/src/api.ts. Inserted step 4 of 6 in OnboardingWizard.tsx with
      auto/instructional/skip options; non-pkg users see an 'already in PATH'
      notice. Steps 4/5 renumbered to 5/6. Committed as dcd35bc.
    id: c-2026-05-10t05-18-29-472z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T05:18:40.872Z'
    comment: >-
      FLUX-166 is done. Commit `dcd35bc` ships the PATH setup step — engine
      endpoints, portal API functions, and the new wizard step 4 of 6 with
      auto/instructional/skip options.
  - type: activity
    user: Agent
    date: '2026-05-10T06:08:07.555Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.933Z'
title: Add project CLI commands to PATH during onboarding
status: Released
createdBy: Guy
updatedBy: Agent
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.933Z'
releaseDocPath: release-notes/v0.3.0
---
## Add PATH Setup Step to Onboarding Wizard

Add a new step 4 of 6 to the OnboardingWizard that lets users configure PATH for the `event-horizon` binary. The step presents three choices and the user can pick one or skip.

### Touchpoints

- `engine/src/index.ts` — two new API endpoints
- `portal/src/api.ts` — two new API functions
- `portal/src/components/OnboardingWizard.tsx` — new step 4, step count updated to 6

### Engine Changes

**GET /api/path-info**
Returns:
```json
{ "binaryDir": "/path/to/dir", "isPkg": true, "platform": "darwin" }
```
`binaryDir` is `path.dirname(process.execPath)` when running as a pkg binary, else `null` (npm global installs already have PATH set by npm).

**POST /api/path-setup**
Body: `{ "mode": "auto" | "instructional" }` (instructional is a no-op, just returns the snippet).
Returns: `{ "ok": true, "snippet": "export PATH=..." }` or error.

Auto mode:
- macOS: appends `export PATH="<binaryDir>:$PATH"` to `~/.zprofile` (creates if absent)
- Windows: runs PowerShell `[Environment]::SetEnvironmentVariable('Path', ..., 'User')`
- Linux: appends to `~/.profile`

### Portal Changes

`portal/src/api.ts`:
- `fetchPathInfo(): Promise<{ binaryDir: string | null; isPkg: boolean; platform: string }>`
- `setupPath(mode: 'auto' | 'instructional'): Promise<{ ok: boolean; snippet: string }>`

### Wizard Step 4

After the skill install step (step 3), before the docs step (step 5):

- Heading: "Add to PATH"
- Description: "Run `event-horizon` from any terminal without typing its full path."
- Three option cards:
  1. **Add automatically** — engine writes to shell config / Windows registry. Shows success/error feedback.
  2. **Show me the command** — displays a copyable code snippet for the user to run manually.
  3. **Skip** — advances to step 5 without any action.
- If `isPkg` is false (npm global install), show an informational note "Already in PATH via npm — nothing to do." and a single Continue button instead of the three options.

### Step Count

Update `<StepDots current={step} total={5} />` → `total={6}` and renumber steps: old step 4 (docs) → 5, old step 5 (finish) → 6. All `setStep(N)` calls adjusted accordingly.

### Validation

- Start the dev server and run through the wizard to verify the new step renders and each of the three options behaves correctly.
- Confirm the step is skipped gracefully (shows npm note) when not a pkg binary.
