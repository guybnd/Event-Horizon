---
assignee: Agent
tags: []
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T05:31:23.866Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T06:53:03.466Z'
    comment: Launched Claude Code session (aa081fba).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T06:54:53.768Z'
  - type: comment
    user: Agent
    date: '2026-05-10T06:54:53.769Z'
    comment: >-
      Grooming complete. Plan: add a CodeReviewButton component to the Ready
      prompt with four reviewer personas (Senior Dev, Angry Linus, Architect
      Genius, Performance Expert). Each persona launches an agent session via
      the existing startTaskCliSession API with a persona-specific appendPrompt
      that tells the agent how to review and respond. Touches TaskModal.tsx and
      a new CodeReviewButton.tsx only — no engine changes needed.
    id: c-2026-05-10t06-54-53-769z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T06:55:40.048Z'
  - type: comment
    user: Agent
    date: '2026-05-10T06:55:40.048Z'
    comment: >-
      Starting implementation: creating CodeReviewButton.tsx, then wiring into
      TaskModal.tsx Ready prompt panel.
    id: c-2026-05-10t06-55-40-048z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T06:57:20.684Z'
  - type: comment
    user: Agent
    date: '2026-05-10T06:57:20.684Z'
    comment: >-
      Implementation complete. Created CodeReviewButton.tsx with four reviewer
      personas (Senior Friendly Dev, Angry Linus, Architect Genius, Performance
      Expert). Each persona carries a full appendPrompt that instructs the agent
      on review approach, how to read the diff, and whether to approve (stay
      Ready) or request changes (move to In Progress with detailed feedback
      comment). Wired into the Ready prompt action panel in TaskModal.tsx
      alongside the existing finish/return-to-work actions. TypeScript clean, no
      engine changes needed.
    id: c-2026-05-10t06-57-20-684z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T06:57:26.817Z'
    comment: >-
      Implementation is complete and FLUX-170 is in Ready. Here's a summary of
      what was built:


      **New file:** `portal/src/components/CodeReviewButton.tsx`

      - A split button + dropdown listing four reviewer personas

      - Each persona has a full `appendPrompt` that tells the agent: read the
      ticket, check the diff, evaluate from that persona's lens, then either
      approve (stay Ready) or move ticket to In Progress with detailed feedback


      **Modified:** `portal/src/components/TaskModal.tsx`

      - Imported `CodeReviewButton` and `ReviewPersona`

      - Added `reviewBusy`/`reviewError` state

      - Added `handleSendForCodeReview(persona)` handler — calls
      `startTaskCliSession` with the persona's prompt as `appendPrompt`

      - Wired `<CodeReviewButton>` into the Ready prompt action panel between
      "Return to work" and the expand button; disabled when a session is already
      active


      When you're ready to ship, say `finish FLUX-170`.
  - type: comment
    user: Guy
    date: '2026-05-10T08:14:31.176Z'
    comment: >-
      in the code review dropdown - it doest draw on top of the prompt active
      card which means the content gets cut off and i have to scroll down to see
      it.
    replyTo: c-2026-05-10t06-57-20-684z
    id: c-2026-05-10t08-14-31-166z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T08:14:31.176Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T08:14:31.227Z'
    comment: Launched Claude Code session (31db86c7).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T08:15:09.035Z'
  - type: comment
    user: Agent
    date: '2026-05-10T08:15:09.036Z'
    comment: >-
      Fixed dropdown clipping: changed dropdown position from top-full to
      bottom-full so it opens upward and stays visible within the card without
      scrolling.
    id: c-2026-05-10t08-15-09-036z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T08:15:11.616Z'
    comment: >-
      Fixed. The dropdown position changed from `top-full` (opens downward) to
      `bottom-full` (opens upward), so the persona list now floats above the
      button and won't get clipped by the card boundary. FLUX-170 is back in
      Ready — say `finish FLUX-170` when you're happy with it.
  - type: activity
    user: Agent
    date: '2026-05-10T08:15:32.217Z'
    comment: Launched Claude Code session (75b21ef6).
  - type: comment
    user: Agent
    date: '2026-05-10T08:17:04.459Z'
    comment: >-
      Angry Linus review:


      The implementation is fine. I'm not going to pretend otherwise.


      CodeReviewButton.tsx is clean. The dropdown-clipping fix (bottom-full) is
      the right call. The click-outside handler is correct. Both buttons in the
      split both toggle the same dropdown — that's a bit redundant but not
      wrong, and it gives the chevron dead space a job to do.


      The two separate import lines for CodeReviewButton and ReviewPersona are
      pointless pedantry. One line: `import { CodeReviewButton, type
      ReviewPersona } from './CodeReviewButton';`. Not a bug, just noise.


      handleSendForCodeReview is straightforward and does what it says. The
      disabled condition on CodeReviewButton correctly checks for active session
      states. Error state renders fine.


      The persona prompts are... long. Very long. But they're config data, not
      logic, so I won't die on that hill.


      No hidden state bugs, no re-render traps, no missing cleanup. It works.


      Approved. Ship it.
    id: c-2026-05-10t08-17-04-459z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T08:17:08.801Z'
    comment: >-
      Code passes. Here's the verdict:


      **Approved.** The implementation is solid:


      - `CodeReviewButton.tsx` is clean — correct click-outside handler, correct
      `bottom-full` dropdown positioning fix, sensible disabled logic

      - `handleSendForCodeReview` is straightforward, error handling is correct,
      session state gating works

      - The Ready panel integration is minimal and correct


      One nitpick: two separate import lines for the same file
      (`CodeReviewButton` and `type ReviewPersona`) should be one line. Not a
      bug, just unnecessary noise.


      The persona prompts are verbose config data, not code — acceptable.


      Ticket stays **Ready**.
  - type: comment
    user: Guy
    date: '2026-05-10T08:18:52.799Z'
    comment: >-
      this feature looks good. only small problem is that while reviewing it
      stays in the ready status instead of going back to in progress.
    replyTo: c-2026-05-10t08-17-04-459z
    id: c-2026-05-10t08-18-52-790z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T08:18:52.799Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T08:18:52.890Z'
    comment: Launched Claude Code session (2a6f20c7).
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T08:19:28.812Z'
    comment: >-
      Done. The `handleSendForCodeReview` handler now calls `updateTask` to move
      the ticket to `In Progress` before launching the CLI session. When you
      click "Send for Code Review", the ticket will transition immediately
      rather than staying in Ready.
  - type: activity
    user: Agent
    date: '2026-05-10T08:21:36.157Z'
    comment: Claude Code session lost (engine restarted).
  - type: comment
    user: Guy
    date: '2026-05-10T08:21:49.614Z'
    comment: 'lets also add a reviwewer thats focused heavil;y on user experience, UI UX'
    id: c-2026-05-10t08-21-49-590z
  - type: activity
    user: Agent
    date: '2026-05-10T08:21:53.414Z'
    comment: Launched Claude Code session (f08aeb9f).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T08:22:33.946Z'
  - type: comment
    user: Agent
    date: '2026-05-10T08:22:33.946Z'
    comment: >-
      Added UX/UI Expert persona to CodeReviewButton.tsx. Also confirmed the
      existing fix where handleSendForCodeReview calls updateTask to move the
      ticket to In Progress before launching the CLI session is in place. Five
      personas total: Senior Friendly Dev, Angry Linus, Architect Genius,
      Performance Expert, and UX/UI Expert.
    id: c-2026-05-10t08-22-33-946z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T08:22:36.218Z'
    comment: >-
      Done. Added the **UX/UI Expert** persona to `CodeReviewButton.tsx`. It
      focuses on usability, accessibility, interaction design, loading/error
      states, keyboard nav, and visual consistency with the portal. The ticket
      is back to Ready with five total reviewer personas.
  - type: activity
    user: Agent
    date: '2026-05-10T08:30:10.334Z'
    comment: Launched Claude Code session (c5b87727).
