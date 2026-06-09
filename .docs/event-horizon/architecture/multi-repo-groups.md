---
title: Multi-Repo Groups
order: 5
---
# Multi-Repo Groups — Design Spec

> **Status: MVP shipped, with post-MVP follow-ups.** The parent-authoritative knowledge base is implemented end-to-end — group config + canonical store (FLUX-393), `get_project_group` (FLUX-394), mapping skill (FLUX-395), fan-out (FLUX-396), parent-side edit intake (FLUX-397), sibling-source scope (FLUX-398), portal read-only docs + feature map (FLUX-399/403), group setup plan/apply + CLI/UI (FLUX-401/402), and a real-git integration test (FLUX-400). **Member read + edit flows are now wired for Case 1** — a member surfaces the parent's group docs under a read-only `Product/` tree (FLUX-405) and edits them in-process through the parent's writer with no workspace swap (FLUX-406). The supported topology is locked to **Case 1 — same machine, one EH engine** (parent + members all checked out locally, parent registered as a workspace); cross-machine/cross-process group editing is explicitly out of scope. In Case 1 a member reads the parent's already-mounted store in place and routes edits to the parent's writer in-process — no member worktree, no transport. **Case 1 is now enforced by setup (FLUX-408):** group plan/apply register the dedicated parent + present members as EH workspaces, and `ensureGroupRegistered` backfills an already-configured group's registry (idempotent, never rewrites `group.json`) so the member binding can actually resolve the parent. The existing-user self-heal is surfaced in the portal (FLUX-409): an amber consent banner on the parent workspace registers whatever is missing on explicit confirm. **Onboarding/migration is now wired (FLUX-407):** a portal `GroupWizard` discovers sibling repos (from the registry or a chosen folder) and creates a dedicated parent in one shot, reachable from three optional, never-blocking entry points (Settings, a dismissible multi-repo nudge, and an onboarding mention). **Existing `.docs/` can now be promoted into the store (FLUX-404):** a parent-only plan→preview→apply flow moves selected docs out of the repo main branch and into the shared knowledge base. Sections below are kept in sync with code; each major area notes what shipped vs. what's deferred.


## Problem

Event Horizon assumes a single workspace. Real products span several repos (frontend + backend + shared libs + infra). A person or agent working in one sub-repo has no shared understanding of how the whole system fits together. This feature gives a **group** of repos a living cross-project knowledge base — feature maps, system topology, shared contracts — built by EH "mapping" tickets and kept in sync across every member repo.

## Model at a glance

```
group.json            parent repo root, committed to main      (config — who is in the group)
canonical group docs  parent orphan branch `flux-group-docs`   (the knowledge base — never on a repo main)
member mirrors        each member's `flux-group-docs` branch   (fan-out copy — self-contained, offline-readable)
write authority       the parent group engine                  (single writer; members never write canonical)
```

- **Single-writer fan-out.** Mapping tickets run in the parent and write the canonical docs. The parent is the only thing that ever commits to `flux-group-docs`. It pushes that branch to every member's remote. Members are **read mirrors** — they never commit to their copy of the branch (see [Edit round-trip](#edit-round-trip) for how sub-repo edits work without violating this).
- **Edits can originate anywhere, but are applied by one writer.** A sub-repo dev edits docs in their local worktree; the change is captured as a **diff and submitted to the parent** (see FLUX-397). The parent applies it to the canonical store, commits, and re-fans-out. Because members never commit locally, every fan-out push stays a clean fast-forward. Git-like: anyone proposes, one branch is canonical.
- **Repo main branches stay clean; member remotes do get a new branch.** Docs are never committed to any repo's *main* branch — only to the `flux-group-docs` orphan branch. Be explicit, though: fan-out **pushes a `flux-group-docs` branch to every member's remote**. The feature writes to member remotes (a new orphan branch), just never to their mains. `group.json` is the one new file on the parent's main.

## `group.json` schema

Location: **parent repo root**, committed to the parent's main branch. It is configuration (who is in the group + how to reach them), not knowledge — so it lives in-repo, not on the orphan branch.

### Member identity: remote URL, not local path

A subtle but important rule: `group.json` is **committed and shared**, so it must not contain machine-specific data. Different developers check out repos into different folder layouts. Therefore:

- **Canonical member identity is the git `remote` URL** (stable across machines), plus a stable short `name`.
- **Local checkout paths are resolved per-machine, not stored in the committed file.** By default the engine assumes members are **siblings of the parent repo** (i.e. `../<name>`). For non-standard layouts, a developer provides paths in a **gitignored** `group.local.json` next to `group.json`. The committed `group.json` never pins an absolute or machine-specific path.

```jsonc
// group.json — committed to the parent repo main (shared, machine-independent)
{
  // Display name of the product / group.
  "name": "my-product",

  // Member repos in the group.
  "members": [
    {
      "name": "engine",                          // stable short key; immutable once used (it is a doc path prefix)
      "role": "api",                             // free-form label; see suggested roles below
      "remote": "git@github.com:acme/engine.git" // canonical identity + fan-out target
    },
    {
      "name": "portal",
      "role": "frontend",
      "remote": "git@github.com:acme/portal.git"
    },
    {
      "name": "homeup",
      "role": "app",
      "remote": "git@github.com:acme/homeup.git",
      "testCommand": "npm run e2e"               // optional; surfaced by get_project_group
    }
  ]
}
```

