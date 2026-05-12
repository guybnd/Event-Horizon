---
title: Add Releases surface and released-status workflow
status: Released
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - workflow
priority: Medium
effort: L
implementationLink: 5d989d9dd00853625a0ef3848e3ec81863ffc3a1
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T01:28:32.411Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      The key workflow decision is still open. Should creating a release move
      selected tickets into a dedicated `Released` status, or should tickets
      keep their workflow status and instead gain release/version metadata that
      the new Releases surface groups by version?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-50
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T03:07:37.337Z'
    comment: >-
      probably Both, we want to have a new field for tickets of 'version' that
      releasing them will apply this fields input

      they should also move to 'released' status which will remove them from the
      Done column and entirely from the board, being viewable only from search
      or releases menu
    id: c-2026-05-07t03-07-37-337z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T03:07:37.337Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Groomed this into a concrete release workflow: selected `Done` tickets get
      version metadata, move into a hidden `Released` status, and become
      browsable from a dedicated Releases surface. This is ready for `Todo`.
    id: c-2026-05-07t03-53-39-4816199z-flux-50
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-07T13:36:22.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T14:00:00.000Z'
    comment: >-
      Implemented the remaining scope for FLUX-50: - Added 'Release Settings' to
      the global settings pane (strategy and path). - Added multi-select Release
      functionality to the 'Done' column in Board.tsx. - Implemented
      ReleaseModal to batch update chosen tickets to Released status and
      generate docs based on the configured strategy. - Updated agent
      instructions (`.flux/skills/event-horizon-agent.md`) with the `Release
      Orchestration` procedure. Ready for review and final commit.
    id: c-2026-05-07t14-00-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T14:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T14:15:00.000Z'
    comment: >-
      User confirmed missing Release Tab, added to App.tsx and Header.tsx.
      Tested and verified `v0.1.0` release creation via CLI. Committed changes
      as 5d989d9 and moving to Done.
    id: c-2026-05-07t14-15-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-07T14:15:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.360Z'
order: 6
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.360Z'
releaseDocPath: release-notes/0.2.0
---
## Summary

Add a Releases surface that groups completed tickets under versioned releases.
Creating a release should apply version metadata to selected `Done` tickets,
move them into a hidden `Released` status, and make them discoverable through
search and the Releases view rather than the active board. This system must also
include a CLI-driven procedure and documentation to allow AI agents to safely
orchestrate releases and batch-update tickets.

## Requirements

### 1. Add release metadata to tickets
- Introduce ticket-level release fields such as `version`, `releasedAt`, and optional release notes metadata
- Preserve the ticket's existing workflow history when it is released
- Keep the version label visible anywhere a released ticket can still be opened or searched

### 2. Add a dedicated released status
- Add a hidden `Released` status separate from `Done`
- Releasing a ticket should move it out of `Done` and off the active board
- Released tickets must still be loadable through search and direct ticket open flows

### 3. Create a release action from the Done workflow
- Add a `Release` action near the `Done` column or equivalent completion surface
- Let the user multi-select eligible `Done` tickets and enter the target version label
- Applying the release should update version metadata and ticket status together

### 4. Add a Releases view
- Add a Releases section that groups released tickets by version
- Each release group should show the version label, included tickets, and room for release notes or summary metadata
- Opening a released ticket should still show its full history and release metadata

### 5. Keep search and board behavior coherent
- Released tickets should no longer appear in board columns or the `Done` queue
- Global search should still return released tickets with their version context
- The ticket modal/details view should surface release metadata when present

### 6. Agent Orchestration Procedure
- Provide a CLI tool or script (e.g., `npm run flux:release <version>`) that the AI agent can execute to orchestrate a release programmatically.
- The process must automatically gather all eligible `Done` tickets, apply the target version to them, generate aggregated release notes from ticket summaries, and safely transition their statuses to `Released`.
- Include explicit agent instructions on how to decide version numbers, trigger the release script, and finalize the release workflow.
- Generate release notes and store them as a Markdown file in the Docs (`.docs/release-notes/`).
- Tickets should store a `releaseDocPath` linking directly to the specific release notes doc.

### 7. Release Settings
- Add a new Release Settings section to determine whether to generate a distinct changelog file for each version or to aggregate all releases into a single file.
- Add an option to specify the path/directory for release notes.

## Acceptance Criteria

- [x] Tickets can store release metadata such as version, release date, and `releaseDocPath`
- [x] A hidden `Released` status exists and released tickets move into it
- [x] Users can select `Done` tickets and assign them to a versioned release
- [x] Released tickets disappear from the active board but remain accessible through search and the Releases surface
- [x] The Releases surface groups tickets by version and opens the underlying ticket details correctly
- [x] Agent tooling/script exists to reliably batch-release tickets and generate release notes via CLI
- [x] Agent instructions clearly define the procedure to orchestrate a new version release
- [x] Generated release notes are saved as a Markdown file in the `.docs` system according to Release Settings
- [x] Settings page includes options to configure the release notes output strategy

## Likely Affected Areas

- `.flux/config.json`
- `engine/src/index.ts`
- `portal/src/types.ts`
- `portal/src/components/Header.tsx`
- `portal/src/components/Board.tsx`
- New portal Releases screen and routing/view-state support

## Notes

- The first slice can focus on creating and browsing releases, not editing or deleting past releases
- Release notes can start simple if the version grouping and workflow transition land first
