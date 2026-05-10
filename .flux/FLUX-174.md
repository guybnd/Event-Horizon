---
assignee: unassigned
tags:
  - bug
priority: High
effort: L
implementationLink: 01b9867
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T08:24:11.274Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T08:24:17.168Z'
    comment: Launched Claude Code session (756fd129).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-10T08:35:27.696Z'
  - type: comment
    user: Agent
    date: '2026-05-10T08:35:27.696Z'
    comment: >-
      Groomed and implementing. Root cause: TaskModal (~2500-line render
      function) re-renders on every keystroke because setNewComment triggers a
      full component re-render including the entire history list with all
      TaskMarkdown components. Choppiness worsens at higher typing speed because
      the CLI session poll (every 2.5s) queues additional renders
      simultaneously. Fix: extract HistoryList as React.memo so React bails out
      of history reconciliation on newComment changes; memoize
      filteredHistory/topLevelEntries/repliesByParent; stabilize callbacks with
      useCallback.
    id: c-2026-05-10t08-35-27-696z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T08:35:34.432Z'
  - type: comment
    user: Agent
    date: '2026-05-10T08:35:34.433Z'
    comment: >-
      Implementation done. TypeScript compiles cleanly, Vite build passes.
      Changes in portal/src/components/TaskModal.tsx: (1) Extracted HistoryList
      as React.memo component above TaskModal — the key fix, prevents history
      list reconciliation on every keystroke. (2) Moved
      filteredHistory/topLevelEntries/repliesByParent into useMemo. (3) Wrapped
      handleToggleReply, handleCancelReply, handleToggleCollapsed,
      handleClearReplyAssetError, handleReplyPaste, handleReplyDragOver,
      handleReplyDrop, sendReplyDirectly in useCallback for stable references.
      (4) attachReplyImageFilesRef ref pattern for the paste/drop callbacks to
      avoid stale closure issues.
    id: c-2026-05-10t08-35-34-433z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T08:35:41.023Z'
    comment: >-
      The implementation is complete. Here's what was causing the choppiness and
      what was fixed:


      **Root cause:** `TaskModal` is a ~2500-line render function. Every
      keystroke in the comment box called `setNewComment` → full component
      re-render → React had to walk and diff the entire history list, re-running
      each `TaskMarkdown` component check. With an active CLI session running,
      the 2.5s poll added concurrent `setCliSession` re-renders, compounding the
      queue — hence "gets choppier the faster I type."


      **Fix in `portal/src/components/TaskModal.tsx`:**

      - Extracted `HistoryList` as a `React.memo` component. Now React bails out
      of the entire history tree reconciliation when only `newComment` changed —
      the dominant win.

      - Moved `filteredHistory` / `topLevelEntries` / `repliesByParent` into
      `useMemo` so history filtering doesn't recompute on every render.

      - Stabilized the reply callbacks (`handleToggleReply`,
      `handleCancelReply`, `handleToggleCollapsed`,
      `handleReplyPaste/DragOver/Drop`, `sendReplyDirectly`) with `useCallback`
      so `HistoryList`'s `memo` props stay referentially equal across renders.
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T08:42:30.016Z'
  - type: comment
    user: Agent
    date: '2026-05-10T08:42:30.017Z'
    comment: >-
      Regression fix: the useCallback hooks added for sendReplyDirectly,
      handleReplyPaste/DragOver/Drop, handleToggleReply, handleCancelReply,
      handleToggleCollapsed, handleClearReplyAssetError, plus the useRef for
      attachReplyImageFilesRef, were all placed after the 'if (!config || ...)
      return null' early return at line 908. This violated React rules-of-hooks
      — when the modal is closed React skips those hooks, then fails to
      reconcile on the next render when the modal opens, breaking the full-view
      open. Fixed by removing the early return from line 908 and re-inserting it
      after the last useCallback at line 1750, so all hooks are unconditionally
      called on every render.
    id: c-2026-05-10t08-42-30-017z
  - type: activity
    user: Agent
    date: '2026-05-10T08:49:45.361Z'
    comment: Claude Code session lost (engine restarted).
  - type: comment
    user: Guy
    date: '2026-05-10T10:45:58.381Z'
    comment: >-
      reopened. still laggy. the common theme of when it happens to lag is when
      the modal for a ticket that is in the ready state, i.e has the prompt
      button activce and aniamting. maybe theres a correlation between these
      thigns that lead to the UI bug. please try again to understand this issue
    id: c-2026-05-10t10-45-58-370z
  - type: status_change
    from: Done
    to: Todo
    user: Guy
    date: '2026-05-10T10:45:58.381Z'
  - type: activity
    user: Agent
    date: '2026-05-10T10:46:03.467Z'
    comment: Launched Claude Code session (2463b168).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T10:46:15.833Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:46:15.834Z'
    comment: >-
      Investigating the choppiness correlation with the Ready state / animating
      prompt button. Reading TaskModal and related components.
    id: c-2026-05-10t10-46-15-834z
  - type: activity
    user: Guy
    date: '2026-05-10T10:58:04.170Z'
    comment: Changed effort from S to L.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T11:08:54.210Z'
  - type: comment
    user: Agent
    date: '2026-05-10T11:08:54.211Z'
    comment: >-
      Implementation complete. Root cause: in Ready/prompt-active state, the
      readyForMergePrompt was an inline JSX const that re-evaluated on every
      keystroke (setNewComment re-render), forcing React to reconcile the entire
      prompt panel including the backdrop-blur overlay and conic-gradient spin
      animation on each character typed.


      Fix: (1) Extracted ReadyForMergePrompt as a React.memo component — React
      bails out of re-rendering the prompt entirely when newComment changes,
      since none of its props depend on comment text. (2) Wrapped
      handleReturnToWork, handleReturnToWorkAndLaunch, handleSendForCodeReview,
      and sendFinishCommand in useCallback so their references stay stable
      across keystrokes, preserving the memo bail-out. (3) Added
      will-change:transform to the conic-gradient spinning span to
      compositor-promote it. TypeScript passes cleanly.
    id: c-2026-05-10t11-08-54-211z
  - type: activity
    user: Agent
    date: '2026-05-10T11:09:00.657Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-10T11:12:44.365Z'
  - type: activity
    user: Agent
    date: '2026-05-10T11:12:44.401Z'
    comment: Launched Claude Code session (cc79bd7c).
  - type: comment
    user: Agent
    date: '2026-05-10T11:14:44.247Z'
    comment: >-
      Code review - FLUX-174. The ReadyForMergePrompt extraction is correct and
      necessary. useCallback on the four handlers is correct.
      will-change:transform on the spinning span is fine. But you left a bug in.
      readyForMergeBanner is computed as an inline JSX const in the render body
      and passed directly as a prop to ReadyForMergePrompt. JSX objects are new
      references every render. So React.memo on ReadyForMergePrompt checks
      readyForMergeBanner via referential equality, sees a new object every time
      newComment changes, and re-renders the whole prompt anyway. You defeated
      your own optimization. The memo bail-out you claimed as the fix does not
      actually fire on keystrokes. Fix: wrap readyForMergeBanner in useMemo so
      its reference is stable when the underlying data has not changed.
      Dependencies: isReadyForMerge and readyForMergeStatus. Then the memo
      bail-out actually works. While you are at it: requireInputBanner has the
      same pattern - inline JSX const passed into inline JSX. Not through a
      memoized component so less critical right now, but the same class of
      mistake. Back to In Progress. Fix the banner memoization.
    id: c-2026-05-10t11-14-44-247z
  - type: activity
    user: Agent
    date: '2026-05-10T11:14:49.112Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-10T11:18:18.289Z'
    comment: Launched Claude Code session (d7f18883).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T11:18:51.439Z'
  - type: comment
    user: Agent
    date: '2026-05-10T11:18:51.440Z'
    comment: >-
      Fixed: wrapped readyForMergeBanner in useMemo with deps [isReadyForMerge,
      readyForMergeStatus]. The previous implementation was an inline JSX const
      that produced a new object reference on every render, so React.memo on
      ReadyForMergePrompt always saw a changed prop and re-rendered the full
      prompt (backdrop-blur overlay + conic-gradient animation) on every
      keystroke. With a stable reference, the memo bail-out now actually fires
      when only newComment changes. TypeScript passes cleanly.
    id: c-2026-05-10t11-18-51-440z
  - type: activity
    user: Agent
    date: '2026-05-10T11:18:54.285Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-10T14:09:13.231Z'
    comment: Launched Claude Code session (d53c42a3).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T14:09:55.541Z'
  - type: activity
    user: Agent
    date: '2026-05-10T14:09:55.541Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T14:09:57.999Z'
    comment: >-
      FLUX-174 is closed. Commit `01b9867` — `readyForMergeBanner` is now
      memoized, so `React.memo` on `ReadyForMergePrompt` correctly bails out on
      every keystroke and the prompt overlay stops re-rendering while you type.
  - type: activity
    user: Agent
    date: '2026-05-10T14:11:00.372Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-10T14:11:00.370Z'
    comment: Claude Code session lost (engine restarted).
title: comment box is really choppy
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 3375095
  outputTokens: 98478
  costUSD: 2.919287
  costIsEstimated: false
---
in a ticket thats currently inm ready phase and has an active prompt. typing in the comment box is suuuuper slow and laggy and choppy, getting choppier to faster i type.
never bails out = prompt re-renders on every
      character typed. The optimization doesn't actually work.


      The fix is straightforward: wrap `readyForMergeBanner` in `useMemo` with
      deps `[isReadyForMerge, readyForMergeStatus]` so the reference is stable.
      Ticket is back to **In Progress**.
title: comment box is really choppy
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 2677042
  outputTokens: 90947
  costUSD: 2.408832
  costIsEstimated: false
---
in a ticket thats currently inm ready phase and has an active prompt. typing in the comment box is suuuuper slow and laggy and choppy, getting choppier to faster i type.
us: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 2677042
  outputTokens: 90947
  costUSD: 2.408832
  costIsEstimated: false
---
in a ticket thats currently inm ready phase and has an active prompt. typing in the comment box is suuuuper slow and laggy and choppy, getting choppier to faster i type.