```jsonc
// group.local.json — GITIGNORED, per-machine path overrides (optional)
// Only needed when members are NOT siblings of the parent (../<name>).
{
  "paths": {
    "engine": "/abs/or/relative/path/to/engine",
    "homeup": "../../apps/homeup"
  }
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Product / group display name. |
| `members` | object[] | yes | Member repos. Must be non-empty for group features to activate. |
| `members[].name` | string | yes | Stable short key. **Immutable once used** — it is the doc path prefix; renaming orphans `members/<name>` paths. Must be unique. |
| `members[].role` | string | yes | Free-form role label. Suggested values below. |
| `members[].remote` | string | yes | Git remote **URL** — the canonical, machine-independent identity and the fan-out push target. |
| `members[].testCommand` | string | no | Surfaced by `get_project_group` so agents know how to validate that repo. |
| `docsLabel` | string | no | Display label for the surfaced group docs tree (default `Product`). A single safe path segment; it's a **display prefix only**, so changing it re-surfaces the same `.flux-group` store docs under a new name **without moving any files** (FLUX-414). |

The fan-out branch name is fixed at **`flux-group-docs`** for the whole group (not per-member configurable — YAGNI until a real need appears). Per-machine checkout paths live in the gitignored `group.local.json`, defaulting to `../<name>`.

**Suggested roles** (labels only, not enforced): `frontend`, `api`, `backend`, `shared-lib`, `infra`, `app`, `service`, `docs`.

### Activation rule

When `group.json` is **absent**, the engine behaves exactly as today (single root, single board). When present with a non-empty `members` array, group features activate. This must be non-breaking for existing single-repo users (see [Multi-root engine](#multi-root-engine) and FLUX-393).

## Multi-root engine

Today the engine is single-rooted: `tasksCache` / `docsCache` (`task-store.ts`), `configCache` (`config.ts`), and `workspaceRoot` (`workspace.ts`) are process-global singletons, and `activateWorkspace()` resets them wholesale on every switch. A group needs the parent **and** awareness of its members.

> **Implemented (FLUX-393) as an additive `group` module, not a singleton rewrite.** Because members are read-only and there is **one active board** (no per-member tickets), the MVP does not need per-member board caches. Rather than replace the global singletons (imported directly across ~20 files — a high-regression refactor), FLUX-393 adds [`engine/src/group.ts`](../../../engine/src/group.ts) which holds the loaded group **alongside** the untouched singletons. Single-repo behavior is therefore byte-for-byte identical, and the non-breaking guarantee is automatic (no `group.json` ⇒ the module is inert). The full per-root cache (`RootContext` with its own `tasksCache`/`configCache`) is only needed if cross-repo *ticketing* is ever added — explicitly out of scope.

The active group context:

```
GroupContext
  parentRoot      the repo holding group.json — single writer + active board
  config          { name, members[] }
  members[]       ResolvedMember = { name, role, remote, path, pathExists, testCommand? }
  groupStoreDir   the canonical .flux-group store (docs), owned by the parent
  docsBranch      flux-group-docs
```

Rules honored:

- **Back-compat is mandatory.** No `group.json` ⇒ `group.ts` returns null and the engine behaves byte-for-byte like today. This is the non-breaking guarantee for existing single-repo users.
- **One active board.** Tickets remain single-board for the MVP — the parent's board is authoritative. Members are loaded **read-only for source + docs awareness**, not as additional boards (cross-repo ticketing is explicitly out of scope; see FLUX-391).
- **`activateWorkspace()` activates the group.** It calls `activateGroup(parentRoot)` after the existing single-repo setup, so switching workspaces re-derives the group from the new root rather than leaking state.

> **Single active context (consequence of the additive design).** `getGroupContext()` is a module-level singleton, mirroring the existing `tasksCache`/`configCache` singletons. The engine therefore assumes **one active workspace per process** — the same assumption single-repo mode already makes. Member-derived data that can change on disk after load (e.g. whether a member is checked out) must be re-evaluated at read time rather than trusted from the load-time snapshot; `summarizeGroup` does this for `pathExists`. If true per-workspace isolation is ever needed, this singleton is the thing to replace.

Every other group feature consumes the context: `get_project_group` (FLUX-394) reads its membership, fan-out (FLUX-396) iterates members, sibling-source scope (FLUX-398) exposes member `path`s to the agent, and the portal view (FLUX-399) reads the group store.

## Group store layout

The canonical knowledge base lives on the parent's `flux-group-docs` orphan branch, attached as a git worktree at `.flux-group/` in the parent repo (mirroring how `flux-data` is attached at `.flux-store/`; see [`storage-sync.ts`](../../../engine/src/storage-sync.ts) `attachWorktreeIfPresent` / `migrateToOrphan`).

```
.flux-group/                       worktree of the `flux-group-docs` orphan branch
  index.md                         feature index — entry point, links into features/
  topology.md                      system topology across the group
  features/
    <slug>.md                      one cross-project feature map per file (e.g. auth.md)
  contracts/
    <name>.md                      shared contracts (types, API shapes) spanning repos
