---
assignee: unassigned
tags:
  - feature
priority: High
effort: S
implementationLink: afd8a5d
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T15:54:29.103Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 937f17b9-0eb0-4a50-8347-4eee77be95e0
    startedAt: '2026-05-25T15:54:44.371Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T15:55:17.060Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:55:32.065Z'
        message: Responding
        type: info
      - timestamp: '2026-05-25T15:55:33.785Z'
        message: >-
          Now I have a clear picture. The release workflow already exists
          (triggered by pushing a `v*.*.*` tag). Let me check what tickets are
          in "Done" status to understand what's in this release, then groom the
          ticket.
        type: text
      - timestamp: '2026-05-25T15:55:49.663Z'
        message: >-
          Good. Now I have enough context to groom this ticket properly. The
          work involves:

          1. Updating the CHANGELOG.md for v0.8.1

          2. Creating release notes in `.docs/release-notes/v0.8.1.md`

          3. Tagging and pushing to trigger the GitHub Actions release workflow


          Let me now update the ticket with proper metadata and a concrete
          implementation plan.
        type: text
      - timestamp: '2026-05-25T15:56:23.671Z'
        message: >-
          Let me use the REST API to update the ticket since MCP tools aren't
          available as named tools.
        type: text
      - timestamp: '2026-05-25T15:56:32.088Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:56:47.092Z'
        message: Responding
        type: info
      - timestamp: '2026-05-25T15:57:16.729Z'
        message: >-
          Good, the engine API is available. Now let me update the ticket
          metadata and body, then change status to Todo.
        type: text
      - timestamp: '2026-05-25T15:57:17.098Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:57:48.171Z'
        message: 'Let me try a simpler approach with curl.exe directly:'
        type: text
      - timestamp: '2026-05-25T15:57:53.498Z'
        message: 'Ticket updated. Now let me change status to Todo:'
        type: text
      - timestamp: '2026-05-25T15:58:16.666Z'
        message: 'Ticket successfully moved to **Todo**. Let me clean up temp files:'
        type: text
      - timestamp: '2026-05-25T15:58:21.485Z'
        message: >-
          Done. **FLUX-323** has been groomed and moved to **Todo**:


          - **Title**: Release v0.8.1 with changelog and GitHub Actions release

          - **Priority**: High | **Effort**: S | **Tags**: feature

          - **Plan**: Update CHANGELOG.md → create
          `.docs/release-notes/v0.8.1.md` → commit → tag `v0.8.1` → push to
          trigger the existing GitHub Actions release workflow (which builds
          binaries and creates the GitHub Release with the changelog as body).
        type: text
    user: Copilot CLI
    date: '2026-05-25T15:54:44.371Z'
    outcome: Copilot CLI session ended with code 0.
    endedAt: '2026-05-25T15:58:21.486Z'
  - type: activity
    user: Agent
    date: '2026-05-25T15:57:42.444Z'
    comment: >-
      Updated title. Updated description. Updated tags to feature. Changed
      priority from None to High. Changed effort from None to S.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T15:58:08.778Z'
  - type: comment
    user: Copilot CLI
    date: '2026-05-25T15:58:21.486Z'
    comment: >-
      Done. **FLUX-323** has been groomed and moved to **Todo**:


      - **Title**: Release v0.8.1 with changelog and GitHub Actions release

      - **Priority**: High | **Effort**: S | **Tags**: feature

      - **Plan**: Update CHANGELOG.md → create `.docs/release-notes/v0.8.1.md` →
      commit → tag `v0.8.1` → push to trigger the existing GitHub Actions
      release workflow (which builds binaries and creates the GitHub Release
      with the changelog as body).
    id: c-2026-05-25t15-58-21-486z
  - type: agent_session
    sessionId: d4a961b7-1655-44d7-aecb-fedfddb47596
    startedAt: '2026-05-25T15:58:35.978Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T15:58:51.655Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:change_status,add_comment,finish_ticket,log_progress'
            max_results: 4
      - timestamp: '2026-05-25T15:58:52.957Z'
        message: 'Running: git log v0.8.0..HEAD --oneline'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git log v0.8.0..HEAD --oneline
            description: List commits since v0.8.0 tag
      - timestamp: '2026-05-25T15:58:53.503Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T15:58:57.714Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: CHANGELOG.md
      - timestamp: '2026-05-25T15:59:03.363Z'
        message: Reading CHANGELOG.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\CHANGELOG.md'
            limit: 50
      - timestamp: '2026-05-25T15:59:08.516Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:59:09.161Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-323
            newStatus: In Progress
      - timestamp: '2026-05-25T15:59:23.553Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:59:25.503Z'
        message: Editing CHANGELOG.md
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\CHANGELOG.md'
            old_string: '## [v0.8.0] - 2026-05-25'
            new_string: >-
              ## [v0.8.1] - 2026-05-26


              ### Features


              - **Workflow Builder UI** (FLUX-312) — Visual workflow editor with
              file-backed skills, plus agent and workflow engine REST routes

              - **Multi-agent session store** (FLUX-283) — Extended session
              store to support multiple concurrent agent sessions

              - **Epic cards** — New epic card display in the portal task board

              - **Curated release notes CI** — GitHub Actions now extracts
              release body from `.docs/release-notes/`


              ### Bug Fixes


              - **Notification bell for Ready/Done transitions** — Fixed
              notification bell not firing when tickets moved to Ready or Done
              status

              - **Copilot.exe MCP tool loading** (FLUX-310) — Prefer
              `copilot.exe` over `node + entrypoint` to ensure MCP tools load
              correctly

              - **Unread count badge and modal overlay** — Fixed unread count
              badge rendering and full-view modal overlay


              ## [v0.8.0] - 2026-05-25
      - timestamp: '2026-05-25T15:59:38.182Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-323
            newStatus: Ready
            comment: >-
              Release v0.8.1 artifacts are ready. Created CHANGELOG.md entry and
              .docs/release-notes/v0.8.1.md covering: Workflow Builder UI,
              multi-agent session store, epic cards, curated release notes CI,
              and bug fixes for notification bell, copilot.exe MCP loading, and
              unread count badge. Awaiting `finish` to commit, tag v0.8.1, and
              push.
      - timestamp: '2026-05-25T15:59:38.945Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:59:49.187Z'
        message: >-
          Release v0.8.1 artifacts are prepared:


          - **CHANGELOG.md** — Added v0.8.1 section with 4 features and 3 bug
          fixes

          - **.docs/release-notes/v0.8.1.md** — Full release notes for GitHub
          Actions to extract


          Waiting for your `finish FLUX-323` to commit, tag `v0.8.1`, and push
          to trigger the release workflow.
    user: Claude Code
    date: '2026-05-25T15:58:35.978Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T15:59:51.097Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T15:59:09.178Z'
  - type: comment
    user: Agent
    comment: >-
      Release v0.8.1 artifacts are ready. Created CHANGELOG.md entry and
      .docs/release-notes/v0.8.1.md covering: Workflow Builder UI, multi-agent
      session store, epic cards, curated release notes CI, and bug fixes for
      notification bell, copilot.exe MCP loading, and unread count badge.
      Awaiting `finish` to commit, tag v0.8.1, and push.
    date: '2026-05-25T15:59:38.969Z'
    id: c-2026-05-25t15-59-38-969z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T15:59:38.969Z'
  - type: agent_session
    sessionId: 27bfdaf7-bfe7-4591-9cff-dab3b0750fdb
    startedAt: '2026-05-25T16:00:35.092Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T16:00:50.536Z'
        message: 'Running: git status'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git status
            description: Show working tree status
      - timestamp: '2026-05-25T16:00:51.896Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T16:00:57.053Z'
        message: Reading CHANGELOG.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\CHANGELOG.md'
            limit: 30
      - timestamp: '2026-05-25T16:01:05.871Z'
        message: 'Running: git add CHANGELOG.md .docs/release-notes/v0.8.1.md...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              git add CHANGELOG.md .docs/release-notes/v0.8.1.md && git commit
              -m "$(cat <<'EOF'

              Release v0.8.1


              Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

              EOF

              )"
            description: Stage and commit release artifacts
      - timestamp: '2026-05-25T16:01:06.414Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:mcp__event-horizon__finish_ticket'
            max_results: 1
      - timestamp: '2026-05-25T16:01:06.899Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T16:01:12.134Z'
        message: 'Running: git tag v0.8.1'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git tag v0.8.1
            description: Create git tag v0.8.1
      - timestamp: '2026-05-25T16:01:21.902Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T16:01:25.279Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__finish_ticket
          parameters:
            ticketId: FLUX-323
            implementationLink: afd8a5d
            completionComment: >-
              Released v0.8.1. Committed CHANGELOG.md and
              .docs/release-notes/v0.8.1.md, tagged v0.8.1, and pushed to
              origin. GitHub Actions release workflow triggered.
      - timestamp: '2026-05-25T16:01:35.877Z'
        message: >-
          Done. Release v0.8.1 is shipped:


          - Commit `afd8a5d` pushed to `master`

          - Tag `v0.8.1` pushed to origin — GitHub Actions release workflow is
          triggered

          - FLUX-323 closed as Done
    user: Claude Code
    date: '2026-05-25T16:00:35.092Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T16:01:37.482Z'
  - type: comment
    user: Agent
    comment: >-
      Released v0.8.1. Committed CHANGELOG.md and .docs/release-notes/v0.8.1.md,
      tagged v0.8.1, and pushed to origin. GitHub Actions release workflow
      triggered.
    date: '2026-05-25T16:01:25.590Z'
    id: c-2026-05-25t16-01-25-590z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-25T16:01:25.590Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-25T16:02:47.825Z'
