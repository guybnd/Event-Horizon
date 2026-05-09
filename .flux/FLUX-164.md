---
assignee: Agent
tags: []
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T08:42:16.426Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-09T08:42:20.532Z'
    comment: Launched Claude Code session (31a3723b).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-09T08:46:08.613Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:46:08.614Z'
    comment: >-
      Groomed and implementing: add a hop animation to the card face whenever
      the CLI session liveOutput grows (agent has a new thought). Uses
      framer-motion useAnimationControls — y: [0, -5, 0] in 0.35s, gated by
      animationsEnabled and hasActiveCliSession.
    id: c-2026-05-09t08-46-08-614z
  - type: activity
    user: Agent
    date: '2026-05-09T08:46:16.810Z'
    comment: Updated description.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T08:46:23.121Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:46:23.121Z'
    comment: >-
      Implementation complete. Added hop animation to TaskCard:\n\n- Imported
      useAnimationControls from framer-motion\n- Added prevLiveOutputLenRef to
      track liveOutput length between polls\n- useEffect fires y: [0, -5, 0] hop
      (0.35s easeOut) whenever liveOutput grows and hasActiveCliSession is
      true\n- Wrapped card face motion.div with a hop wrapper div using
      animate={hopControls}\n- Gated by animationsEnabled flag\n- TypeScript
      compiles cleanly, no regressions\n\nThe card will hop each time the engine
      receives new output from the Claude Code process (every ~3s poll when
      active).
    id: c-2026-05-09t08-46-23-121z
  - type: activity
    user: Agent
    date: '2026-05-09T08:46:29.176Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-09T08:51:20.547Z'
    comment: >-
      in retrospect i dont want the card to hop. i want the 'assignee' active
      glow badge to do a little rattle. that looks nicer
    replyTo: c-2026-05-09t08-46-23-121z
    id: c-2026-05-09t08-51-20-547z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-09T08:51:20.547Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-09T08:51:20.591Z'
    comment: Launched Claude Code session (3e70658d).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T08:52:27.356Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:52:27.357Z'
    comment: >-
      Changed animation target from card face to assignee badge. The hop wrapper
      motion.div is removed; the assignee badge is now a motion.button with
      rattleControls. On each liveOutput growth, it fires x: [0, -3, 3, -2, 2,
      0] over 0.35s — a tight rattle rather than a card hop. TypeScript compiles
      clean, no regressions to drag/layout/glow.
    id: c-2026-05-09t08-52-27-357z
title: >-
  I want a little hop animation on the card every time the agent has a 'thought'
  to kind of indicate its working. 
status: Ready
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 4946
  outputTokens: 8822
  costUSD: 0.816766
  costIsEstimated: false
---
## Implementation Plan

Add a subtle hop animation (y: [0, -5, 0]) to the card face each time the agent produces new output on the active CLI session.

### Approach
- Use `useAnimationControls` from framer-motion to imperatively trigger the hop
- Track `liveOutput` length in a ref; fire the animation when it grows
- Gate on `animationsEnabled` and `hasActiveCliSession`
- Wrap the inner card `motion.div` with a hop wrapper `<motion.div animate={hopControls}>`

### Files Changed
- `portal/src/components/TaskCard.tsx`: add `useAnimationControls`, prevLiveOutputLenRef, hop useEffect, and hop wrapper div

### Validation
- TypeScript compiles cleanly
- Animation fires only during active agent sessions
- No regression to drag/layout animations or opacity fade
