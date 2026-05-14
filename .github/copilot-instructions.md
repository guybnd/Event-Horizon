<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:START -->
## Event Horizon Always-On Instructions

This repository uses the `.flux` ticket system. Tickets are markdown files with YAML frontmatter.

### Scope

- Treat `.flux` as the canonical workflow for any task that changes repository files or advances ticket work.
- Pure explanation, brainstorming, or read-only discussion does not require ticket state changes unless the user explicitly asks.

### Ticket Resolution

- `FLUX-41` → use that ticket. Bare number like `41` or `do 41` → resolve to `FLUX-41`.
- Repo-changing work without a named ticket → find or create a ticket first.

### Skill Routing

When working on a ticket, read the orchestrator skill first, then load the phase-specific skill:

| Ticket Status | Skill File |
|---|---|
| `Grooming`, `Require Input` | `grooming.md` |
| `Todo`, `In Progress` | `implementation.md` |
| Release orchestration | `release.md` |

Skill files are at `.github/skills/event-horizon/` (Copilot) or `.docs/skills/` (source).

### Critical Rules

- Treat `.flux/*.md` as schema-sensitive. Use spaces (not tabs) in YAML frontmatter. Do not delete ticket history; append only.
- The `finish <ticket>` handoff is required before committing. Commit creation, `implementationLink` update, and status → `Done` happen as one atomic step.
- Before `Ready` or `Done`, review and update `.docs/` when behavior changed.
- If blocked on a ticket question, move to `Require Input` with a history comment — do not ask only in chat.
- When asked to release, use `npm run flux:release <version>` in `engine`, then commit immediately.
<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:END -->

