---
id: FLUX-365
title: '[TEST] Branch-per-ticket end-to-end smoke test'
status: Todo
priority: Low
effort: XS
assignee: unassigned
tags:
  - test
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T13:02:55.581Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 8487ad90-bf3e-433f-adf9-0b3312f30c83
    startedAt: '2026-06-03T13:11:18.813Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-06-03T13:11:18.813Z'
    outcome: Claude Code session stopped by user.
    endedAt: '2026-06-03T13:11:21.464Z'
  - type: activity
    user: Agent
    date: '2026-06-03T13:11:21.347Z'
    comment: Claude Code session stopped.
---
## Purpose

Disposable ticket for exercising the FLUX-292 branch-per-ticket + diff-capture slice end to end. Make a small, throwaway edit, push it through the full lifecycle, and verify every surface lights up correctly. Delete or close when done — do not merge the PR.

## Suggested throwaway edit

Append one line to `README.md`:

```
<!-- branch-feature smoke test — safe to revert -->
```

That's it. One line, one file, easy to revert.

## Walkthrough

### 1. Start the ticket from the portal

- Open the board, find this ticket in `Todo`.
- Click Start. The **StartTaskPrompt** should appear.
- Verify the suggested branch name is `flux/FLUX-<id>-test-branch-per-ticket-end-to-end-smoke-test` (or similar slug).
- If `gh` is not configured on this machine, verify the **amber gh-not-configured warning** appears under the radio options.
- Pick "Create a new branch" and click Start.

**Expected:**
- Ticket moves to `In Progress`.
- `task.branch` is set; branch badge shows on the card and in `MetadataPanel`.
- `task.baselineCommit` is set on the ticket (check `get_ticket`).
- On the git side: `flux/FLUX-<id>-…` exists as a remote ref (`git ls-remote origin | grep flux/FLUX-<id>`).
- Engine HEAD did **not** move — `git branch --show-current` still says `master`.

### 2. Agent (or you) checks out the branch and makes the edit

```bash
git fetch origin flux/FLUX-<id>-…
git checkout flux/FLUX-<id>-…
echo '<!-- branch-feature smoke test — safe to revert -->' >> README.md
git add README.md && git commit -m "Smoke test FLUX-<id>"
```

### 3. Finish the ticket

From chat: `finish FLUX-<id>` with a one-line completion comment.

**Expected (gh available):**
- `git push -u origin <branch>` runs.
- `gh pr create` runs and the PR URL replaces the commit hash in `implementationLink`.
- The completion comment lands without the "PR creation skipped" warning suffix.
- `task.diffSummary` is populated with `README.md +1 -0`.
- `<flux-dir>/FLUX-<id>.diff` exists and contains the unified diff.
- Ticket moves to `Done`.

**Expected (gh missing or unauthenticated):**
- Local commit only.
- `implementationLink` is the commit hash.
- The completion comment has a `⚠️ PR creation skipped — gh not configured` suffix.
- `diffSummary` and the sidecar are still written.
- Ticket still moves to `Done`.

### 4. Verify the portal renders the diff surface

Open the ticket modal:

- **MetadataPanel:** branch row shows the name + a copy button. If gh is available and the PR is open, `↑1` ahead indicator. Implementation link renders as "View PR ↗" (gh path) or commit hash (no-gh path).
- **DiffSummaryPanel** under the metadata: shows `1 file +1 −0` with `README.md` listed.
- Click `README.md`. The left description pane is **replaced** by the `DiffViewer` showing the unified diff with green/red colouring. The Back button returns to the description.

### 5. Sanity-check the REST endpoints

```bash
curl -s http://localhost:3067/api/health | jq .ghAuthAvailable    # true | false | null
curl -s http://localhost:3067/api/tasks/FLUX-<id>/branch | jq      # {name, exists, aheadCount, behindCount}
curl -s http://localhost:3067/api/tasks/FLUX-<id>/diff             # full unified diff
curl -s "http://localhost:3067/api/tasks/FLUX-<id>/diff?file=README.md"  # only README.md hunk
```

### 6. Cleanup

- Do not merge the PR — close it on GitHub.
- `git checkout master`
- `delete_branch` via MCP (or via the portal once that's wired) — verify the remote ref is also gone (`git ls-remote origin | grep flux/FLUX-<id>` returns empty). Confirms FLUX-338 remote-cleanup fix.
- Revert the README line on master if it somehow got merged.

## What this exercises

- `StartTaskPrompt` (incl. gh-not-configured warning) — FLUX-340
- `create_branch` MCP tool + REST POST `/api/tasks/:id/branch` — FLUX-338, FLUX-337
- `getDefaultBranch()` fallback path (won't trigger on this repo since default is `master`, but the no-`'master'`-hardcode regression is what made it possible) — FLUX-338
- baselineCommit capture on `change_status` → `In Progress` — FLUX-334
- `finish_ticket` PR creation + graceful degradation — FLUX-337
- Diff capture (merge-base..tip range), numstat parsing, sidecar write — FLUX-334
- `GET /api/tasks/:id/diff?file=` — FLUX-334
- `DiffSummaryPanel` + `DiffViewer` rendering — FLUX-340
- `delete_branch` remote-ref cleanup — FLUX-338 review fix

## Notes

This ticket is intentionally `XS` so the "Continue on current branch" option is pre-selected if you want to test that path too — uncheck it for the branch path. Run the test twice if you want both gh-available and gh-missing coverage (toggle gh auth between runs with `gh auth logout` / `gh auth login`).