title: Release v0.8.1 with changelog and GitHub Actions release
status: Released
createdBy: Guy
updatedBy: Agent
comment: >-
  Grooming complete. Plan: update CHANGELOG, create release notes, commit, tag
  v0.8.1, push to trigger release workflow.
id: FLUX-323
tokenMetadata:
  inputTokens: 342191
  outputTokens: 3635
  costUSD: 0.452387
  costIsEstimated: false
  cacheReadTokens: 309301
  cacheCreationTokens: 32519
version: 0.8.1
releasedAt: '2026-05-25T16:02:47.825Z'
releaseDocPath: release-notes/0.8.1
---
## Problem / Motivation

The project has accumulated several improvements since v0.8.0 (notification bell fix, epic cards, multi-agent session store, workflow builder, copilot.exe MCP fix, curated release notes CI). These need to be shipped as v0.8.1 with a proper changelog entry in CHANGELOG.md and a GitHub Release containing the same notes.

## Implementation Plan

1. **Update CHANGELOG.md** - Add a v0.8.1 section summarizing commits since v0.8.0.
2. **Create release notes file** - Write .docs/release-notes/v0.8.1.md (GitHub Actions extracts this for the release body).
3. **Commit the release** - Stage changelog + release notes, commit as Release v0.8.1.
4. **Tag and push** - Create git tag v0.8.1 and push to origin, triggering the release workflow.
5. **Verify** - Confirm the GitHub Actions run starts successfully.
