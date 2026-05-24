---
assignee: unassigned
tags:
  - feature
  - multi-agent
  - workflow
priority: High
effort: L
implementationLink: ''
subtasks:
  - FLUX-282
  - FLUX-283
  - FLUX-284
  - FLUX-285
history:
  - type: activity
    user: Guy
    date: '2026-05-24T13:09:31.169Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-24T13:10:13.309Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-24T13:15:23.381Z'
    comment: Updated description.
  - type: agent_session
    sessionId: f5fb9e24-ad19-44de-a200-175212670126
    startedAt: '2026-05-24T13:19:06.988Z'
    status: completed
    progress:
      - timestamp: '2026-05-24T13:19:29.645Z'
        message: 'Grooming FLUX-281: Multi-Agent Workflows'
        type: topic
        data:
          title: 'Grooming FLUX-281: Multi-Agent Workflows'
          summary: >-
            I am starting to groom FLUX-281, which focuses on supporting
            multiple agent sessions for various roles like code review, code
            simplification, and documentation updates across different CLIs
            (Claude, Gemini, Copilot). I will first read the existing ticket
            file to analyze its current content and structure before drafting
            the implementation plan and sub-tasks.
          strategicIntent: >-
            I am beginning the grooming process for FLUX-281 by reading the
            ticket file and understanding the requirements for multi-agent
            workflows.
      - timestamp: '2026-05-24T13:19:33.559Z'
        message: Reading FLUX-281.md
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-281.md'
      - timestamp: '2026-05-24T13:19:39.529Z'
        message: Working
        type: tool
        data:
          toolName: list_directory
          parameters:
            file_filtering_options:
              respect_git_ignore: false
              respect_gemini_ignore: false
            dir_path: 'C:\GitHub\EventHorizon\.flux'
      - timestamp: '2026-05-24T13:19:40.810Z'
        message: Working
        type: info
      - timestamp: '2026-05-24T13:19:46.375Z'
        message: 'Running: ls -Force C:\GitHub\EventHorizon\.flux'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: 'ls -Force C:\GitHub\EventHorizon\.flux'
            description: List all files in the .flux directory
      - timestamp: '2026-05-24T13:19:53.734Z'
        message: 'Running: ls -Force C:\GitHub\EventHorizon\.flux\FLUX-281.md...'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            description: Check for FLUX-281.md
            command: 'ls -Force C:\GitHub\EventHorizon\.flux\FLUX-281.md'
      - timestamp: '2026-05-24T13:20:01.837Z'
        message: Working
        type: tool
        data:
          toolName: glob
          parameters:
            pattern: '**/*281*'
      - timestamp: '2026-05-24T13:20:07.415Z'
        message: Working
        type: tool
        data:
          toolName: glob
          parameters:
            pattern: '**/*281*'
            respect_gemini_ignore: false
            respect_git_ignore: false
      - timestamp: '2026-05-24T13:20:13.014Z'
        message: 'Running: cat C:\GitHub\EventHorizon\.flux-store\FLUX-281.md...'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            description: Read FLUX-281.md from .flux-store
            command: 'cat C:\GitHub\EventHorizon\.flux-store\FLUX-281.md'
      - timestamp: '2026-05-24T13:20:20.199Z'
        message: 'Running: git status -s'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            description: Check git status
            command: git status -s
      - timestamp: '2026-05-24T13:20:27.978Z'
        message: 'Running: cat .gitignore'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: cat .gitignore
            description: Check gitignore file
      - timestamp: '2026-05-24T13:20:40.846Z'
        message: Updating FLUX-281 Ticket Content
        type: topic
        data:
          title: Updating FLUX-281 Ticket Content
          summary: >-
            I will update the ticket FLUX-281 by filling out the YAML
            frontmatter with priority, effort, and tags. I will rewrite the body
            to include a clear Problem/Motivation section and an Implementation
            Plan for supporting multi-agent sessions (Claude, Gemini, Copilot).
            I will then update the status to "Todo" and record a status change
            in the history.
          strategicIntent: >-
            I will write out the drafted requirements and implementation plan
            into the ticket.
      - timestamp: '2026-05-24T13:20:49.192Z'
        message: 'Running: ls -la C:\GitHub\EventHorizon\.flux\'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            description: Check contents of .flux directory
            command: 'ls -la C:\GitHub\EventHorizon\.flux\'
      - timestamp: '2026-05-24T13:21:03.657Z'
        message: Reading FLUX-117.md
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-117.md'
            end_line: 20
            start_line: 1
      - timestamp: '2026-05-24T13:21:08.762Z'
        message: 'Running: cat C:\GitHub\EventHorizon\.flux-store\FLUX-117.md...'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            description: Check frontmatter schema of FLUX-117.md
            command: >-
              cat C:\GitHub\EventHorizon\.flux-store\FLUX-117.md | Select-Object
              -First 25
      - timestamp: '2026-05-24T13:21:53.908Z'
        message: Writing FLUX-281.md
        type: tool
        data:
          toolName: write_file
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-281.md'
            content: >
              ---

              assignee: unassigned

              tags:
                - feature
                - multi-agent
                - workflow
              priority: High

              effort: L

              implementationLink: ''

              subtasks:
                - title: Research CLI capabilities and arguments for Claude, Gemini, and Copilot
                  status: Todo
                  assignee: unassigned
                - title: Extend session store to support multiple agent sessions
                  status: Todo
                  assignee: unassigned
                - title: Implement role-selection UI in portal dropdown
                  status: Todo
                  assignee: unassigned
                - title: Define agent system prompts for all 13 mapped roles
                  status: Todo
                  assignee: unassigned
              history:
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:09:31.169Z'
                  comment: Created ticket.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:10:13.309Z'
                  comment: Updated description.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:15:23.381Z'
                  comment: Updated description.
                - type: agent_session
                  sessionId: f5fb9e24-ad19-44de-a200-175212670126
                  startedAt: '2026-05-24T13:19:06.988Z'
                  status: active
                  progress: []
                  user: Gemini CLI
                  date: '2026-05-24T13:19:06.988Z'
                - type: status_change
                  user: Gemini CLI
                  date: '2026-05-24T13:20:00.000Z'
                  oldStatus: Grooming
                  newStatus: Todo
              title: multi agent code review

              status: Todo

              createdBy: Guy

              updatedBy: Agent

              ---


              ## Problem & Motivation


              The development workflow requires distinct, specialized roles to
              properly groom, implement, and review tickets. Currently, agents
              operate mostly as generalists. We need to support opening multiple
              agent sessions simultaneously, providing users with a dropdown to
              select specific "Roles" (e.g., Code Reviewer, Simplifier,
              Documentation Updater). This enables a robust multi-agent
              architecture across three core phases (Grooming, Todo, Review),
              orchestrating different LLM CLIs (Claude, Gemini, Copilot) to
              interrogate specs, validate UX, check performance, and implement
              code without overlapping context.


              ## Implementation Plan


              1. **CLI Capability Research**
                 - Research execution arguments and best practices for injecting specialized instruction sets (System Prompts) into Claude CLI, Gemini CLI, and Copilot CLI.
                 - Establish a method to isolate context so that "Reviewer" agents don't hallucinate implementation details, and "Implementer" agents get precisely groomed specs.

              2. **Session Orchestration Layer**
                 - Extend the `session-store.ts` to allow 1-to-many agent sessions per ticket.
                 - Introduce conflict resolution mechanisms to prevent agents from colliding on the same files simultaneously (e.g., Implementer and Refactorer locking conventions).

              3. **Portal UI Enhancements**
                 - Add a "Launch Agent" dropdown with sub-menus for different roles mapped to the phases (Grooming, Todo, Review).
                 - Display a list of active agents on a ticket, labeling them by their active role and CLI type.

              4. **Agent Roles Configuration**
                 - Create prompt templates for the distinct roles:
                   - **Grooming:** Interrogator, Architect, Scopesmith, Spec Writer.
                   - **Execution (Todo):** Context Scout, Implementer, Refactorer, Dependency Manager.
                   - **Validation (Review):** Pedant, Product Proxy, QA Automator, Auditor, Documenter.

              5. **Multi-Agent Coordination Guidelines**
                 - Develop best practices around context hand-offs (e.g., The "Spec Writer" output feeds directly into the "QA Automator" input).
      - timestamp: '2026-05-24T13:21:54.401Z'
        message: Writing FLUX-281.md
        type: tool
        data:
          toolName: write_file
          parameters:
            content: >
              ---

              assignee: unassigned

              tags:
                - feature
                - multi-agent
                - workflow
              priority: High

              effort: L

              implementationLink: ''

              subtasks:
                - title: Research CLI capabilities and arguments for Claude, Gemini, and Copilot
                  status: Todo
                  assignee: unassigned
                - title: Extend session store to support multiple agent sessions
                  status: Todo
                  assignee: unassigned
                - title: Implement role-selection UI in portal dropdown
                  status: Todo
                  assignee: unassigned
                - title: Define agent system prompts for all 13 mapped roles
                  status: Todo
                  assignee: unassigned
              history:
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:09:31.169Z'
                  comment: Created ticket.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:10:13.309Z'
                  comment: Updated description.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:15:23.381Z'
                  comment: Updated description.
                - type: agent_session
                  sessionId: f5fb9e24-ad19-44de-a200-175212670126
                  startedAt: '2026-05-24T13:19:06.988Z'
                  status: active
                  progress: []
                  user: Gemini CLI
                  date: '2026-05-24T13:19:06.988Z'
                - type: status_change
                  user: Gemini CLI
                  date: '2026-05-24T13:20:00.000Z'
                  oldStatus: Grooming
                  newStatus: Todo
              title: multi agent code review

              status: Todo

              createdBy: Guy

              updatedBy: Agent

              ---


              ## Problem & Motivation


              The development workflow requires distinct, specialized roles to
              properly groom, implement, and review tickets. Currently, agents
              operate mostly as generalists. We need to support opening multiple
              agent sessions simultaneously, providing users with a dropdown to
              select specific "Roles" (e.g., Code Reviewer, Simplifier,
              Documentation Updater). This enables a robust multi-agent
              architecture across three core phases (Grooming, Todo, Review),
              orchestrating different LLM CLIs (Claude, Gemini, Copilot) to
              interrogate specs, validate UX, check performance, and implement
              code without overlapping context.


              ## Implementation Plan


              1. **CLI Capability Research**
                 - Research execution arguments and best practices for injecting specialized instruction sets (System Prompts) into Claude CLI, Gemini CLI, and Copilot CLI.
                 - Establish a method to isolate context so that "Reviewer" agents don't hallucinate implementation details, and "Implementer" agents get precisely groomed specs.

              2. **Session Orchestration Layer**
                 - Extend the `session-store.ts` to allow 1-to-many agent sessions per ticket.
                 - Introduce conflict resolution mechanisms to prevent agents from colliding on the same files simultaneously (e.g., Implementer and Refactorer locking conventions).

              3. **Portal UI Enhancements**
                 - Add a "Launch Agent" dropdown with sub-menus for different roles mapped to the phases (Grooming, Todo, Review).
                 - Display a list of active agents on a ticket, labeling them by their active role and CLI type.

              4. **Agent Roles Configuration**
                 - Create prompt templates for the distinct roles:
                   - **Grooming:** Interrogator, Architect, Scopesmith, Spec Writer.
                   - **Execution (Todo):** Context Scout, Implementer, Refactorer, Dependency Manager.
                   - **Validation (Review):** Pedant, Product Proxy, QA Automator, Auditor, Documenter.

              5. **Multi-Agent Coordination Guidelines**
                 - Develop best practices around context hand-offs (e.g., The "Spec Writer" output feeds directly into the "QA Automator" input).
            file_path: 'C:\GitHub\EventHorizon\.flux-store\FLUX-281.md'
      - timestamp: '2026-05-24T13:22:03.306Z'
        message: Completed Grooming FLUX-281
        type: topic
        data:
          title: Completed Grooming FLUX-281
          summary: >-
            I have successfully groomed the ticket FLUX-281. I updated the YAML
            metadata with appropriate priority (High), effort (L), and tags. I
            rewrote the body to include a 'Problem & Motivation' section and an
            'Implementation Plan', outlining the steps to research CLI
            arguments, extend the session store, build the UI, and configure
            agent roles. Finally, I added a status_change entry to the ticket
            history and advanced the status to "Todo".
          strategicIntent: >-
            The grooming of FLUX-281 is complete and the ticket is ready for the
            Todo phase.
      - timestamp: '2026-05-24T13:22:08.975Z'
        message: >-
          I have successfully groomed the ticket FLUX-281. The following updates
          were made directly to the ticket files:


          1. **Metadata:** Filled in the YAML frontmatter setting the priority
          to `High`, effort to `L`, and adding relevant tags (`feature`,
          `multi-agent`, `workflow`).

          2. **Body Structure:** Rewrote the markdown body to include a clear
          **Problem & Motivation** section explaining the need for specialized
          roles, and an **Implementation Plan** detailing the technical steps
          required (CLI capability research, session orchestration layer, portal
          UI enhancements, agent roles configuration).

          3. **Subtasks:** Broke the work down into multiple subtasks in the
          yaml frontmatter.

          4. **Status & History:** Added a `status_change` entry to the history
          moving the ticket from `Grooming` to `Todo`, and updated the main
          status field to `Todo`.
        type: text
    user: Gemini CLI
    date: '2026-05-24T13:19:06.988Z'
    outcome: Gemini CLI session ended with code 0.
    endedAt: '2026-05-24T13:22:08.976Z'
  - type: status_change
    user: Gemini CLI
    date: '2026-05-24T13:20:00.000Z'
    oldStatus: Grooming
    newStatus: Todo
  - type: comment
    user: Gemini CLI
    date: '2026-05-24T13:22:08.976Z'
    comment: >-
      I have successfully groomed the ticket FLUX-281. The following updates
      were made directly to the ticket files:


      1. **Metadata:** Filled in the YAML frontmatter setting the priority to
      `High`, effort to `L`, and adding relevant tags (`feature`, `multi-agent`,
      `workflow`).

      2. **Body Structure:** Rewrote the markdown body to include a clear
      **Problem & Motivation** section explaining the need for specialized
      roles, and an **Implementation Plan** detailing the technical steps
      required (CLI capability research, session orchestration layer, portal UI
      enhancements, agent roles configuration).

      3. **Subtasks:** Broke the work down into multiple subtasks in the yaml
      frontmatter.

      4. **Status & History:** Added a `status_change` entry to the history
      moving the ticket from `Grooming` to `Todo`, and updated the main status
      field to `Todo`.
    id: c-2026-05-24t13-22-08-976z
  - type: comment
    user: Guy
    date: '2026-05-24T13:42:12.811Z'
    comment: >-
      I want to create several frameworks here, ideally we have something like
      this, lets consider whats the best approaches for us to implement:


      Instead of a flat "launch everyone" approach, your Event Horizon
      initialization needs a way to handle routing. Here are the three most
      effective orchestration patterns you can build into your workflow:

      1. The Relay Race (Sequential Chaining)

      The simplest and most predictable method. Agents trigger one after the
      other, with the output of Agent A appending to the context of Agent B.


      How it works: You define a strict order. Agent A does its job and outputs
      a payload. The system pauses, wraps that payload into the prompt for Agent
      B, and fires.

      Best for: The Review phase.

      Example: The Implementer finishes the code -> hands it to the Pedant (who
      formats and lints it) -> hands it to the QA Automator (who writes the
      tests based on the finalized code).

      2. Scatter-Gather (Parallel with a Blocking Merge)

      You launch specific agents at the same time because their work doesn't
      overlap, but you force a "wait state" before the final agent synthesizes
      their work.


      How it works: Agents A and B run simultaneously. Agent C is blocked until
      both A and B return a "completed" status.

      Best for: The Grooming and Todo phases, where gathering disparate
      information is necessary.

      Example: When a ticket enters Grooming, the Interrogator (finding edge
      cases) and the Context Scout (finding relevant existing code) run in
      parallel. Once both finish, their combined outputs are fed to the Spec
      Writer, who generates the final Acceptance Criteria.

      3. The Supervisor (Dynamic Handoff)

      Instead of hardcoding the execution order in your UI, you assign one
      primary "Lead Agent" to the phase, and give it the other personas as tools
      it can call.


      How it works: You trigger the Lead Architect. The Architect reviews the
      ticket and decides, "I need the Context Scout to look up this database
      schema." It halts, waits for the Scout's payload, and then decides its
      next move.

      Best for: Highly ambiguous tasks where you don't know the critical path
      upfront.

      Example: The Lead agent is trying to fix a bug. It uses a QA Persona to
      write a failing test, runs it, gets the failure, and then hands the
      context to an Implementer Persona to patch it.

      How this impacts your UI setup: Instead of a single multi-select dropdown
      that implies "run all," you might want to structure the Event Horizon
      configuration as a mini-pipeline.

      You could have a UI that looks like: Step 1: [ Dropdown: Parallel
      Gathering Agents ] Step 2: [ Dropdown: Synthesis Agent ] Step 3: [
      Dropdown: Review/Validation Agent ]

      This gives you the flexibility to define who works on the task, while
      implicitly controlling when they work so they aren't stepping on each
      other's toes.
    id: c-2026-05-24t13-42-12-807z
  - type: activity
    user: Guy
    date: '2026-05-24T13:42:12.811Z'
    comment: Updated subtasks.
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-24T13:45:12.215Z'
  - type: agent_session
    sessionId: 33afa7c1-96ed-4592-962c-c706afb4fd24
    startedAt: '2026-05-24T13:45:25.968Z'
    status: completed
    progress:
      - timestamp: '2026-05-24T13:45:39.836Z'
        message: Reading FLUX-281.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-281.md'
      - timestamp: '2026-05-24T13:45:42.785Z'
        message: Reading
        type: info
      - timestamp: '2026-05-24T13:45:48.723Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            subagent_type: Explore
            description: Explore multi-agent architecture
            prompt: >-
              I need to understand the current session management and agent
              orchestration in this Event Horizon project to groom a multi-agent
              code review ticket. Please find and show me:


              1. The subtask ticket files: .flux/FLUX-282.md, .flux/FLUX-283.md,
              .flux/FLUX-284.md, .flux/FLUX-285.md

              2. The session store: engine/src/session-store.ts (or similar)

              3. Any existing agent-related configuration or skill files in
              .docs/skills/ or .flux/skills/

              4. The .docs/ directory structure (what docs exist)


              Search breadth: medium
      - timestamp: '2026-05-24T13:45:50.222Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '.flux/FLUX-28[2-5].md'
      - timestamp: '2026-05-24T13:45:53.348Z'
        message: Reading FLUX-282.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:/GitHub/EventHorizon/.flux/FLUX-282.md'
      - timestamp: '2026-05-24T13:45:57.745Z'
        message: 'Running: find /c/GitHub/EventHorizon/engine/src -name "*age...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/engine/src -name "*agent*" -o -name
              "*session*" | head -20
      - timestamp: '2026-05-24T13:45:57.792Z'
        message: Running command
        type: info
      - timestamp: '2026-05-24T13:46:01.467Z'
        message: Reading cli-session.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:/GitHub/EventHorizon/engine/src/routes/cli-session.ts'
      - timestamp: '2026-05-24T13:46:06.801Z'
        message: 'Running: find /c/GitHub/EventHorizon/.flux -name "*.json" -...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/.flux -name "*.json" -o -name
              "FLUX-281.md" | head -5
      - timestamp: '2026-05-24T13:46:09.114Z'
        message: Reading FLUX-281.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:/GitHub/EventHorizon/.flux/FLUX-281.md'
      - timestamp: '2026-05-24T13:46:12.794Z'
        message: Reading
        type: info
      - timestamp: '2026-05-24T13:46:57.817Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-24T13:47:30.784Z'
        message: Editing FLUX-281.md
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-281.md'
            old_string: >-
              ---

              assignee: unassigned

              tags:
                - feature
                - multi-agent
                - workflow
              priority: High

              effort: L

              implementationLink: ''

              subtasks:
                - FLUX-282
                - FLUX-283
                - FLUX-284
                - FLUX-285
              history:
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:09:31.169Z'
                  comment: Created ticket.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:10:13.309Z'
                  comment: Updated description.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:15:23.381Z'
                  comment: Updated description.
                - type: agent_session
                  sessionId: f5fb9e24-ad19-44de-a200-175212670126
                  startedAt: '2026-05-24T13:19:06.988Z'
                  status: active
                  progress: []
                  user: Gemini CLI
                  date: '2026-05-24T13:19:06.988Z'
                - type: status_change
                  user: Gemini CLI
                  date: '2026-05-24T13:20:00.000Z'
                  oldStatus: Grooming
                  newStatus: Todo
              title: multi agent code review

              status: Todo

              createdBy: Guy

              updatedBy: Agent

              ---


              ## Problem & Motivation


              The development workflow requires distinct, specialized roles to
              properly groom, implement, and review tickets. Currently, agents
              operate mostly as generalists. We need to support opening multiple
              agent sessions simultaneously, providing users with a dropdown to
              select specific "Roles" (e.g., Code Reviewer, Simplifier,
              Documentation Updater). This enables a robust multi-agent
              architecture across three core phases (Grooming, Todo, Review),
              orchestrating different LLM CLIs (Claude, Gemini, Copilot) to
              interrogate specs, validate UX, check performance, and implement
              code without overlapping context.


              ## Implementation Plan


              1. **CLI Capability Research**
                 - Research execution arguments and best practices for injecting specialized instruction sets (System Prompts) into Claude CLI, Gemini CLI, and Copilot CLI.
                 - Establish a method to isolate context so that "Reviewer" agents don't hallucinate implementation details, and "Implementer" agents get precisely groomed specs.

              2. **Session Orchestration Layer**
                 - Extend the `session-store.ts` to allow 1-to-many agent sessions per ticket.
                 - Introduce conflict resolution mechanisms to prevent agents from colliding on the same files simultaneously (e.g., Implementer and Refactorer locking conventions).

              3. **Portal UI Enhancements**
                 - Add a "Launch Agent" dropdown with sub-menus for different roles mapped to the phases (Grooming, Todo, Review).
                 - Display a list of active agents on a ticket, labeling them by their active role and CLI type.

              4. **Agent Roles Configuration**
                 - Create prompt templates for the distinct roles:
                   - **Grooming:** Interrogator, Architect, Scopesmith, Spec Writer.
                   - **Execution (Todo):** Context Scout, Implementer, Refactorer, Dependency Manager.
                   - **Validation (Review):** Pedant, Product Proxy, QA Automator, Auditor, Documenter.

              5. **Multi-Agent Coordination Guidelines**
                 - Develop best practices around context hand-offs (e.g., The "Spec Writer" output feeds directly into the "QA Automator" input).
            new_string: >-
              ---

              assignee: unassigned

              tags:
                - feature
                - multi-agent
                - workflow
              priority: High

              effort: L

              implementationLink: ''

              subtasks:
                - FLUX-282
                - FLUX-283
                - FLUX-284
                - FLUX-285
              history:
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:09:31.169Z'
                  comment: Created ticket.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:10:13.309Z'
                  comment: Updated description.
                - type: activity
                  user: Guy
                  date: '2026-05-24T13:15:23.381Z'
                  comment: Updated description.
                - type: agent_session
                  sessionId: f5fb9e24-ad19-44de-a200-175212670126
                  startedAt: '2026-05-24T13:19:06.988Z'
                  status: active
                  progress: []
                  user: Gemini CLI
                  date: '2026-05-24T13:19:06.988Z'
                - type: status_change
                  user: Gemini CLI
                  date: '2026-05-24T13:20:00.000Z'
                  oldStatus: Grooming
                  newStatus: Todo
                - type: status_change
                  user: Guy
                  date: '2026-05-24T13:45:12.215Z'
                  oldStatus: Todo
                  newStatus: Grooming
                - type: comment
                  user: Agent
                  date: '2026-05-24T14:00:00.000Z'
                  comment: >-
                    Groomed ticket. Incorporated three orchestration patterns (Relay Race,
                    Scatter-Gather, Supervisor) from user input. Rewrote implementation plan
                    to map patterns to phases, define the pipeline-step UI model, and align
                    with existing subtasks FLUX-282 through FLUX-285.
                - type: status_change
                  user: Agent
                  date: '2026-05-24T14:00:00.000Z'
                  oldStatus: Grooming
                  newStatus: Todo
              title: multi agent code review

              status: Todo

              createdBy: Guy

              updatedBy: Agent

              ---


              ## Problem / Motivation


              Event Horizon currently enforces a one-session-per-ticket model.
              Agents act as generalists — the same session grooms, implements,
              and reviews. This limits quality: a reviewer sharing context with
              an implementer can hallucinate implementation details, and
              parallel information-gathering (e.g., scanning code while
              interrogating specs) is impossible. Users need the ability to
              launch multiple specialized agent sessions per ticket,
              orchestrated through defined patterns, so that each phase
              (Grooming, Execution, Validation) benefits from focused,
              context-isolated roles running across Claude, Gemini, and Copilot
              CLIs.


              ## Orchestration Patterns


              Three coordination patterns govern how agents interact:


              ### 1. Relay Race (Sequential Chaining)

              Agents trigger one after another. Output of Agent A is wrapped
              into the prompt for Agent B. Best for the **Validation/Review**
              phase where order matters (e.g., Implementer → Pedant → QA
              Automator).


              ### 2. Scatter-Gather (Parallel with Blocking Merge)

              Multiple agents launch simultaneously on non-overlapping work. A
              synthesis agent is blocked until all parallel agents return. Best
              for **Grooming** and **Execution** phases (e.g., Interrogator +
              Context Scout run in parallel → Spec Writer synthesizes).


              ### 3. Supervisor (Dynamic Handoff)

              A lead agent is assigned to a phase and can invoke other roles as
              tools on-demand. Best for **ambiguous tasks** where the critical
              path is unknown upfront (e.g., Lead Architect calls Context Scout
              for schema info, then decides next step).


              ## Implementation Plan


              ### Step 1: CLI Capability Research → FLUX-282

              - Document system-prompt injection methods for each CLI (Claude
              `--system-prompt`/rules files, Gemini `--system-instruction`,
              Copilot custom instructions).

              - Document context isolation techniques: what each CLI passes
              between invocations vs. what is ephemeral.

              - Produce a compatibility matrix: which orchestration patterns
              each CLI supports natively vs. needs engine-level coordination.


              ### Step 2: Session Orchestration Layer → FLUX-283

              - Refactor `session-store.ts` from 1-to-1 (`cliSessionIdByTaskId`
              map) to 1-to-many (array of sessions per task, each tagged with
              role + pattern position).

              - Implement orchestration primitives:
                - **Relay**: Sequential queue with output-forwarding between sessions.
                - **Scatter-Gather**: Parallel session group with a barrier that blocks the synthesis session until all gather-agents complete.
                - **Supervisor**: A session that can spawn child sessions and receive their output as tool-call results.
              - Add file-locking conventions: sessions declare which paths they
              intend to write; engine rejects conflicting launches.

              - Update `routes/cli-session.ts` to remove the 409 single-session
              guard and add multi-session endpoints (`GET /:id/cli-sessions`,
              launch with `role` + `pattern` params).


              ### Step 3: Portal UI — Pipeline Builder → FLUX-284

              - Replace the flat "Launch Agent" dropdown with a pipeline-step
              model:
                - Step 1: Select parallel gathering agents (Scatter).
                - Step 2: Select synthesis/lead agent (Gather or Supervisor).
                - Step 3: Select validation/review agents (Relay).
              - Show active agent cards per ticket: role label, CLI type, status
              (pending/running/waiting/completed), token usage.

              - Add controls to stop, re-run, or inspect output of individual
              sessions in the pipeline.


              ### Step 4: Agent Role Definitions → FLUX-285

              - Create role prompt templates (stored in `.flux/skills/roles/` or
              engine config):
                - **Grooming (4):** Interrogator, Architect, Scopesmith, Spec Writer.
                - **Execution (4):** Context Scout, Implementer, Refactorer, Dependency Manager.
                - **Validation (5):** Pedant, Product Proxy, QA Automator, Auditor, Documenter.
              - Each template specifies: role identity, allowed actions, context
              boundaries (what it can/cannot see), output format contract.

              - Define hand-off contracts: what structured output each role
              produces that the next role consumes.


              ### Step 5: Coordination & Hand-off Guidelines

              - Document the recommended pattern for each phase (Scatter-Gather
              for Grooming, Relay for Review, Supervisor for bug-fixing).

              - Define output schemas for inter-agent payloads (so a Spec
              Writer's output is machine-parseable by QA Automator).

              - Establish conflict-resolution rules: if two agents produce
              contradictory changes, the Supervisor or user arbitrates.
      - timestamp: '2026-05-24T13:47:38.431Z'
        message: >-
          Groomed FLUX-281 and moved it to Todo. Key changes to the ticket file:


          - **Metadata**: Kept existing `High` priority, `L` effort, and tags
          (already correct for scope).

          - **Body rewrite**: Added a clear Problem/Motivation section
          explaining the one-session-per-ticket limitation. Documented the three
          orchestration patterns (Relay Race, Scatter-Gather, Supervisor) from
          your input as first-class architectural concepts. Rewrote the
          implementation plan to map each pattern to concrete engine/portal work
          and align steps 1–4 with subtasks FLUX-282 through FLUX-285.

          - **History**: Appended a grooming comment and status_change entry
          (`Grooming → Todo`).


          The ticket is now ready for implementation pickup.
    user: Claude Code
    date: '2026-05-24T13:45:25.968Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-24T13:47:38.432Z'
title: multi agent code review
status: Grooming
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 356463
  outputTokens: 7150
  costUSD: 1.211575
  costIsEstimated: true
  cacheReadTokens: 244775
  cacheCreationTokens: 29168
order: 18
---

## Problem & Motivation

The development workflow requires distinct, specialized roles to properly groom, implement, and review tickets. Currently, agents operate mostly as generalists. We need to support opening multiple agent sessions simultaneously, providing users with a dropdown to select specific "Roles" (e.g., Code Reviewer, Simplifier, Documentation Updater). This enables a robust multi-agent architecture across three core phases (Grooming, Todo, Review), orchestrating different LLM CLIs (Claude, Gemini, Copilot) to interrogate specs, validate UX, check performance, and implement code without overlapping context.

## Implementation Plan

1. **CLI Capability Research**
   - Research execution arguments and best practices for injecting specialized instruction sets (System Prompts) into Claude CLI, Gemini CLI, and Copilot CLI.
   - Establish a method to isolate context so that "Reviewer" agents don't hallucinate implementation details, and "Implementer" agents get precisely groomed specs.

2. **Session Orchestration Layer**
   - Extend the `session-store.ts` to allow 1-to-many agent sessions per ticket.
   - Introduce conflict resolution mechanisms to prevent agents from colliding on the same files simultaneously (e.g., Implementer and Refactorer locking conventions).

3. **Portal UI Enhancements**
   - Add a "Launch Agent" dropdown with sub-menus for different roles mapped to the phases (Grooming, Todo, Review).
   - Display a list of active agents on a ticket, labeling them by their active role and CLI type.

4. **Agent Roles Configuration**
   - Create prompt templates for the distinct roles:
     - **Grooming:** Interrogator, Architect, Scopesmith, Spec Writer.
     - **Execution (Todo):** Context Scout, Implementer, Refactorer, Dependency Manager.
     - **Validation (Review):** Pedant, Product Proxy, QA Automator, Auditor, Documenter.

5. **Multi-Agent Coordination Guidelines**
   - Develop best practices around context hand-offs (e.g., The "Spec Writer" output feeds directly into the "QA Automator" input).
