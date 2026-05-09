---
assignee: unassigned
tags:
  - ui
  - portal
priority: Medium
effort: S
implementationLink: 77dd003b67fe027441e461ecfa088320cb2db1de
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T03:42:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T03:42:00.000Z'
    comment: >-
      FLUX-148 complete. Commit 77dd003.


      **What shipped:**

      - `agent_message` added to `HistoryEntry.type` union
      (`portal/src/types.ts`)

      - `buildAgentMessageEntry()` added to engine; `flushSessionOutput` now
      stores agent prose as `agent_message` instead of `comment`
      (`engine/src/index.ts`)

      - Four filter tabs in ticket modal: **All** | **Activity** | **Comments**
      | **Agent** (`portal/src/components/TaskModal.tsx`)

      - Agent entries render with Bot icon, dashed border, muted background — no
      unread dot or reply affordance

      - Tab preference persists in localStorage


      **Validated:** portal TypeScript compiles clean; FLUX-148 itself carries
      live `agent_message` entries visible in the Agent tab.
    id: c-2026-05-09t03-42-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T03:42:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T03:39:51.930Z'
  - type: activity
    user: Agent
    date: '2026-05-09T03:39:51.930Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T03:39:55.187Z'
    comment: >-
      ```text

      FLUX-148 is closed. Commit `77dd003` captures all three file changes — the
      new `agent_message` type, engine builder + flush routing, and the four-tab
      modal UI. The Agent tab is now live in the portal.

      ```
title: better UI UX for the 'thought process' ai agent section
status: Done
createdBy: Guy
updatedBy: Agent
description: >-
  ## Overview


  Add a dedicated `agent_message` history entry type and a third filter tab in
  the ticket modal activity feed so the agent's conversational progress output
  is visible but visually separated from user-facing comments and system
  activity events.


  ## Current State


  - `HistoryEntry.type` union: `'status_change' | 'comment' | 'activity'`

  - Activity filter has two tabs: **All Activity** / **Comments Only**

  - Agent session lifecycle events (launched, blocked, stopped) and agent text
  output all use `type: 'activity'`

  - No visual distinction between system events and agent narrative output


  ## Desired State


  Three meaningful filter tabs:

  1. **Activity** — `status_change` + `activity` entries (field changes, session
  lifecycle)

  2. **Comments** — `comment` entries (user-facing, threaded, unread tracking)

  3. **Agent** — `agent_message` entries (agent prose output, dim/muted
  treatment)


  Default view shows **All** (unchanged behaviour for users who never touch the
  filter).


  ## Implementation Plan


  ### 1. `portal/src/types.ts`

  - Add `'agent_message'` to `HistoryEntry.type` union


  ### 2. `engine/src/index.ts`

  - Add `buildAgentMessageEntry(comment, user, date)` alongside
  `buildActivityEntry()` — same shape, `type: 'agent_message'`

  - Switch the agent completion summary (line ~1242, where the agent posts its
  narrative text after finishing work) from `buildActivityEntry` to
  `buildAgentMessageEntry`

  - Keep lifecycle events (session launched, blocked, stopped, failed) as `type:
  'activity'`


  ### 3. `portal/src/components/TaskModal.tsx`

  - Expand `ActivityFilter` type to `'all' | 'activity' | 'comments' | 'agent'`

  - Update `getInitialActivityFilter` to accept the two new values from
  localStorage

  - Update `filteredHistory` derivation:
    - `'activity'` → filter to `status_change` + `activity`
    - `'comments'` → filter to `comment` (existing)
    - `'agent'` → filter to `agent_message`
    - `'all'` → no filter (existing)
  - Replace two-button toggle with four tabs: **All** | **Activity** |
  **Comments** | **Agent**

  - In the `historyList` renderer, add a branch for `type === 'agent_message'`:
    - Use `Bot` icon from lucide-react (already imported or add it)
    - Muted background: `bg-gray-50/50 dark:bg-black/10` with `border-dashed` border
    - No unread dot, no reply button
  - Exclude `agent_message` from `unreadCommentCount` (already safe since it
  only counts `comment` type)


  ## Files Changed

  - `portal/src/types.ts`

  - `engine/src/index.ts`

  - `portal/src/components/TaskModal.tsx`


  ## Validation

  - Start engine + portal dev server

  - Open a ticket that has agent activity

  - Verify All tab shows everything, Activity tab shows only field
  changes/lifecycle, Comments tab shows only user comments, Agent tab shows only
  agent prose

  - Verify agent_message entries have muted visual style and no unread/reply
  affordances

  - Verify filter preference persists across page reloads
order: 1
---
-   i do want to see its user messages, just not as t icket comments  
    maybe we add a separate section in the comments so we have  
    1\. activity (ticket changes like updates to fields etc)  
    2\. comments (user facing comments)  
    3\. Agent Activity - the agent text messages and progress or all the messages he typically 'sends' to the user as his thought process (without the command spam and stuff like that or idk, think about it) somethign that might be meaningful to look at to see process happening but not neccesarily something the user NEEDS to see.
