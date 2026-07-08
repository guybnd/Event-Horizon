---
title: Event Horizon Review
order: 4
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break review behaviour.

## Phase: Ready (review-phase / reviewer-of-record sessions)
Scope: Judge a diff against the ticket's intent and record a machine-readable verdict during the review phase.

---

# Event Horizon Agent — Review Skill

Version: 1.2.0

## When This Skill Applies

Load this skill when you are reviewing a ticket's diff — a review-phase session launched against a `Ready` ticket, or any session where your focus instructions cast you as a reviewer. This is distinct from the implementation skill (`Todo`/`In Progress`, writing the code) even though review often follows it on the same ticket. Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

Reviewer sessions are triggered manually by the user — never automatically when a ticket reaches `Ready`. When a reviewer sends a ticket back to `In Progress`, read that structured comment before making any changes; it explains what needs fixing. The review conversation lives on the ticket; the GitHub PR is the diff artifact, not the source of truth for what to change.

## Diff Scoping — review the merge-base diff, never `HEAD~1`

Review the scoped diff provided in your launch context. If none is present, or you need more context, run `git diff <baselineCommit>...HEAD` using the ticket's `baselineCommit` field (from `get_ticket`) as the base. **Never use `git diff HEAD~1`** — on a multi-commit branch it only shows the last commit, silently hiding everything before it.

## Severity Taxonomy

Tag every finding with one of these three levels — normalize on this scale even if you generate findings from several angles:

- **Blocker** — must fix before `Ready`. Correctness bugs, broken acceptance criteria, security holes, data loss.
- **Major** — should fix. Real problems that don't block merging today but will bite soon (missing error handling on a reachable path, a real perf regression, a gap in test coverage for new logic).
- **Minor** — nice to have. Style, naming, small simplifications, non-blocking polish.

Lead findings with Blockers first. When synthesizing multiple reviewers' findings, resolve disagreements on the merits of the argument, not a raw vote count.

## Acceptance Criteria Checklist (FLUX-1148)

If the ticket body has a `## Acceptance criteria` section (the grooming skill's GFM-checkbox convention), check off the items the diff satisfies via `update_ticket` **before** recording your verdict below. This is advisory bookkeeping, not a gate — an unchecked item never blocks `Ready` and doesn't override the Severity Taxonomy above. Its only job is to keep the portal's advisory "X/Y checked" indicator honest for the next reader instead of silently going stale. No section, or a section you can't map to the diff → skip silently.

## The reviewState Contract — CRITICAL (FLUX-816/1078)

**A verdict isn't recorded until `change_status` carries `reviewState`.** A review comment — even one starting with `APPROVED` or `CHANGES NEEDED` — is a human-readable record, not a machine-readable one: the Furnace and the board only ever read the structured `reviewState` field. Posting a clear comment is not the end of the job.

- **Orchestrated review (multiple reviewers, one synthesizer):** individual reviewer personas post findings via `add_note` and do **not** call `change_status` — an orchestrator synthesizes all reviews and makes the call. Only call `change_status` yourself if your focus instructions don't say someone else will.
- **Sole reviewer of record:** when your focus instructions say you are the SOLE reviewer — no orchestrator will synthesize other reviews and decide for you — you MUST call `change_status` yourself before ending your turn, passing `reviewState` to match your verdict:
  - No Blocker or Major items → `change_status` to `Ready` with `reviewState: 'approved'`.
  - Any Blocker or Major item → `change_status` to `In Progress` with `reviewState: 'changes-requested'` and a comment summarizing the required changes, Blockers first.

Skipping the `change_status` call strands the ticket — from the outside it looks like the review never happened even though it did, and costs a human a round-trip to unblock it.

## Follow-ups into the current Furnace batch (FLUX-1218)

When you are reviewing a ticket inside a **Furnace batch**, your launch focus names the batch id (`This review is running inside Furnace batch <id> …`). If you spot a genuine, small, clearly-related follow-up worth doing in this same burn — most naturally in a sequential batch, where it's one shared branch/PR anyway — you may queue it straight into that batch without a human gate (same trust level as your own `reviewState` verdict):

1. `create_ticket` for the follow-up (normal TL;DR + plan conventions apply).
2. `furnace_ticket` (`action:'add'`, `batchId:` the id from your focus) to append it to the same batch immediately — it burns in order like any other batch ticket.
3. Note in your review comment that you added the follow-up and why, so the completion trail is legible.

Keep it scoped: a genuine next step directly related to this diff, not a dumping ground. Tangential ideas still go through the normal board/backlog path. If your focus doesn't name a batch id, you aren't in a burn — use the ordinary ticket tools instead.

All persistence uses MCP tools — see the orchestrator skill's "Persisting Changes" section.