title: 'add send for code review step on ready '
status: Ready
createdBy: Guy
updatedBy: Agent
---
## Summary

Add a **Send for Code Review** button to the Ready prompt in the ticket modal. The user picks a reviewer persona from a dropdown, which launches an agent session with a persona-specific `appendPrompt` that instructs the agent to act as that reviewer, evaluate the implementation, and respond by either leaving an approval comment (ticket stays Ready) or leaving detailed feedback and moving the ticket back to In Progress.

## Reviewer Personas

| Persona | Tone / Focus |
|---|---|
| Senior Friendly Dev | Collegial, constructive; covers code quality, readability, and maintainability |
| Angry Linus | Brutally honest, terse; calls out anything messy, over-engineered, or unclear |
| Architect Genius | Design patterns, separation of concerns, scalability, abstractions |
| Performance Expert | Complexity, memory, bundle size, hot paths, unnecessary re-renders |

## Touchpoints

- `portal/src/components/TaskModal.tsx` — add `handleSendForCodeReview(persona)` handler; hook into the Ready prompt action panel
- `portal/src/components/CodeReviewButton.tsx` — new component with persona dropdown
- `portal/src/api.ts` — no changes needed; uses existing `startTaskCliSession` with `appendPrompt`

## Implementation Plan

### 1. `CodeReviewButton.tsx` (new component)

