// FLUX-1377: the always-on core — a compact (~2-4k tok) invariant set every session gets,
// replacing the full 6-module concatenation (~17.4k tok) previously installed for Claude.
//
// CORE_INVARIANTS is the single source for the persistence/workflow rules that used to be
// hand-duplicated between mcp-server.ts's MCP `instructions` block and the installed
// `.claude/rules/event-horizon.md` orchestrator content — edit here only; both consumers
// render from this same array, so the two can never drift (AC3).
export const CORE_INVARIANTS: readonly string[] = [
  'NEVER edit files under .flux/ or .flux-store/ directly — those paths are engine-managed. All ticket changes go through the event-horizon MCP tools.',
  'Read a ticket with get_ticket before acting on it. Find tickets with list_tickets; read board config with get_board_config.',
  'Move tickets between columns with change_status (NOT update_ticket). A comment is REQUIRED when moving to Require Input (the question) or Ready (the completion summary).',
  'End every working turn on a board action (status move / Require Input / created subtasks). Never finish work and only summarize in chat — the board flags such tickets "Needs Action".',
  'Raise ANY decision or question for the user through a structured surface — ask_user_question or a Require Input status — never plain chat prose, regardless of ticket status.',
  'Destructive actions (archive, merge_tickets, finish_ticket) are one-way or removal operations and may require explicit human approval.',
];

/** The compact MCP server `instructions` block folded into every client's system prompt at
 * `initialize` (mcp-server.ts). Kept short — it bills every session — so it carries the
 * invariants only, not the routing table / ticket model that the installed core adds. */
export function buildCoreInstructionsBlock(): string {
  return [
    'Event Horizon is a local-first, markdown-backed ticket board. Manage tickets EXCLUSIVELY through these tools.',
    '',
    'Rules:',
    ...CORE_INVARIANTS.map((rule) => `- ${rule}`),
  ].join('\n');
}

/** Bump when CORE_INVARIANTS or the document body below changes, so
 * `checkSkillVersionStaleness` (workflow-installer.ts) flags existing Claude installs (still
 * carrying the old 6-module concatenation) as stale and refreshes them to the trimmed core.
 * MUST stay in lockstep with the orchestrator module's `Version:` line — staleness compares the
 * SOURCE orchestrator version against the INSTALLED file's stamp (this constant), so a mismatch
 * makes every refreshed install immediately stale again (perpetual reinstall loop). */
export const CORE_SKILL_VERSION = '2.14.0';

/**
 * The document installed to `.claude/rules/event-horizon.md` for the `claude` framework
 * (workflow-installer.ts) — invariants + a phase-routing table, NOT the 6-module
 * concatenation every other framework still gets. Phase content is engine-injected at spawn
 * for agent sessions (`buildInitialPrompt`, agents/shared.ts) or Read on demand by humans.
 */