```

- `features/`, `topology.md`, `contracts/` are **cross-project** docs authored by mapping tickets (FLUX-395).
- The entire tree is fanned out to each member's `flux-group-docs` branch, so every member ends up with the full set.

> **Why no per-member `members/<name>/` subtree?** An earlier draft proposed one. It is cut from the MVP: a doc that is "scoped to one repo but shared with the group" is just a cross-project doc, which `features/` / `contracts/` already cover. A repo's *own*, non-shared docs belong in that repo's own `.docs/`. Adding a third location created an ambiguous overlap with no distinct job. Reintroduce only if a concrete need appears.

## Edit round-trip

This is the contract that lets edits originate in any repo without breaking single-writer fan-out. It must be honored by FLUX-396 (fan-out) and FLUX-397 (push-through-parent).

1. **Members never commit to `flux-group-docs` locally.** Their `.flux-group/` worktree is a read mirror. A sub-repo dev editing a doc produces **uncommitted working-tree changes** only.
2. **Submit as a diff to the parent.** The edit is captured as a diff and sent to the parent group engine (FLUX-397), not pushed.
3. **Parent applies + commits + fans out.** The parent writes the change into the canonical store, commits it on `flux-group-docs`, and pushes to every member. Because no member ever advanced the branch, **every push is a fast-forward** — no force-push, no merge resolution.
4. **Member fast-forwards and discards its local proposal.** After the parent's commit lands, the member resets its `.flux-group/` worktree to the new branch tip; the now-canonical content replaces the transient local edit.

If a member's branch is ever found *ahead* of canonical (e.g. someone committed by hand), that is an **error state**, not a merge to resolve: the parent is canonical and the member is reset to it. The engine should detect and surface this rather than attempt a 3-way merge.

**Shipped (FLUX-397).** The parent-side intake is [`group-edit.ts`](../../../engine/src/group-edit.ts) (`submitGroupEdit`, surfaced via `POST /api/group/submit-edit`). It applies the submitted edit into the canonical store and re-fans-out via [`syncGroup`](../../../engine/src/group-sync.ts), **serialized** at the parent (sole writer) so concurrent submissions apply in order without interleaving — satisfying step 5. The security-critical apply core (`applyEditsToStore`) validates every edit `path` up front (rejects absolute paths, `..` traversal, and writes into the worktree `.git`), so a bad edit aborts before any write. Because no member advances the branch, every re-fan-out push stays fast-forward (steps 2/3).

> **Member flows shipped for Case 1 (FLUX-405 / FLUX-406).** A member checkout still runs in single-repo mode for its *own* board (`group.json` lives only in the parent), but it now discovers and rides the parent's group store in the same process. The implementation is **same-machine, single-engine (Case 1)** and deliberately simpler than the generic diff/push steps above:
>
> - **Discovery is reverse-lookup ([`activateMemberBinding`](../../../engine/src/group.ts)).** On member activation the engine scans the workspace registry for a registered parent whose `group.json` lists this repo's `origin` remote (matched via [`normalizeRemoteForCompare`](../../../engine/src/group.ts), which collapses https/ssh/scp spellings), and resolves the parent's `GroupContext`. No committed `group.member.json`, no marker on the fan-out branch. A repo that is itself a parent never binds as a member.
> - **Read in place (FLUX-405).** The member does **not** attach its own `.flux-group/` worktree (steps 1/4 above are skipped in Case 1). [`activeGroupStoreDir()`](../../../engine/src/task-store.ts) falls back from `getGroupContext()` to `getMemberBinding()?.parentGroup.groupStoreDir`, so the member loads and watches the **parent's** already-mounted store directly and renders `Product/` read-only via the existing FLUX-399 path.
> - **Edit in-process (FLUX-406).** A member's `Product/` create/update/delete is handed to the parent's `submitGroupEdit(parentContext, …)` as a **direct function call in the same process** — not a diff, not HTTP. [`docs.ts`](../../../engine/src/routes/docs.ts) maps the `Product/<…>` path back to a store-relative file via [`groupDocPathToStoreRelative`](../../../engine/src/group.ts), calls `submitGroupEdit`, then reloads through `loadGroupDoc`. `POST /api/group/submit-edit` accepts the same member binding as a fallback writer. The parent stays the sole writer (invariant intact) and re-fans-out as usual. No cross-process lock, no transport, no inter-repo auth.
> - **Graceful degrade.** When the parent isn't a registered local workspace (not Case 1), the member shows no `Product/` tree and the mutation routes return `403`/`400` with a human message pointing the user to open the parent. Cross-machine/cross-process editing is **out of scope by decision**, not merely deferred.



## Sibling-source scope (FLUX-398)

Docs fan-out gives a sub-repo task cross-project *docs* awareness. Sibling *source* awareness is separate: agent sessions spawn with `cwd` at the parent root, so member repos — which live outside `cwd` (siblings at `../<name>`) — are invisible to native grep/glob/read.

**Mechanism (always-on, additive).** [`buildMemberScopeArgs()`](../../../engine/src/group.ts) emits `--add-dir <path>` for every member whose checkout currently exists on disk. Both adapters spread it into their spawn args ([`copilot.ts`](../../../engine/src/agents/copilot.ts) `copilotArgs`, [`claude-code.ts`](../../../engine/src/agents/claude-code.ts) `claudeArgs` + resume args). It returns `[]` in single-repo mode, so the call is unconditional and a no-op when no group is active. The `existsSync` check is live and per-member: a member cloned after activation is picked up on the next session, and a not-yet-checked-out member is silently skipped rather than passed as a missing path.

**Read-only is convention-enforced, not sandboxed.** Neither CLI supports per-directory read-only mounts, so an added member dir is technically writable by the agent. Sibling repos are kept read-only by the **single-writer model** (sub-repo edits route through the parent per [Edit round-trip](#edit-round-trip)) plus skill/prompt guidance — not by a hard sandbox. Hard write-interception is an explicit, deferred follow-up; it would require wrapping the agent file-write tools in both adapters.

## Lifecycle: add / remove / rename

- **Add a member.** Append to `group.json.members`; the engine registers the new root and the next fan-out seeds its `flux-group-docs` branch with the full doc set.
- **Remove a member.** Delete its entry from `group.json`. The engine stops fanning out to it. Its existing `flux-group-docs` branch is left in place (cleanup is manual — EH does not delete branches on member remotes automatically). Docs that referenced it become stale until a re-map.
- **`name` is immutable once used.** Because `name` is the doc path prefix and the registry key, renaming a member silently orphans references. To rename, treat it as remove + add and re-run mapping. The engine should reject a `group.json` whose `members[].name` set collides or changes underneath existing group-store paths where detectable.
- **Staleness is manual, by design.** Docs refresh when a mapping ticket re-runs (FLUX-395). There are no file watchers re-scanning member repos (cut deliberately — a staleness/maintenance liability). The portal view (FLUX-399) may show last-mapped timestamps so humans can judge freshness.

## Migrating existing docs into the store

A repo that adopts the group system usually already has docs in its own in-repo `.docs/` (on the repo main branch), while the canonical knowledge base lives on the `flux-group-docs` orphan branch. Promoting the genuinely cross-project subset of `.docs/` into the store is a **separate, opt-in step** — tracked as **FLUX-404** — not part of group setup:

- **Move semantics (decided).** A promoted doc is *moved* (removed from the repo main branch and committed into the canonical store), mirroring the ticket-migration precedent [`migrateToOrphan`](../../../engine/src/storage-sync.ts). Consequence: a promoted doc is no longer visible via plain GitHub/IDE browsing of main — only through EH group mode / fan-out. The repo's own non-shared docs stay in `.docs/`.
- **Per-file selection, not bulk.** `.docs/` mixes repo-local and cross-project content, so promotion is a `plan → preview → apply` flow (same shape as group setup) that maps selected files onto the curated store layout (`features/`, `contracts/`, `topology.md`). Runnable from **either side of a group (FLUX-406):** the parent writes the store directly, a member reads its own `.docs/` and pushes into the store *through the parent* (`submitGroupEdit` — the member→parent submit transport), then removes the source from its own main. The promoted doc returns to the member as a read-only group doc.


## Credentials / auth

Fan-out pushes to **N member remotes**. This multiplies the auth surface that `finish_ticket` already depends on (`gh` / git credentials). The implementer (FLUX-396) must:

- Assume each member `remote` is independently authenticated; a push failure to one member must not abort fan-out to the others (report per-member success/failure).
- Surface auth/push failures clearly rather than leaving members silently out of sync.

## Orphan-branch naming

| Branch | Holds | Worktree | Convention basis |
|---|---|---|---|
| `flux-data` | ticket store (existing orphan mode) | `.flux-store/` | existing |
| `flux-group-docs` | canonical group docs (new) | `.flux-group/` | mirrors `flux-data` naming |

The group docs branch is **separate** from `flux-data` so ticket storage and group knowledge never entangle. On each member repo, the fanned-out branch uses the same name (`flux-group-docs`) and is attached at `.flux-group/` for local/offline reading.

## Path-prefixing rule (portal rendering)

[`DocsSidebar`](../../../portal/src/components/DocsSidebar.tsx) builds a flat tree from a path-keyed `docsCache`. Group docs must be disambiguated from a repo's own `.docs/` so they don't collide. Rule:

- **Cross-project group docs** (`features/`, `topology.md`, `contracts/`) render under a synthetic top-level **`Product`** group in the sidebar.
- **A repo's own local `.docs/`** continue to render unprefixed, as today.

Member `name` is still used as a stable key in the root registry and for any future per-repo grouping, which is why it must be unique and immutable.

**Shipped (FLUX-399).** The engine maps the canonical group store into the docs cache under the `Product/` prefix as **read-only** entries: [`task-store.ts`](../../../engine/src/task-store.ts) exposes `loadGroupDocs()` / `loadGroupDoc()` (each `DocRecord` carries `readOnly: true` and `group: true`) and a chokidar watcher (`startGroupDocsWatcher`) that reloads `Product/*` on change. A no-group repo is unaffected — `loadGroupDocs()` no-ops when no group is active. The docs REST routes ([`routes/docs.ts`](../../../engine/src/routes/docs.ts)) hard-reject mutation of this subtree: `POST` returns 403 for any path under `Product/`, and `PUT`/`DELETE` return 403 when the target doc is `readOnly`. In the portal, [`DocsScreen`](../../../portal/src/components/DocsScreen.tsx) renders the subtree read-only (no inline title edit, Save/Delete/toolbar suppressed, a read-only banner) and shows a **membership panel** (group name + members with role and checkout status) sourced from `fetchGroupStatus()`; [`DocsSidebar`](../../../portal/src/components/DocsSidebar.tsx) accepts a `readOnlyPrefix` prop that suppresses the create (+) control inside the subtree and disables drag-reorder for read-only docs. Editing a group doc still routes through the parent via the push-through-parent flow (FLUX-397).

**Shipped (FLUX-403).** [`DocsScreen`](../../../portal/src/components/DocsScreen.tsx) adds a **feature-map landing**: when a group is configured and `Product/features/*` docs exist, the docs landing (no doc selected) renders those features as a card grid instead of the bare empty state. Each card shows the feature title, a short summary (first non-heading body line), and per-feature member-role chips — participation is detected by a robust heuristic (member name appears in the feature doc), avoiding fragile markdown-table parsing — and links into the doc via the normal open flow. A "View feature map" button in the membership panel clears the selection to return to the map. Pure portal work (no engine change); last-mapped timestamps are intentionally deferred since `DocRecord` carries no mtime today.



## How the pieces map to subtasks

| Concern | Ticket |
|---|---|
| This spec | FLUX-392 |
| Multi-root engine + load `group.json` + stand up canonical store | FLUX-393 |
| `get_project_group` MCP tool | FLUX-394 |
| Mapping skill (authors the docs) | FLUX-395 |
| Group setup: plan/apply engine routine + `init-group` CLI (recreatable parent) | FLUX-401 |
| Portal `GroupSetupPreview` (plan → confirm → apply UI) | FLUX-402 |
| Fan-out sync to member branches via git remotes | FLUX-396 |
| Push-through-parent edits from sub-repos | FLUX-397 |
| Always-on sibling-source scope for sub-repo tasks | FLUX-398 |
| Portal cross-project docs / feature view | FLUX-399 |
| Integration test (EventHorizon + second member) | FLUX-400 |

## Creating a group (recreatability)

A group must be **creatable from scratch by any project**, not hand-assembled — otherwise the feature doesn't really ship. Because group creation mutates the user's git aggressively (writes `group.json`, patches `.gitignore`, creates the `flux-group-docs` orphan branch, optionally clones members, and later pushes to member remotes), it is **preview-first, never silent** — the same scan → preview → confirm-apply pattern the existing bootstrap import already uses ([`BootstrapPreview`](../../../portal/src/components/BootstrapPreview.tsx)).

- **Engine (FLUX-401).** `planGroupSetup()` computes every intrusive action with **zero git mutation** and returns a structured plan; `applyGroupSetup()` performs the writes only when asked, with per-member isolation (one member failure never aborts the rest) and git-URL validation (`validateGitRemote`) on every `remote` — rejecting shell metacharacters, the `ext::`/`fd::` transports, and embedded `--upload-pack`/`--receive-pack` options. The first slice **registers existing member checkouts** (verifies they're git work trees without mutating them); members that are not checked out are reported in the plan as `clone` actions but are **not auto-cloned yet** (a thin follow-up adds execution). Lives in [`group-setup.ts`](../../../engine/src/group-setup.ts). Exposed headless via an `init-group` CLI ([`init-group.ts`](../../../engine/src/init-group.ts), `npm run init-group`) — scriptable and the basis for the integration-test harness — and via `POST /api/group/plan` + `/api/group/apply` ([`routes/group.ts`](../../../engine/src/routes/group.ts)).
- **Portal (FLUX-402).** [`GroupSetupPreview`](../../../portal/src/components/GroupSetupPreview.tsx) is a three-step panel — **input** (group name + member `name`/`role`/`remote` rows) → **plan** (renders the dry-run `GroupSetupPlan`: files, `.gitignore` additions, the `flux-group-docs` orphan branch, and each member as `register`/`clone` with its resolved path) → **result** (per-member apply outcome). When opened via **"Reconfigure group…"** on an already-configured parent the panel accepts an `initial` prop and **prefills the input step from the current `GroupStatus`** (name + members from `group.json`) with `force` pre-checked (FLUX-413), so reconfiguration edits the existing config instead of starting blank; the create-from-scratch path is unchanged when no group exists. Outbound `clone` actions are visually distinguished and the user can opt any member out before applying. It calls `POST /api/group/plan` then `/api/group/apply`, and is surfaced from Settings → Workspace alongside the Git Sync (storage migration) controls, since both are intrusive git operations. The current group status comes from `GET /api/group`.
- **Workspace registration guardrail (FLUX-408).** Case 1 only works if the parent **and** every present member are registered as EH workspaces — the member binding (FLUX-405) discovers its parent by reverse-look-up over the workspace registry, so an unregistered parent is invisible. Setup now closes that gap: `planGroupSetup()` reports a `registrations[]` plan (parent as `kind: 'parent'`, each present member as `kind: 'member'`, each flagged `alreadyRegistered`) and `applyGroupSetup()` registers the dedicated parent + every verified-present member (injectable `listWorkspaces`/`registerWorkspace`, defaulting to the global-settings registry). For groups created before this shipped, `ensureGroupRegistered(parentRoot, { dryRun })` is an **idempotent backfill** that registers whatever is missing **without rewriting `group.json`** — `dryRun: true` reports the gap (`complete: false`) without writing, which drives the detect-on-activation → prompt → consent flow (no silent registry writes). Exposed via `POST /api/group/ensure-registered` ([`routes/group.ts`](../../../engine/src/routes/group.ts)). `GET /api/group` and `get_project_group` now fold the registry into the summary — each member carries `registered`, and the group carries `parentRoot`/`parentRegistered`/`registrationComplete` (omitted when no registry is supplied, so the legacy shape is preserved). **The existing-user self-heal is wired (FLUX-409):** on the parent workspace, Settings → Workspace shows an amber consent banner when `registrationComplete` is false, lists the unregistered parent + present members (`groupRegistrationGaps` in [`utils.ts`](../../../portal/src/utils.ts) decides this — it ignores absent members, which aren't actionable), and a button calls `POST /api/group/ensure-registered` then re-fetches. Nothing is written until the user clicks. The member-side prompt (registering missing *siblings* from a member workspace) needs the member binding surfaced to `GET /api/group` and is deferred to the onboarding wizard (FLUX-407).
- **Onboarding/migration wizard (FLUX-407).** A portal `GroupWizard` ([`GroupWizard.tsx`](../../../portal/src/components/GroupWizard.tsx)) turns a pile of unlinked repos into a dedicated-parent group without leaving the UI. **Discovery is read-only** and backed by [`group-discovery.ts`](../../../engine/src/group-discovery.ts): `GET /api/group/discover/registry` projects the existing workspace registry, and `POST /api/group/discover/folder` enumerates the *immediate* child git repos of a chosen folder (no recursion; skips `node_modules`/`.git`/`.flux-group`/etc.), reporting each repo's `origin` remote, whether it's already a registered workspace, and whether it's itself a group parent. The wizard steps **source → select → configure → result**: pick repos (group-parent repos and remote-less repos are flagged/disabled), name the group, and **always confirm an explicit parent folder path** (auto-defaulted from the chosen folder but editable). Creating calls `POST /api/group/create-parent` → `createDedicatedParent()`, which validates the inputs (reusing `validateGitRemote`), **refuses to clobber an existing `group.json`**, then `mkdir`s + `git init`s the dedicated parent (skipped if already a repo), scaffolds the `.flux-group` store, writes `group.json`, and registers **both the parent (labeled with the group name) and every selected member whose checkout exists** — pinning each member's discovered path into a gitignored `group.local.json` so the parent resolves members no matter where it sits (FLUX-410). The wizard sends each member's local `path` from discovery and the create response reports a `memberRegistrations[]` outcome (surfaced on the result step, flagging any member that couldn't be registered). This replaces the earlier post-create `ensureGroupRegistered` call, which resolved against the *active* workspace (the member the user started in) rather than the new parent and so silently left members unregistered. Three **optional, never-blocking** entry points surface it: a *Create group from repos…* button in Settings → Workspace, a **dismissible multi-repo nudge** (`multiRepoNudge`/`parentDirOf` in [`utils.ts`](../../../portal/src/utils.ts) — fires only when no group is configured and the workspace's parent folder holds ≥2 sibling repos, dismissal persisted in `localStorage`), and a soft mention on the final onboarding step ([`OnboardingWizard.tsx`](../../../portal/src/components/OnboardingWizard.tsx)). Repairing or appending members to an *already-configured* group routes through the FLUX-409 consent banner / `ensureGroupRegistered`, not `createDedicatedParent` (which only creates new parents); renaming a group or removing members is out of scope.
- **Member group membership surfaced (FLUX-412).** A bound member workspace previously looked group-less in the UI — `GET /api/group` only summarized `getGroupContext()` (parent context, unset on a member), so a member reported `configured: false` with no further signal. The status response (and the `get_project_group` MCP tool) now attaches a `membership` descriptor — `{ role: 'parent' | 'member', groupName, parentRoot, memberName?, memberRole? }` — resolved from `getGroupContext()` on the parent and `getMemberBinding()` on a member. **`configured` is deliberately left `false` on members** so parent-only operations (the registration consent banner, reconfigure) stay parent-only; `membership` is the separate "this repo belongs to a group" signal — and member-capable flows (doc promotion, the shared feature map) gate on `membership` rather than `configured`. The portal consumes it: Settings → Workspace shows a read-only "Part of group X (member: name)" card instead of the misleading "No group configured" + setup buttons (and the multi-repo nudge is suppressed), and the Docs view ([`DocsScreen.tsx`](../../../portal/src/components/DocsScreen.tsx)) shows a member badge plus the shared `Product/` feature map (the `showFeatureMap` gate now accepts membership, not just `configured`).
- **Parent-editable group docs + configurable label (FLUX-414).** The parent workspace can now edit its own `Product/` group docs **inline in the wiki editor** instead of only via the mapping skill or promotion. [`task-store.ts`](../../../engine/src/task-store.ts) `loadGroupDoc` marks a group doc `readOnly` only when `getGroupContext()` is unset (i.e. a bound member) — the parent's own group docs load editable. [`routes/docs.ts`](../../../engine/src/routes/docs.ts) routes **all** group-doc writes (POST/PUT/DELETE) through one writer context, `getGroupContext() ?? getMemberBinding()?.parentGroup`, calling `submitGroupEdit` (write into `.flux-group` → commit → `syncGroup` fan-out). The PUT/DELETE gate switched from `doc.readOnly` to `doc.group`, so the parent no longer 403s; the 403 now only fires if a group doc somehow surfaces with no resolvable writer. The synthetic docs prefix is also **configurable per group** via `group.json`'s optional `docsLabel` (default `Product`): `groupDocsLabel(group)` / `activeGroupDocsLabel()` resolve it, `groupDocPathToStoreRelative(path, prefix)` takes the prefix, `task-store` surfaces files under it, and `GET /api/group` + `get_project_group` report it as `docsLabel`. Because it's a display prefix, changing it re-surfaces the same store docs under a new name with **no file moves**. The portal ([`DocsScreen.tsx`](../../../portal/src/components/DocsScreen.tsx)) derives the label for the feature filter + sidebar and shows a short explanation of what the tree is (and, on the parent, that it's editable).
- **Member-editable group docs via push-through-parent (FLUX-419).** A bound **member** can now edit shared group docs in place, not just read them — closing the gap where the engine already accepted a member write but the portal disabled the editor. [`task-store.ts`](../../../engine/src/task-store.ts) `loadGroupDoc` now marks a group doc `readOnly` only when **no writer resolves at all** (`getGroupContext() == null && getMemberBinding() == null`); a bound member's group doc loads editable with a new `viaParent: true` flag. The `DocRecord`/`Doc` types carry `viaParent`. The portal extracts a pure [`resolveDocEditability(doc, canEditDocs)`](../../../portal/src/utils.ts) helper (unit-tested in `utils.test.ts`) that `DocsScreen.tsx` uses to make the editor writable; a save on a member PUTs the same docs endpoint, which the existing `groupWriterContext()` routes through `submitGroupEdit` (write → commit → fan-out from the parent's `.flux-group`). A `viaParent` doc shows a "saved through the group's parent and fanned out to members" banner instead of the read-only lock, and the member sidebar's `readOnlyPrefix` is dropped so create/reorder in the group tree are consistent with editing. **Not yet surfaced:** per-member fan-out push failures are returned by `submitGroupEdit` but the inline editor doesn't show them (separate follow-up).

- **Grouped workspace list (FLUX-415).** The workspace registry stores only `{ path, label }` and the engine resolves group membership only for the *active* workspace, so the Settings workspace list and the header switcher previously showed grouped repos as a flat, unrelated list. [`resolveWorkspaceGroups(roots)`](../../../engine/src/group.ts) now classifies the **whole** registry: pass 1 marks each root with a valid `group.json` as a **parent** and indexes its members by normalized remote key; pass 2 binds each non-parent root to a parent group via its `origin` remote (the same reverse-lookup as `activateMemberBinding`, applied across the list). `GET /api/workspaces` attaches the result to each entry as `group` (`{ groupName, role, parentPath, memberName? }`). It's presentation-only and best-effort — unreadable repos / repos without an origin stay ungrouped, and the map is empty (list renders flat) when no registered workspace declares a group. The portal's [`groupWorkspaces()`](../../../portal/src/utils.ts) util partitions the list into group sections (keyed by parent path, parent rendered first, then members) plus ungrouped entries while **preserving each entry's original registry index** so index-based rename/remove still work; both [`WorkspaceSwitcher.tsx`](../../../portal/src/components/WorkspaceSwitcher.tsx) and the Settings [`WorkspaceSection.tsx`](../../../portal/src/components/settings/WorkspaceSection.tsx) render grouped repos nested under a group-name header.
- **Promoting existing docs (FLUX-404).** A repo's cross-project docs live in `.docs/` on the repo **main branch**, but the shared knowledge base lives on the `flux-group-docs` orphan branch under `.flux-group/` — so existing institutional knowledge starts stranded in-repo. Promotion bridges that with **move semantics** (the same choice as the ticket migration in [`storage-sync.ts`](../../../engine/src/storage-sync.ts)): a promoted doc is written into the canonical store and **removed from main**, becoming single-source-of-truth in the group. The consequence, surfaced in the UI: a moved doc is no longer visible by plain GitHub/IDE browsing of main — only through group mode / fan-out. Because `.docs/` mixes repo-local and cross-project content, promotion is **per-file opt-in**, never a bulk move. The flow follows the established plan→preview→apply shape ([`group-promote.ts`](../../../engine/src/group-promote.ts)): `planDocsPromotion` walks `.docs/` and proposes a store target per file (default `features/<basename>`, retargetable); `applyDocsPromotion` writes each selection into the `.flux-group` worktree, `git rm`s the source from main, commits the removals, then `syncGroup`s to commit on `flux-group-docs` and fan out — per-file isolated, with path safety (`..`/absolute/`.git` rejected) on both source and target. **Runnable from either side of a group (FLUX-406):** the routes (`POST /api/group/promote-docs/plan` + `/apply`) resolve the origin via `getGroupContext()` (parent) ?? `getMemberBinding()` (member). A **member** promotion (`applyMemberDocsPromotion`) reads the member's own `.docs/`, pushes the content into the store **through the parent** (`submitGroupEdit` — the same in-process member→parent transport member doc edits use), then `git rm`s each source from the member's own main; after fan-out the doc returns to the member as a read-only group doc. Both paths share the `removeSourceFromMain`/`commitDocsRemovals` helpers. Surfaced in the portal as `DocsPromotionPanel` inside Settings → Workspace's Multi-repo group card, plus the inline promote nudge in the Docs view (gated on `membership`, so it fires for parents and bound members alike).
- **Promotion discoverability hint (FLUX-416).** A repo's own root `.docs/` is **repo-local** — it is *not* shared across the group until it's promoted into the store (the FLUX-404 flow). Creating a doc in the parent's `.docs/` and expecting it to fan out to members looks like a sync bug but is expected behavior; only docs under the `<docsLabel>/` (default `Product/`) tree fan out. To close that discoverability gap, the docs view ([`DocsScreen.tsx`](../../../portal/src/components/DocsScreen.tsx)) shows an inline hint when a **group parent** (`groupStatus.configured === true`) is viewing an **editable, non-`<docsLabel>/`** doc: "This doc is local to this repo … Promote it to share it across the group," with a CTA that navigates to Settings → Workspace where `DocsPromotionPanel` lives. Pure affordance — no change to sync behavior; the hint never shows for group docs (already shared) or on member workspaces (which can't promote).
- **MCP read tools for group docs (FLUX-421).** An agent running inside any workspace — parent **or** bound member — can now read the shared knowledge base via MCP without needing local file access. Two new tools in [`mcp-server.ts`](../../../engine/src/mcp-server.ts): `list_group_docs` returns path + title + directory for every group doc (resolved via `activeGroupStoreDir()`, which already falls back to `getMemberBinding()?.parentGroup.groupStoreDir`), and `read_group_doc` returns the full body by path. Both return a clear "no group" message in single-repo mode rather than erroring. See [MCP Tools Reference](../reference/mcp-tools.md).
- **MCP write tool for group docs — agent cross-project writes (FLUX-420).** An agent finishing a cross-project ticket can now push docs to the shared store via MCP: `submit_group_doc` (create/update) and `delete_group_doc` wrap `submitGroupEdit(groupWriterContext(), …)` — the same write→commit→fan-out transport the portal editor uses. Both tools resolve the writer as `getGroupContext() ?? getMemberBinding()?.parentGroup`, work from any workspace (parent or bound member), reuse the path-safety rules from `group-edit.ts`, and **return per-member fan-out outcomes** so the agent knows which repos received the change. Error when no writer resolves (single-repo or unbound member). See [MCP Tools Reference](../reference/mcp-tools.md).
- **Member-local group docs worktree — non-EH awareness (FLUX-422).** Shared group docs previously existed only in the parent's `.flux-group/` store and on the `flux-group-docs` orphan branch on member remotes — never as real files in a member's working tree. Non-EH developers, plain editors/grep, and non-EH agents saw nothing. A new module [`group-member-worktree.ts`](../../../engine/src/group-member-worktree.ts) gives each member a local checkout: `attachMemberWorktree(memberRoot, parentRoot)` fetches `flux-group-docs` from the parent's local git repo by path (no internet / configured remote needed), creates a git worktree at `memberRoot/.flux-group/`, and ensures a `/.flux-group/` entry in the member's `.gitignore`. `syncGroup` calls `refreshMemberWorktrees(group)` after every canonical commit so every present member's copy fast-forwards automatically. During workspace activation, `activateMemberBinding` return value is captured and `attachMemberWorktree` is called if bound. Agent adapters ([`copilot.ts`](../../../engine/src/agents/copilot.ts), [`claude-code.ts`](../../../engine/src/agents/claude-code.ts)) spread `buildGroupDocsScopeArg(workspaceRoot)` — `['--add-dir', <memberRoot>/.flux-group]` — so a member-side agent reads group docs as real local files. Read-only by convention: edits route through `submit_group_doc` (MCP) or the portal editor (FLUX-419/FLUX-420).

The CLI is the automation path; the portal preview is the safe default for humans. Both call the same engine routine.

## Fan-out sync (FLUX-396)

Once a group exists and its canonical docs are authored under `.flux-group/`, **fan-out** mirrors them to every member. It is single-writer: the parent is the sole canonical author, and each member receives a read mirror on its own `flux-group-docs` branch.

[`group-sync.ts`](../../../engine/src/group-sync.ts) implements `syncGroup()`, which chains three steps:

1. **`ensureCanonicalBranch()`** — promotes the plain `.flux-group/` scaffold (created at setup) into a git worktree attached to the `flux-group-docs` orphan branch. It evacuates existing content to a temp backup, runs `git worktree add` (`--orphan -b` when the branch is new, plain attach when it already exists), then restores the content (canonical wins on any collision). Idempotent — a no-op when the worktree is already on the branch.
2. **`commitCanonicalDocs()`** — stages everything and commits **only when the worktree is dirty** (`status --porcelain`), so repeated syncs don't create empty commits.
3. **`fanOutGroupDocs()`** — for each member, validates `remote` (`validateGitRemote`), then pushes `flux-group-docs:flux-group-docs` **by the declared remote URL** (not a named remote — sidesteps any local `origin` mismatch). Pushes are **fast-forward only** (never `--force`): a member whose branch has diverged is reported as `diverged: true` rather than being overwritten. Per-member isolation — one member's auth/push failure never aborts the others — satisfying the credentials contract above.

`syncGroup()` returns a `GroupSyncResult` (`{ committed, pushed, failed, members[] }`) and is surfaced via `POST /api/group/sync`. A `GitRunner` is injectable for unit testing. **Member-side worktree attach** (checking out `flux-group-docs` at each member's `.flux-group/` for offline reading) is intentionally deferred to a thin follow-up — fan-out delivers the branch; local attachment is a separate, optional convenience.

