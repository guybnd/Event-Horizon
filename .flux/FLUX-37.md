---
id: FLUX-37
title: bootstrap project flux orchestrator MVP
status: Grooming
priority: High
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - architecture
  - mvp
  - agent
history:
  - type: comment
    user: Agent
    date: '2026-05-06T12:20:00.000Z'
    comment: >-
      Converted the Project Flux master specification into a grooming ticket for
      the first MVP delivery slice. This captures the core lifecycle, strict
      constraints, and an initial decomposition around the three requested
      integration points.
    id: c-2026-05-06t12-20-00-000z
effort: XL
implementationLink: ''
---
## Objective

Establish the first working version of Project Flux as an orchestrator for
agent-driven software delivery. The MVP should let a human create and move
ticket files locally while the system reacts through the engine, the portal,
and agent-facing context tooling without requiring cloud services or manual
state synchronization.

## Why This Ticket Exists

The current product already has the foundation of a local ticket board,
filesystem-backed tasks, and a portal. This ticket defines the next product
step: evolve Event Horizon into Flux, where the repository is not just a task
store but an active orchestration system that can:

- turn raw human input into a structured proposal
- detect work entering or leaving active states
- scope agent context down to the active ticket
- verify completed work through a separate Sentry flow
- keep git state and ticket state aligned at all times

## MVP Scope

The first delivery slice should focus on the three integration points that make
the rest of the vision credible.

### 1. Git-File Watcher
- Detect when a task file is renamed, moved between logical states, or edited in a way that changes status
- Detect when the active git branch changes outside the portal, including terminal-driven checkout flows
- Reflect those changes back into portal state quickly enough that the board is trustworthy as a live view
- Treat filesystem and git state as the source of truth, not portal-local UI state

### 2. MCP Context Provider
- Expose an agent-facing context tool that returns a clean-slate working set for the active ticket
- Prefer only the relevant files, dependencies, requirements, and neighboring code paths instead of the whole repository
- Make the context deterministic enough that different agent runs start from the same bounded slice
- Support the execution workflow where an agent claims a ticket, reads only ticket-linked context, and resumes when the ticket file changes

### 2a. Dual-Mode Execution Bridge
- Introduce an execution abstraction that lets Flux either wait for an external agent or directly orchestrate an internal LLM run
- Make the ticket state machine explicit about who currently holds the pen: user, external agent, or Flux internal AI
- Ensure both execution modes write back to the same ticket file and board state so the UI behaves consistently
- Treat external execution as watcher-driven and internal execution as prompt-and-apply driven without splitting the product into separate workflows

### 3. Sentry Summary
- Build a standalone verification summarizer that accepts git diff plus test output as inputs
- Produce a short human-readable summary that a product manager can scan in about 10 seconds
- Report what changed, what was validated, what failed, and what still looks risky
- Keep this logic modular so the same contract can later support web, Unity, Godot, or other project types

## Primary User Flow

The MVP should make this human-visible lifecycle explicit in both the portal and
the ticket model.

### 1. Idea intake
- A user enters open-ended text into an input surface in the portal
- The text may represent an idea, a bug, a feature request, or a rough task
- The original raw text should be preserved so the source intent is never lost

### 2. Proposal generation
- An AI-assisted step parses the raw input into a structured proposal for review
- The proposal should classify the work, such as bug, feature, chore, or research
- The proposal should suggest priority, scope, candidate subtasks, acceptance criteria, and follow-up questions
- If the input is incomplete, the system should surface the unanswered questions instead of pretending the ticket is execution-ready

### 3. Ticket confirmation
- The user reviews the proposal, edits anything inaccurate, and fills in missing details
- Once the proposal is complete enough to execute, it is promoted into a proper ticket in `Todo`
- The ticket should now contain execution-facing details for an agent, not only a brainstorm summary

### 4. Active execution
- A user or agent explicitly chooses the ticket and moves it into `In Progress`
- The preferred mode is to create or attach the ticket to a dedicated git branch
- The user should also be able to choose whether the executor is an external agent or Flux internal AI
- The active work view should show acceptance criteria, code diff, linked files, relevant docs, and outstanding questions
- During execution, the agent can ask follow-up questions and pause until the user responds
- The same workflow must support both user-led work and agent-led work

### 5. Sentry gate before completion
- Before finalizing the work, the ticket enters a Sentry phase
- The Sentry view should show which tests were run, which passed or failed, and which new tests were added for the change
- The Sentry output should summarize whether the work appears complete relative to the acceptance criteria

