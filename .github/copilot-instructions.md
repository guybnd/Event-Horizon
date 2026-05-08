<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:START -->
## Event Horizon Always-On Instructions

These instructions apply to all agent work in this repository.

### Scope

- Treat the `.flux` ticket system as the canonical workflow for any task that changes repository files, advances ticket work, or closes implementation work.
- Pure explanation, brainstorming, or read-only discussion does not require ticket state changes unless the user explicitly asks to operate on a ticket.

### Ticket Resolution Rules

- If the user references a ticket ID such as `FLUX-41`, use that ticket.
- If the user uses a bare ticket number such as `41`, `do 41`, or `work on 41`, resolve it to the matching `FLUX-41` ticket when that match is unique.
- If the user asks for repository changes without naming a ticket, first find the relevant existing ticket or create or groom one before treating the work as implementation.
- Do not treat repo-changing work as complete without a ticket unless the user explicitly opts out of the ticket workflow.

### Required Workflow For Ticket Work

For any ticket-driven implementation task, the agent must follow this sequence:

1. Read the full ticket, including history.
2. Read the relevant docs and the smallest nearby implementation surface before editing. Start with `.docs/`, then `README.md`, then `.docs/skills/*.md` when the task touches workflow behavior or installer output.
3. If the ticket is in `Grooming`, treat that as a planning phase rather than implicit permission to code. Tighten the ticket body into a concrete plan, review the applicable ticket metadata, fill anything that is already inferable from the current context, and capture any implementation-critical choices that still need a user decision. Applicable fields can include `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when they are relevant to the work.
4. If those implementation-critical choices or applicable metadata values are unresolved, move the ticket to the configured user-input status (`requireInputStatus`, default `Require Input`) and record the question in ticket history instead of silently picking a direction. Include the proposed fill values or defaults for the missing fields in that question.
5. Add a short plan comment to the ticket before substantial work.
6. Move the ticket to `Todo` when grooming is complete but implementation is not starting yet, and move it to `In Progress` before substantive code changes.
7. Make focused changes and run narrow validation immediately after the first substantive edit.
8. Add progress comments when scope changes, validation fails, or the user redirects the work.
9. If blocked on a ticket-specific question during implementation, move the ticket to the configured user-input status (`requireInputStatus`, default `Require Input`) and record the question in ticket history instead of asking only in chat.
10. If a ticket enters the configured ready-for-merge status (`readyForMergeStatus`, default `Ready`), treat that as a user review checkpoint rather than as closed work. Maintain files uncommitted or on a working branch at this stage. Before moving to Ready, add a concise user-readable summary comment to the ticket describing what was implemented, what was validated, and any caveats — the user reads this in the Ready state before approving.
11. Before moving a ticket to `Ready` or `Done`, review and update the relevant docs when behavior, workflow expectations, or touchpoints changed.
12. If the user says `finish <ticket>` for a ticket in the ready-for-merge status, stage all files relevant to the ticket and perform the final commit and ticket-close sequence. Do not attempt to commit before this confirmation.
13. If repository files changed and commits are expected, the commit creation, recording its hash in `implementationLink`, and moving the ticket to `Done` must happen as one atomic step only upon final user confirmation.
14. Before closing the ticket, add a completion comment that states what changed, what was validated, any caveats, and the commit hash when available.
15. Move the ticket to `Done` only after the completion update is recorded.

### Release Orchestration

- When asked to orchestrate a release or create a new version, use `npm run flux:release <version>` in `engine` to automatically transition `Done` tickets to `Released` and generate `.docs` release notes. Ensure you coordinate the version number with the user beforehand. After the release files are generated, ALWAYS create a git commit (e.g. `git add . && git commit -m "Release <version>"`) to clean up the git status immediately.

### Commit Rules

- Prefer one focused commit per completed ticket or tightly related ticket slice.
- Do not mix unrelated work into the same commit.
- Use commit messages that describe shipped behavior, not vague activity.
- If a ticket is intentionally left uncommitted because the user asked to batch commits later, record that explicitly in the ticket before considering the work wrapped.

### Ticket File Safety

- Treat `.flux/*.md` files as schema-sensitive documents.
- Preserve valid YAML frontmatter and use spaces, not tabs, in `history` and nested fields.
- Do not delete ticket history; append to it.
- After editing a ticket file, validate that it still appears through the live engine API or other project ticket reader path.

### Documentation Expectations

- Use `.docs/` as the primary durable project knowledge base when grooming or starting ticket work.
- Use grooming to improve the ticket body itself so another agent could pick up the clarified plan without rediscovery. Structure groomed bodies with a **Problem / Motivation** section first (what user problem this solves and why it matters) followed by the implementation plan. Fill applicable metadata instead of leaving inferable values blank.
- Update `README.md` when repository-wide setup, architecture, or workflow behavior changes.
- If the task changes agent workflow or workflow installation behavior, update the relevant files in `.docs/skills/` and `.flux/skills/event-horizon-copilot-instructions.md`, then refresh the installed workspace copies.

### Source Of Detailed Procedure

- Follow `.github/skills/event-horizon/SKILL.md` for the detailed Event Horizon ticket conventions, comments, validation expectations, and project-specific workflow notes.
- If these always-on instructions and the skill differ, follow the stricter rule.

### Source Of Phase-Specific Skills

- Follow `.github/skills/event-horizon/orchestrator.md` for skill routing and ticket model reference.
- Follow `.github/skills/event-horizon/grooming.md` when the active ticket is in `Grooming` or `Require Input`.
- Follow `.github/skills/event-horizon/implementation.md` when the active ticket is in `Todo` or `In Progress`.
- Follow `.github/skills/event-horizon/release.md` when performing release orchestration.
<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:END -->

## Event Horizon Always-On Instructions

These instructions apply to all agent work in this repository.

### Scope

- Treat the `.flux` ticket system as the canonical workflow for any task that changes repository files, advances ticket work, or closes implementation work.
- Pure explanation, brainstorming, or read-only discussion does not require ticket state changes unless the user explicitly asks to operate on a ticket.

### Ticket Resolution Rules

- If the user references a ticket ID such as `FLUX-41`, use that ticket.
- If the user uses a bare ticket number such as `41`, `do 41`, or `work on 41`, resolve it to the matching `FLUX-41` ticket when that match is unique.
- If the user asks for repository changes without naming a ticket, first find the relevant existing ticket or create or groom one before treating the work as implementation.
- Do not treat repo-changing work as complete without a ticket unless the user explicitly opts out of the ticket workflow.

### Required Workflow For Ticket Work

For any ticket-driven implementation task, the agent must follow this sequence:

1. Read the full ticket, including history.
2. Read the relevant docs and the smallest nearby implementation surface before editing. Start with `.docs/`, then `README.md`, then `.flux/skills/*.md` when the task touches workflow behavior or installer output.
3. If the ticket is in `Grooming`, treat that as a planning phase rather than implicit permission to code. Tighten the ticket body into a concrete plan, review the applicable ticket metadata, fill anything that is already inferable from the current context, and capture any implementation-critical choices that still need a user decision. Applicable fields can include `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when they are relevant to the work.
4. If those implementation-critical choices or applicable metadata values are unresolved, move the ticket to the configured user-input status (`requireInputStatus`, default `Require Input`) and record the question in ticket history instead of silently picking a direction. Include the proposed fill values or defaults for the missing fields in that question.
5. Add a short plan comment to the ticket before substantial work.
6. Move the ticket to `Todo` when grooming is complete but implementation is not starting yet, and move it to `In Progress` before substantive code changes.
7. Make focused changes and run narrow validation immediately after the first substantive edit.
8. Add progress comments when scope changes, validation fails, or the user redirects the work.
9. If blocked on a ticket-specific question during implementation, move the ticket to the configured user-input status (`requireInputStatus`, default `Require Input`) and record the question in ticket history instead of asking only in chat.
10. If a ticket enters the configured ready-for-merge status (`readyForMergeStatus`, default `Ready`), treat that as a user review checkpoint rather than as closed work. Maintain files uncommitted or on a working branch at this stage. Before moving to Ready, add a concise user-readable summary comment to the ticket describing what was implemented, what was validated, and any caveats — the user reads this in the Ready state before approving.
11. Before moving a ticket to `Ready` or `Done`, review and update the relevant docs when behavior, workflow expectations, or touchpoints changed.
12. If the user says `finish <ticket>` for a ticket in the ready-for-merge status, stage all files relevant to the ticket and perform the final commit and ticket-close sequence. Do not attempt to commit before this confirmation.
13. If repository files changed and commits are expected, the commit creation, recording its hash in `implementationLink`, and moving the ticket to `Done` must happen as one atomic step only upon final user confirmation.
14. Before closing the ticket, add a completion comment that states what changed, what was validated, any caveats, and the commit hash when available.
15. Move the ticket to `Done` only after the completion update is recorded.

### Commit Rules

- Prefer one focused commit per completed ticket or tightly related ticket slice.
- Do not mix unrelated work into the same commit.
- Use commit messages that describe shipped behavior, not vague activity.
- If a ticket is intentionally left uncommitted because the user asked to batch commits later, record that explicitly in the ticket before considering the work wrapped.

### Ticket File Safety

- Treat `.flux/*.md` files as schema-sensitive documents.
- Preserve valid YAML frontmatter and use spaces, not tabs, in `history` and nested fields.
- Do not delete ticket history; append to it.
- After editing a ticket file, validate that it still appears through the live engine API or other project ticket reader path.

### Documentation Expectations

- Use `.docs/` as the primary durable project knowledge base when grooming or starting ticket work.
- Use grooming to improve the ticket body itself so another agent could pick up the clarified plan without rediscovery. Structure groomed bodies with a **Problem / Motivation** section first (what user problem this solves and why it matters) followed by the implementation plan. Fill applicable metadata instead of leaving inferable values blank.
- Update `README.md` when repository-wide setup, architecture, or workflow behavior changes.
- If the task changes agent workflow or workflow installation behavior, update `.flux/skills/event-horizon-agent.md` and `.flux/skills/event-horizon-copilot-instructions.md`, then refresh the installed workspace copies.

### Source Of Detailed Procedure

- Follow `.github/skills/event-horizon/SKILL.md` for the detailed Event Horizon ticket conventions, comments, validation expectations, and project-specific workflow notes.
- If these always-on instructions and the skill differ, follow the stricter rule.