export function buildCoreSkillDocument(): string {
  const invariantBullets = CORE_INVARIANTS.map((rule) => `- ${rule}`).join('\n');
  return `---
title: Event Horizon Core
order: 0
---
> ⚠️ DO NOT DELETE — Required for Event Horizon agent workflow.

# Event Horizon Agent — Core

Version: ${CORE_SKILL_VERSION}

Event Horizon is a local-first ticket board backed by markdown files (\`.flux/\` in-repo, or \`.flux-store/\` in orphan mode). Agents interact exclusively through MCP tools — never touch ticket files directly.

This is the always-on core (invariants + routing). Phase-specific guidance (grooming/implementation/review/release/mapping workflow detail) lives in the module bodies below and is NOT loaded here — agent-spawned grooming/implementation/review sessions get their phase module injected automatically; everyone else pulls it on demand via the \`read_skill\` MCP tool (\`read_skill(module, section?)\` — never a file path, which may not exist outside the engine install).

## Phase Routing — pull the matching module before acting

| Ticket Status | Module to Pull |
|---|---|
| \`Grooming\`, \`Require Input\` | \`read_skill('grooming')\` |
| \`Todo\`, \`In Progress\` | \`read_skill('implementation')\` |
| \`Ready\` — review-phase / reviewer-of-record sessions | \`read_skill('review')\` |
| Release orchestration | \`read_skill('release')\` |
| Cross-project mapping (multi-repo group) | \`read_skill('mapping')\` |

\`read_skill('orchestrator')\` carries the fuller ticket model, REST API table, and end-to-end checklist referenced below; pass a \`section\` (e.g. \`'Rich Artifacts'\`, \`'Persisting Changes'\`) to pull just that part. Read-only tasks (explanation, search, discussion) need no phase module.

MCP tool schemas carry only the behavioral contract (required/refused/shape) — rationale, edge cases, and disambiguation for a specific tool live in \`read_skill('tools', '<tool-name>')\`, one section per registered tool name.

## Ticket Model (essentials)

| Field | Notes |
|---|---|
| \`id\` | e.g. \`FLUX-41\` — set by engine, never change |
| \`status\` | Board column (e.g. \`Grooming\`, \`Todo\`, \`In Progress\`, \`Ready\`, \`Done\`) |
| \`body\` | Description / plan. MUST open with a one-glance, plain-language **TL;DR** blockquote |
| \`subtasks\` | Child ticket IDs — use \`create_ticket\` with \`parentId\` to add |
| \`branch\` | Git branch name — set by \`branch\` (\`action:'create'\`) or the portal Start Task prompt |

History is an append-only event log, read via \`get_ticket\` (digested — older entries collapse to a \`summary\`; pass \`expand:[ids]\` to un-collapse) and appended via \`add_note\`/\`change_status\`. Never construct history entries manually.

## Persisting Changes — CRITICAL

All ticket updates — status changes, metadata, body rewrites, history comments — **MUST** use the MCP tools below. Never use \`Write\`/\`Edit\`/\`Bash\` on \`.flux/\` or \`.flux-store/\`, and never \`curl\` the REST API when MCP tools are available. Direct file writes bypass schema validation and history normalization and can corrupt tickets.

${invariantBullets}

### MCP Tools (use these — they appear in your tool list)

| Tool | Use When |
|---|---|
| \`get_ticket\` / \`list_tickets\` / \`get_board_config\` | Reading a ticket / finding tickets / checking valid statuses+tags |
| \`read_skill\` | Pulling a skill module's (or one \`##\` section's) full text on demand |
| \`create_ticket\` | Creating a new ticket — pass \`parentId\` for a linked subtask |
| \`update_ticket\` | Changing metadata ONLY (title, priority, effort, tags, assignee, body) — does NOT move status |
| \`change_status\` | Moving to a new status (comment required for Require Input/Ready) |
| \`add_note\` | Adding a \`type:'comment'\` or \`type:'activity'\` entry to ticket history |
| \`finish_ticket\` | Atomic: implementationLink + completion comment + status → Done (pushes/opens a PR if the ticket has a branch) |
| \`branch\` | \`action:'create'\` makes a feature branch + worktree; \`'status'\`/\`'delete'\` manage it |
| \`archive\` | Reversible remove-from-board (\`action:'unarchive'\` restores it) |
| \`extract_ticket\` / \`merge_tickets\` | Human-approved-only board restructuring (carve a chat slice out / fold streams together) |

There is **no** \`switch_branch\` tool — stay on the ticket's branch for the full session.

## End-of-Turn Action Contract — CRITICAL (FLUX-651/826)

- **End every working turn on a board action.** When you finish grooming/implementing/reviewing a ticket — including in a chat/discussion session — end the turn by moving the ticket to its next status (or \`Require Input\`, or creating subtasks). Never finish the work and just summarize it in chat. A ticket left parked in a working status (\`Grooming\` / \`In Progress\`) without an action is flagged **"Needs Action"** and the user is notified.
- **Raise decisions through a structured surface, regardless of status.** Any question or decision for the user goes through \`ask_user_question\` or \`Require Input\` — never chat prose. This holds on resting/terminal tickets too (Done/Ready/Todo/Backlog/Released/Archived).

## Critical Rules

- NEVER use Write, Edit, or Bash to modify files in \`.flux/\` or \`.flux-store/\`. These paths are engine-managed.
- Treat ticket files as schema-sensitive. The engine validates and rejects malformed writes.
- Do not delete ticket history; append only.
- The \`finish <ticket>\` handoff is required before committing. Commit creation, \`implementationLink\` update, and status → \`Done\` happen as one atomic step.
- **If this repo keeps a \`.docs/event-horizon/reference/*\` doc set, keep it in sync with code** — a ticket that changes ticket-schema, MCP tools, REST endpoints, realtime channels, or the agent-adapter contract updates the matching reference page in the same ticket. This is an Event Horizon-repo-specific convention, not every project's — if no such directory exists here, there is nothing to do for this rule.
`;
}
