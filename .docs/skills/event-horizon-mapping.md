---
title: Event Horizon Mapping
order: 6
delivery: [pull-only, concatenated, modular]
deliveryNote: "🚚 pull-only for Claude — reached only via read_skill('mapping'), never auto-injected · concatenated into gemini/cursor/antigravity/windsurf/generic installs · installed per-file for copilot/cline (modular, on-demand)."
---
> ⚠️ DO NOT DELETE — Required for cross-project mapping in multi-repo groups.

## Phase: Cross-Project Mapping

Scope: Scour the member repos of a multi-repo group and write the cross-project knowledge base (feature maps, system topology, shared contracts) into the canonical group docs store.

---

# Event Horizon Agent — Mapping Skill

Version: 1.1.0

## When This Skill Applies

Load when the user asks to **map**, **document**, **inventory**, or **scour** a feature, system topology, or shared contract **across the repos of a multi-repo group** — i.e. work that spans more than one member repo and produces cross-project documentation.

This skill only applies when a group is configured (a committed `group.json` in the workspace root). If `get_project_group` reports `configured: false`, there is no group — fall back to normal single-repo documentation under the repo's own `.docs/`.

## Read-Only Members — Critical Rule

Member repos are mounted in your file scope for reading (native grep/glob/read reach them directly). **Treat every sibling member repo as READ-ONLY.**

- **Never** edit, create, commit, or push files inside a member checkout.
- The parent repo (the one holding `group.json`) is the **single writer**. All cross-project docs are authored there, in `.flux-group/`.
- To change a member's own docs, route the edit through the parent — do not write into the sibling directly. (The push-through-parent round-trip is owned by the engine.)

Writing into a sibling breaks the single-writer fan-out invariant and will be overwritten. Author once, in the parent.

## Workflow

1. **Discover the group.** Call `get_project_group` to learn the members: each member's `name`, `role`, git `remote`, resolved local `path`, and whether it's checked out (`pathExists`). Skip members whose `pathExists` is false — they aren't available to scour; note them as gaps rather than guessing.
2. **Scour with your own native tools.** Use grep / glob / read against the member `path`s. There is no special MCP file tool for this — the member repos are already in your scope. Read source, configs, READMEs, and existing `.docs/` to understand how a feature or contract crosses repo boundaries.
3. **Write into the canonical group store** (`.flux-group/` in the parent repo):
   - `features/<slug>.md` — one file per feature map (see structure below).
   - `topology.md` — how the member repos fit together (services, dependencies, data flow).
   - `contracts/<name>.md` — a shared contract (API schema, event shape, shared type) and which repos produce/consume it.
   - `index.md` — the feature index; add or update an entry whenever you author a `features/<slug>.md`.
4. **Cite repos, don't copy them.** Reference member files by repo-relative path and member `name` (e.g. `engine: src/routes/tasks.ts`). Prefer durable structural facts over volatile line numbers.
5. **Persistence is the engine's job.** Author the files in `.flux-group/`; committing them to the canonical orphan branch and fanning them out to members is handled by the engine, not by you. Do not `git commit` or `git push` the group store yourself.

## Mapping Modes

| Mode | Trigger | Output |
|---|---|---|
| **Map one feature** | "map the <X> feature across the repos" | `features/<slug>.md` for that feature + an `index.md` entry |
| **Inventory all features** | "what features exist / inventory the product" | one `features/<slug>.md` per discovered feature + a complete `index.md` |
| **Topology / contracts** | "document how the system fits together / the shared contracts" | `topology.md` and/or `contracts/<name>.md` |

## Feature Map Structure (`features/<slug>.md`)

Keep each feature map skimmable and cross-referenced:

- **Summary** — one or two sentences: what the feature does, for whom.
- **Repos involved** — table of `member name` → role in this feature → key entry-point files.
- **Flow** — how a request / event / action moves across the member repos (a short ordered list or a Mermaid diagram).
- **Contracts touched** — links to `contracts/*.md` this feature depends on.
- **Gaps / unknowns** — anything that couldn't be confirmed (e.g. a member not checked out), so the next mapping pass knows where to look.

## Conventions

- One feature per `features/<slug>.md`; use a stable, lowercase, hyphenated slug.
- Update `index.md` in the same pass that adds or changes a feature map — a stale index is worse than no index.
- Mapping is a snapshot. When the product changes, re-run the relevant mapping mode rather than trying to keep docs live; there are no watchers re-scanning member repos.
