---
assignee: unassigned
tags: []
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T14:34:49.606Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-08T14:34:52.788Z'
    comment: Launched Claude Code session (65683410).
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:37:05.251Z'
    comment: >-
      Asked Guy which distribution format to target: .app/.dmg, signed/notarized
      .dmg, zipped binary, or GitHub Release.
    id: c-2026-05-08t14-37-05-251z
  - type: comment
    user: Guy
    date: '2026-05-08T14:40:17.434Z'
    comment: lets do a zip binary
    replyTo: c-2026-05-08t14-37-05-251z
    id: c-2026-05-08t14-40-17-434z
  - type: activity
    user: Agent
    date: '2026-05-08T14:40:20.777Z'
    comment: Launched Claude Code session (695b3563)
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T00:00:01.000Z'
    comment: >-
      Plan: add a `dist:mac` script to root `package.json` that calls
      `package:mac` then zips `engine/dist/event-horizon` into
      `event-horizon-macos.zip` in the repo root. No new dependencies needed —
      uses the system `zip` command. Run `npm run dist:mac` to produce the
      distributable.
    id: c-2026-05-09t00-00-01-000z
  - type: activity
    user: Agent
    date: '2026-05-08T14:41:59.847Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-08T14:43:50.868Z'
    comment: >-
      can you explain why this grooming waas not resulted in a new tiket
      description? do we ned to improve the integration somehow
    id: c-2026-05-08t14-43-50-868z
  - type: activity
    user: Agent
    date: '2026-05-08T14:43:53.535Z'
    comment: Launched Claude Code session (fbf087d7).
  - type: comment
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
    comment: >-
      Fixed corrupted ticket body (previous session leaked agent output text
      into the markdown body). Implementation is complete: `dist:mac` script
      added to root `package.json`, `event-horizon-macos.zip` built and present
      in repo root. On Guy's question about grooming not updating the
      description: the previous session wrote its response text directly into
      the ticket body instead of rewriting it via the API — this is a workflow
      bug where the agent conflated "output to user" with "update ticket body".
      The grooming skill says to tighten the body into a concrete plan, but the
      session left the original vague description and appended raw fragments. No
      engine change is needed; the agent just needs to explicitly rewrite the
      ticket body during grooming when it updates the plan.
    id: c-2026-05-09t00-00-02-000z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:44:45.850Z'
    comment: >-
      ```text

      **To answer your question about why grooming didn't update the ticket
      description:**


      The previous session wrote its response text (the question asking which
      format you wanted) directly into the ticket body as raw text fragments,
      rather than rewriting the body via a proper ticket update. This is a
      workflow bug in that session — not an engine integration issue.


      What *should* happen during grooming:

      1. The agent asks clarifying questions by posting a **history comment**,
      not by appending to the body

      2. Once choices are resolved, the agent **rewrites the ticket body** into
      a concrete plan


      The body stayed as the original vague description because the agent never
      explicitly replaced it. I've fixed the corrupted body now and the ticket
      reflects the correct state.


      **Implementation status:** The `dist:mac` script was already added and
      `event-horizon-macos.zip` exists in the repo root. The implementation is
      complete. Ready to `finish FLUX-143` when you are.

      ```
    id: c-2026-05-08t14-44-45-850z
  - type: comment
    user: Guy
    date: '2026-05-08T14:56:15.522Z'
    comment: >-
      packaging should have a 'blank slate' without all the current tickets nad
      projects we are currently working on. so the new start window pops up to
      let the user select his project folder and IDE etc
    id: c-2026-05-08t14-56-15-522z
title: distributable for macos?
status: In Progress
createdBy: Guy
updatedBy: Guy
---

Add a `dist:mac` npm script that builds the macOS standalone binary then zips it into `event-horizon-macos.zip` for easy sharing.

## Plan

- Add `dist:mac` to root `package.json`: `npm run package:mac && zip -j event-horizon-macos.zip engine/dist/event-horizon`
- No new dependencies — uses system `zip`
- Output: `event-horizon-macos.zip` in repo root (~33 MB), ready to send

## Implementation

Added `dist:mac` script to `package.json`. Running `npm run dist:mac` builds the portal + engine, packages via `pkg`, and zips the binary.
