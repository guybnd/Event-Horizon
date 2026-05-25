---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T04:16:42.345Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 966eecbc-5c99-4417-a6a4-bae7ee0b1875
    startedAt: '2026-05-25T04:18:29.983Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T04:21:32.184Z'
        message: Reading FLUX-291.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-291.md'
      - timestamp: '2026-05-25T04:21:33.130Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T04:21:43.027Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore card UI and status system
            subagent_type: Explore
            prompt: >-
              I need to understand two things about this project:


              1. How statuses are defined and used — specifically, are statuses
              like "Grooming", "Require Input", "Ready" hardcoded anywhere, or
              are they purely config-driven from `.flux/config.json`? Look at
              the engine source (engine/src/) for status handling, validation,
              and any hardcoded status references.


              2. The TaskCard component in the portal — what actions/buttons are
              currently shown on cards? Look at portal/src/ for TaskCard.tsx and
              any related action components. I want to understand what UI
              affordances exist for triggering status transitions or agent
              actions.


              Search breadth: medium. Report the key files and relevant code
              patterns found.
      - timestamp: '2026-05-25T04:21:43.112Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: .flux/*.md
      - timestamp: '2026-05-25T04:21:45.619Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\config.json'
      - timestamp: '2026-05-25T04:21:49.348Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T04:21:50.225Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: status|Status
            path: engine/src
            type: ts
            output_mode: files_with_matches
      - timestamp: '2026-05-25T04:21:50.613Z'
        message: Reading TaskCard.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\TaskCard.tsx'
      - timestamp: '2026-05-25T04:21:58.877Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: requireInputStatus|readyForMergeStatus|archiveStatus
            path: engine/src
            type: ts
            output_mode: content
            head_limit: 50
      - timestamp: '2026-05-25T04:21:59.821Z'
        message: Reading workflow.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\workflow.ts'
      - timestamp: '2026-05-25T04:22:04.361Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T04:22:04.866Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: status.*change|updateTask.*status
            path: portal/src
            type: tsx
            output_mode: files_with_matches
      - timestamp: '2026-05-25T04:22:07.775Z'
        message: Reading config.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\config.ts'
      - timestamp: '2026-05-25T04:22:08.592Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: Grooming|hardcoded.*status
            path: engine/src
            type: ts
            output_mode: content
            head_limit: 40
      - timestamp: '2026-05-25T04:22:12.284Z'
        message: Reading claude-code.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\agents\claude-code.ts'
            offset: 1
            limit: 200
      - timestamp: '2026-05-25T04:22:16.576Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: Grooming.*hardcoded|hardcoded.*Grooming
            path: engine/src
            type: ts
            output_mode: content
      - timestamp: '2026-05-25T04:22:19.368Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T04:22:44.304Z'
        message: Reading FLUX-290.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-290.md'
      - timestamp: '2026-05-25T04:22:49.368Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T04:23:34.377Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T04:23:48.407Z'
        message: Writing FLUX-291.md
        type: tool
        data:
          toolName: Write
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-291.md'
            content: >
              ---

              id: FLUX-291

              title: "Per-status action buttons on cards + ensure workflow
              statuses exist"

              status: Todo

              priority: High

              effort: M

              assignee: unassigned

              tags:
                - feature
                - portal
                - engine
              createdBy: Guy

              updatedBy: Agent

              history:
                - type: activity
                  user: Guy
                  date: '2026-05-25T04:16:42.345Z'
                  comment: >-
                    Created ticket. Statuses are brittle in fresh setups — missing Grooming,
                    Require Input, Ready. Need per-status action buttons on cards that are
                    modular enough to reuse from card, right-click, etc.
                - type: comment
                  user: Agent
                  date: '2026-05-25T13:42:18.331Z'
                  comment: >-
                    Groomed ticket. Split into two subtasks: (1) engine ensures required
                    workflow statuses exist on startup, (2) portal gets per-status action
                    buttons via a modular action registry. No blocking questions — design is
                    straightforward from the existing context menu patterns.
                - type: status_change
                  from: Grooming
                  to: Todo
                  user: Agent
                  date: '2026-05-25T13:42:18.331Z'
              ---


              ## Problem / Motivation


              Two usability gaps slow down new users and make the agent workflow
              less discoverable:


              1. **Brittle statuses**: Fresh setups may lack workflow-critical
              statuses (`Grooming`, `Require Input`, `Ready`). If these are
              missing from `config.json`, the agent workflow silently breaks —
              grooming can't happen, the require-input gate doesn't fire, and
              the ready-for-merge button never appears.


              2. **Hidden actions**: The primary way to trigger agent actions
              (groom, implement, finish) is through the right-click context
              menu, which is not discoverable. Users don't know what they can do
              with a card at a given status without exploring menus.


              ## Implementation Plan


              ### Part 1: Ensure workflow statuses on engine startup


              In `engine/src/config.ts` `loadConfig()`, after merging the user
              config, ensure these statuses exist somewhere in columns or
              hiddenStatuses:


              | Status | Role | Add to if missing |

              |--------|------|-------------------|

              | `Grooming` | Planning phase | `columns` (before Todo) |

              | `Require Input` | Blocking on user | `hiddenStatuses` |

              | `Ready` | Awaiting merge | `columns` (after In Progress) |

              | `Archived` | Soft-delete | `hiddenStatuses` |


              Logic: check `columns` + `hiddenStatuses` for each name. If
              missing, insert at the canonical position with a default color.
              Write back to config.json only if changes were made. This is
              additive-only — never removes user-defined statuses.


              ### Part 2: Per-status action button registry (portal)


              Create a new module `portal/src/components/StatusActions.tsx` (or
              `portal/src/statusActions.ts` for the registry + a component for
              rendering):


              **Registry** — a mapping from status to available actions:


              ```typescript

              type StatusAction = {
                label: string;
                icon: string;
                command: (taskId: string) => string; // e.g. "groom FLUX-41"
                variant?: 'primary' | 'secondary';
              };


              const STATUS_ACTIONS: Record<string, StatusAction[]> = {
                'Grooming': [{ label: 'Start Grooming', icon: 'Sparkles', command: id => `groom ${id}` }],
                'Todo': [{ label: 'Implement', icon: 'Play', command: id => `implement ${id}` }],
                'In Progress': [{ label: 'Request Review', icon: 'Eye', command: id => `review ${id}` }],
                'Ready': [{ label: 'Finish', icon: 'Check', command: id => `finish ${id}` }],
                'Require Input': [{ label: 'Respond', icon: 'MessageCircle', command: id => `respond ${id}` }],
              };

              ```


              The registry uses config-aware lookups (e.g.,
              `getRequireInputStatus(config)` → maps to the Require Input
              actions) so it respects renamed statuses.


              **Component** — `<StatusActionButton task={task} />`:

              - Renders a small button (or button group if multiple actions) at
              the bottom of the card.

              - If an agent session is already active for this task, show a
              running indicator instead.

              - The same component can be mounted inside `TaskCard.tsx`,
              `ContextMenu.tsx`, `TaskModal.tsx`, or any future surface.


              **Integration points:**

              - `TaskCard.tsx`: render `<StatusActionButton>` at the card bottom
              (replacing the current hardcoded "finish" button logic).

              - `ContextMenu.tsx`: reuse the registry to populate the "Run agent
              command" submenu dynamically instead of hardcoding options.

              - Future: keyboard shortcut handler can query the registry for the
              current card's status.


              ### Part 3: Additional considerations


              - **Agent-running state**: If an agent is already active on a
              task, the button should show "Running..." with a spinner rather
              than offering to start a new session. The existing `agentSessions`
              state in AppContext covers this.

              - **Dropdown for multi-action statuses**: If a status has >1
              action, render as a split button (primary action + dropdown for
              alternatives).

              - **Accessibility**: Buttons need `aria-label` with the full
              action description. Keyboard focus should reach them via tab
              navigation within the card.

              - **No config UI needed for v1**: The registry is code-defined. A
              future ticket can add config-driven custom actions per status.
      - timestamp: '2026-05-25T04:23:49.379Z'
        message: Editing
        type: info
      - timestamp: '2026-05-25T04:23:55.179Z'
        message: >-
          Ticket FLUX-291 has been groomed and moved to `Todo`. Summary of what
          I did:


          - **Filled metadata**: priority High, effort M, tags `feature`,
          `portal`, `engine`

          - **Rewrote the body** with a clear Problem/Motivation and a
          three-part Implementation Plan:
            1. Engine startup ensures workflow-critical statuses exist in config (additive-only)
            2. Portal gets a modular status-action registry + reusable `<StatusActionButton>` component
            3. Additional considerations (agent-running state, split buttons, accessibility)
          - **No blocking questions** — the design follows naturally from
          existing patterns (context menu, workflow.ts helpers, agent session
          state)

          - **Set status to Todo** with proper history entries
    user: Claude Code
    date: '2026-05-25T04:18:29.983Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T04:23:55.180Z'
id: FLUX-291
title: make it more obvious how to start tasks for each relevant status and action
status: Grooming
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 149738
  outputTokens: 4153
  costUSD: 0.466785
  costIsEstimated: false
  cacheReadTokens: 119702
  cacheCreationTokens: 29262
---
1.  we need to make statuses less brittle in the project configuration, some fresh setup begins without the relevant statuses. we need to set up everything maybe hardcoded or pre-coded  
      
    2\. for each status, i want to have a button on the card that sends the relevant context appropriate agent action or with an appropriate dropdown to enable it  
    the code for this needs to be modular enough that we can reuse it from inside the card, from right click etc.  
      
    3\. help me think if theres osmething else to consider