### 6. Git and PR finalization
- Once approved, commits are recorded and the relevant branch or diff is prepared for sharing
- The system should assemble the information needed for a PR, including summary text, acceptance criteria coverage, key files changed, and validation results
- Git actions performed manually by the user should still be reflected back into the ticket and portal state

## Branch Operating Model

Dedicated branches are the preferred execution mode, but Flux must also work
when changes are made outside a Flux-created branch.

### Preferred mode
- Moving a ticket into `In Progress` can create or attach to a dedicated branch such as `feature/FLUX-37`
- Flux should treat a dedicated branch as the cleanest unit for diffing, verification, and PR preparation
- Flux should verify that the working directory is clean before starting execution in either internal or external mode

### Outside-branch or pre-existing work
- Flux must detect when a user is working on `main`, on a manually created branch, or on a branch containing multiple tickets
- In that case, Flux should still be able to attach the ticket to the current git context and reason over the best available scoped diff
- The UI should distinguish between `branch-owned work` and `attached work` so it does not overstate certainty
- If branch isolation is weak, Sentry and proposal flows should warn about noisy diffs or mixed scope instead of blocking all progress
- If the working tree is already dirty, Flux should block execution start or require an explicit user override with a clear warning

## Dual-Mode Execution Model

Flux should support two execution modes behind one shared orchestration layer.

### Mode A. Passive watcher
- Flux moves the ticket into a waiting state for an external agent
- Flux exposes ticket context over MCP and watches the ticket file and repo state for progress
- The external agent performs the work and updates the ticket or linked files through its own tooling
- Flux reacts to those changes and advances the board without pretending it authored the code edits itself

### Mode B. Active orchestrator
- Flux moves the ticket into an internal execution state
- Flux gathers ticket requirements and linked code context, builds a structured prompt, and calls an LLM API directly
- Flux validates the returned file operations before applying them locally
- Flux remains responsible for recording execution progress, validation artifacts, and final git handoff

### Shared invariants
- Both modes must write progress back to the same ticket artifact
- Both modes must surface the same human checkpoints for follow-up questions, sentry review, and completion approval
- Both modes must run the same clean-working-tree preflight before execution starts
- Both modes must leave enough metadata on the ticket to show which executor ran and how confident Flux is in the resulting diff

### Minimum MVP requirement
- The product must support both `managed branch` and `attached to current branch` workflows
- The engine must detect branch changes even when they happen outside the portal
- The ticket model must carry enough metadata to know whether the current work is isolated, shared, or branchless

## Workflow Target

The MVP should move toward this lifecycle, even if some steps are still manual in the first version:

1. A user enters open text describing an idea, task, bug, or feature.
2. The engine invokes an AI proposal step that converts that text into a structured review artifact.
3. The user answers missing questions or edits the proposal until it becomes an execution-ready ticket.
4. The completed ticket lands in `Todo` and becomes eligible for human or agent pickup.
5. Starting the ticket moves it into `In Progress` and either creates a dedicated branch or attaches the ticket to the current git context.
6. The user chooses an execution mode: external agent or Flux internal AI.
7. The working surface shows acceptance criteria, code diff, relevant docs, outstanding follow-up questions, and executor status.
8. A coding agent or human completes the work while Flux records ticket and git progress.
9. A Sentry flow validates the change and writes back a concise verification artifact.
10. Flux prepares commit and PR context, then the work can be merged and archived.

## Constraints

- Zero-setup runtime remains a product goal; long-term direction is a single `flux.exe` entry point
- Filesystem state must remain canonical
- Every meaningful ticket update should be compatible with git-atomic workflows; no floating project state
- Execution cannot start from a dirty working tree unless the user explicitly overrides the warning model
- Sentry logic must be decoupled from any one framework so it can be swapped per project type
- The portal should expose human checkpoints rather than hiding critical state transitions inside the agent loop

## Non-Goals For This Ticket

- Full autonomous multi-agent execution across every lifecycle phase
- Final packaging into a production single binary
- Full visual diff infrastructure for every framework from day one
- Automatic changelog and README generation beyond defining the integration seam
- Solving every branch-merge edge case before the watcher and summarizer contracts are stable

## Deliverables

### A. Live synchronization contract
- Define how file rename, status mutation, and branch changes are detected
- Define which engine events are emitted and which portal surfaces react
- Prove that manual terminal actions can move the visible state in the UI
- Define how ticket state stays coherent when the current branch was not created by Flux
- Define how external-agent file changes are reflected in near real time through the same board update path