A button with a persona dropdown. Props:

```ts
interface Props {
  onReview: (persona: ReviewPersona) => void;
  disabled?: boolean;
  busy?: boolean;
}
```

When a persona is selected, call `onReview(persona)` and close the dropdown. Style: secondary/outline to not compete with the primary "Tell agent to finish" CTA. Use `Search` or `Eye` icon from lucide-react.

### 2. Persona definitions (inside `CodeReviewButton.tsx`)

Four personas with `id`, `label`, `description`, and `prompt` (string). Each `prompt` instructs the agent to:
1. Read the full ticket and history
2. Review recent commits / diff for this ticket
3. Evaluate from the persona's specific lens
4. If issues found: post a detailed review comment via `PUT /api/tasks/:id` (history comment), then move ticket to `In Progress`
5. If approved: post an approval comment, leave ticket as Ready

Persona prompts:
- **Senior Friendly Dev** — collegial tone, focus on readability/maintainability/correctness; encourage and suggest, don't just criticize
- **Angry Linus** — terse, blunt, no softening; call out anything messy, over-engineered, poorly named, or unclear
- **Architect Genius** — evaluate design patterns, abstractions, coupling, separation of concerns, long-term scalability
- **Performance Expert** — focus on algorithmic complexity, unnecessary re-renders, bundle size, memory, hot paths

### 3. `handleSendForCodeReview` in `TaskModal.tsx`

```ts
const [reviewBusy, setReviewBusy] = useState(false);
const [reviewError, setReviewError] = useState('');

const handleSendForCodeReview = async (persona: ReviewPersona) => {
  if (!modalTask?.id) return;
  setReviewBusy(true);
  setReviewError('');
  try {
    const session = await startTaskCliSession(
      modalTask.id,
      selectedCliFramework,
      persona.prompt,
      skipPermissions
    );
    setCliSession(session);
    triggerRefresh();
    closeModal();
  } catch (error: any) {
    setReviewError(error?.message || 'Failed to start review session.');
  } finally {
    setReviewBusy(false);
  }
};
```

### 4. UI in the Ready prompt panel

Add `<CodeReviewButton>` below the existing action buttons in the right-hand panel of `readyForMergePrompt`. Disable when a CLI session is already active (`cliSession` is pending/running/waiting-input) or when `reviewBusy` is true. Show `reviewError` if set.

## Validation

- Open a ticket in Ready status; confirm Code Review button appears in the action panel
- Click each persona; confirm agent session starts with correct persona context visible in live output
- Confirm button is disabled when session is already active
- Confirm error state renders when session start fails