### B. Ticket-scoped context contract
- Define the MCP-facing API or skill surface for retrieving active ticket context
- Define how a ticket references relevant files, code areas, or dependency context
- Define fallback behavior when the ticket has weak or missing context
- Define how proposal-stage questions and user follow-up answers become part of the execution context
- Define how linked files in ticket metadata become the canonical context payload for both external and internal execution

### C. Verification summary contract
- Define the input model for diff plus test results
- Define the output model for a short review summary plus residual risk notes
- Ensure the module can be invoked independently of portal rendering concerns
- Define how Sentry reports confidence when the diff comes from a mixed or non-isolated branch

### D. Execution bridge contract
- Define the backend executor interface and the minimal lifecycle methods it must support
- Define the ticket statuses or metadata values that represent waiting for external work versus internal execution in progress
- Define the preflight checks, especially branch attachment and clean-working-tree validation, that both modes must share

## Proposed Child Tickets

These should be created as atomic follow-up tickets once this grooming ticket is approved.

1. Watch `.flux` ticket renames and status changes and publish board updates.
2. Detect external git branch switches and refresh active work state in the portal.
3. Implement idea intake and proposal generation from raw open-text input.
4. Define the proposal schema for classification, subtasks, missing questions, and acceptance criteria.
5. Define active-ticket metadata needed to derive minimal coding context.
6. Implement MCP context provider for ticket-scoped file and requirement retrieval.
7. Wire agent resume behavior to ticket-file updates and blocker responses.
8. Define a framework-agnostic Sentry summary input and output schema.
9. Implement the first Sentry summarizer for git diff plus local test output.
10. Surface verification summaries and review checkpoints in the portal.
11. Define git-atomic rules for ticket updates, micro-commits, branch attachment, and review transitions.
12. Define the dual-mode execution bridge and executor lifecycle.
13. Implement the internal API orchestrator with safe file-apply rules.
14. Add execution-mode controls in settings and on ticket cards.

## Acceptance Criteria

- [ ] The ticket clearly defines the MVP around the Git-File Watcher, MCP Context Provider, and Sentry Summary
- [ ] The ticket clearly defines the intake-to-proposal-to-execution flow for human and agent collaboration
- [ ] The ticket preserves the product constraints of filesystem-first state, modular Sentry logic, and git-atomic updates
- [ ] The ticket explains how Flux behaves when work is not isolated in a Flux-created branch
- [ ] The ticket defines how the same board flow supports both external-agent and internal-AI execution
- [ ] The ticket is decomposable into atomic implementation tasks without requiring a second architecture rewrite
- [ ] The workflow distinguishes human checkpoints from agent-automated actions
- [ ] The proposed next tasks are small enough to begin implementation immediately after approval

## Likely Affected Areas

- `engine/src/index.ts`
- `engine/src/skill-installer.ts`
- `portal/src/App.tsx`
- `portal/src/api.ts`
- `portal/src/components/Board.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/components/Settings.tsx`
- `portal/src/components/TaskModal.tsx`
- `portal/src/types.ts`
- `.flux/config.json`
- `.flux/skills/event-horizon-agent.md`

## Open Questions

- Should the first seed artifact be a dedicated `VISION-*.md` type, or should it reuse the existing ticket schema with a different status?
- Should proposal artifacts live as standalone reviewable files, transient records, or as an early state of the final ticket file?
- Should branch naming be enforced from ticket metadata alone, or can the first version rely on convention plus detection?
- What is the minimum diff-scoping rule when one branch contains work for more than one ticket?
- Should execution mode be stored globally, per ticket, or both with a per-ticket override?
- Which ticket statuses should represent `waiting for external agent` and `executing internal ai` without making board configuration brittle?
- Where should transient verbose agent logs live so they remain inspectable but excluded from normal ticket noise?
- Does the first portal release need deep IDE links immediately, or is that a follow-up once verification artifacts exist?

## Agent Prompt Seed

Using the Flux Master Specification, generate a series of atomic work tasks to
build the MVP. Start from the flow of raw idea input, AI proposal generation,
user confirmation into `Todo`, execution in `In Progress`, Sentry validation,
and git or PR finalization. Focus first on the Git-File Watcher, the MCP
Context Provider, and the Sentry Summary. Preserve filesystem-first state,
modular verification, git-atomic ticket updates, and support for work that may
be attached to an existing branch instead of always living on a Flux-managed
branch. Also define a dual-mode execution bridge so the same ticket can either
wait for an external agent over MCP or be executed by Flux through a direct LLM
API call with safe file application.
