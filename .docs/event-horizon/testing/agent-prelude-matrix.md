# Agent Spawn Prelude — Test Matrix (FLUX-1374 epic)

> **TL;DR** — Every FLUX-1374 change that trims what a spawned agent receives (skill prelude
> FLUX-1377, tool-schema weight FLUX-1376, ceremony diet FLUX-1382, …) must be checked against
> **every kind of agent spawn**, because they take *different code paths into
> `buildInitialPrompt`* and a trim can silently over- or under-deliver on one route while the
> others look fine. This is the checklist. **Test at the wiring (real spawn record → real `-p`),
> not just the pure `buildInitialPrompt` unit** — the gate reads fields (`framework`,
> `patternPosition`, `phase`) that each *adapter* decides whether to forward, so a pure-function
> test can pass while an adapter silently drops one.

## The one rule: the gate is only as correct as the adapter's forwarding

`buildInitialPrompt(task, append, opts)` (`agents/shared.ts:437`) gates phase-module injection on:

```
framework === 'claude' && !isDelegateOrRelaySpawn && isInjectablePhaseModule(phase)
     where isDelegateOrRelaySpawn = opts.patternPosition === 'assistant' || opts.patternPosition === 'step'
```

The **adapter** decides what `opts` actually contains. What each production caller forwards today:

| Caller | file:line | `phase` | `patternPosition` | `framework` |
|---|---|---|---|---|
| claude | `agents/claude-code.ts:735` | ✅ `session.phase` | ✅ `session.patternPosition` (FLUX-1377) | `'claude'` |
| copilot | `agents/copilot.ts:446` | ✅ | ❌ (irrelevant — framework-gated out) | `'copilot'` |
| gemini | `agents/gemini.ts:543` | ✅ | ❌ (irrelevant — framework-gated out) | `'gemini'` |
| metrics | `context-budget-metrics.ts:63` | ✅ | ❌ (measurement only, not a spawn) | default |

Only the Claude adapter injects, and it **does** forward `patternPosition` — so delegate/relay
exclusion works in production. Copilot/gemini don't forward it, but they never reach the injection
branch (`framework !== 'claude'`), so it's a no-op there. **The lesson stands regardless:** a future
refactor that drops `patternPosition` from `claude-code.ts:735` would re-break delegate exclusion
and `build-initial-prompt.test.ts` (pure-function) would still pass. A guard that asserts the
*adapter* forwards it (below) is the belt to that suspenders.

## The spawn-route matrix

Legend for "Expected prelude": **core** = trimmed always-on `.claude/rules/event-horizon.md`
(~1.5k tok, invariants + routing). **+module** = core plus exactly one injected phase module
(grooming/implementation/review). **static** = full 6-module concatenation installed on disk
(non-Claude). **none-injected** = engine builds no `-p` (human runs the CLI directly).

| # | Spawn route | Code site | record `patternPosition` | `phase` | Expected prelude | Status (merged 9ac070d5) |
|---|---|---|---|---|---|---|
| 1 | **Per-phase agent** (portal Start Task; status-derived) | `claude-code.ts:735` | `standalone` | grooming/impl/review | **core +module** | ✅ correct |
| 2 | **Phase-swapped / resumed** (Ready→In Progress bounce; `--resume` warm context, FLUX-1378) | resume path | unchanged | *new* phase | see note ⚠️ | ⚠️ **VERIFY** — does a resume rebuild `-p` with the new phase module, or keep the original spawn's? |
| 3 | **Sub-agent / delegate** | `cli-session.ts:1112` | `assistant` | `persona.phases[0]` (may be review/impl) | **core only** (FLUX-1377 AC #4: no module bolt-on) | ✅ correct — `claude-code.ts:735` forwards `patternPosition:'assistant'` → excluded |
| 4 | **Relay step** | `cli-session.ts:466` | `step` | `spec.phase` | **core only** | ✅ correct — `'step'` forwarded → excluded |
| 5 | **Review agent** (Furnace/Temper sole reviewer, persona-less) | `furnace-stoker.ts:405`, `temper.ts` `dispatchSession` | `standalone` | `review` | **core +review** | ✅ correct (the persona-less case FLUX-1377 targeted) |
| 6 | **Review synthesizer / combiner** | delegate w/ `groupVariant:'combiner'`, `patternPosition:'assistant'` | `assistant` | review | **core only** (combiner is spawned as an `assistant` delegate → excluded) | ⚠️ **DECIDE** — confirm combiner really wants no review module; if a synthesizer *should* get it, `combiner` isn't in the exclusion set and would need a phase-carrying standalone spawn |
| 7 | **Board / orchestrator agent** (`__board__`) | board chat dispatch | `standalone` | `chat` | **core only** (chat → no module) | ✅ correct |
| 8 | **Scratch agent** (`SCRATCH-*`) | scratch dispatch | `standalone` | `chat` | **core only** | ✅ correct |
| 9 | **Furnace burn** (persona-less implement) | `furnace-stoker.ts:405` | `standalone` | impl/review | **core +module** | ✅ correct (headline fix) |
| 10 | **Gate-runner plan review** | `gate-runner.ts` `spawnGate` (`FurnacePhase \| 'grooming'`) | `standalone` | grooming *or* review | **core +that module** | ⚠️ **VERIFY** which phase the plan gate passes (grooming vs review) |
| 11 | **Custom persona, standalone / supervisor lead** (Start Task w/ persona) | `cli-session.ts:429` `lead` | `lead` | `persona.phases[0]` | **core +module** (lead = genuine phase work, included) | ✅ correct |
| 12 | **Non-Claude** (copilot/cline/gemini) | `copilot.ts:446`, `gemini.ts:543` | any | any | **static install, NO injection** | ✅ framework-gated |
| 13 | **Worktree spawn** (executionRoot in `.eh-worktrees/`) | any adapter | same as main | same | **same as main-checkout equivalent** | ✅ improvement (worktrees never installed `.claude/rules/`) |
| 14 | **Human interactive** (`claude` run by user in main checkout) | — | — | — | **installed core only + Read-on-demand** | ✅ (engine builds no `-p`) |
| 15 | **Board-rebase apply agent** | `board-rebase.ts:224` | `standalone` | (check) | depends on phase | ⚠️ **VERIFY** phase passed |
| 16 | **MCP prompt** (`/groom`, `/implement`, `/release`) | `mcp-server.ts:667+` | — | — | serves full module body **on demand**, unchanged | ✅ untouched by FLUX-1377 |
| 17 | **Stale-install transient** (before version refresh 2.10→2.11 + engine restart) | installer staleness | — | — | old 69k core **+** new injected module = **DOUBLE load** | ⚠️ transient until engine restart; don't measure savings on a stale checkout |

## Cross-cutting invariants to assert every time

- **Single-source drift guard** — the persistence invariants render identically into the MCP
  `instructions` block (`mcp-server.ts`) and the installed core (`skill-core.ts`
  `CORE_INVARIANTS`). `skill-core.test.ts` asserts this; keep it.
- **No double-count in metrics** — `context-budget-metrics.ts` must add `coreTokensEst` only (the
  injected module is already inside `launchPrompt`). Portal `PayloadSizePanel` currently
  double-shows it visually (FLUX-1387).
- **Core carries every load-bearing invariant** — never-touch-`.flux/`, commit-before-Ready,
  End-of-Turn action contract, Require-Input discipline, destructive-action approval. Over-trim
  here is safety-sensitive; when in doubt, keep it in core.
- **Non-Claude byte-identity** — copilot/cline/gemini installs and prompts must be byte-identical
  to pre-change fixtures (no injection leaks into non-Claude `-p`). `workflow-installer-core.test.ts`
  and `build-initial-prompt.test.ts` cover this.

## How to actually test a route (not just the pure function)

1. **Adapter-forwarding guard (cheapest real regression test):** assert each adapter forwards to
   `buildInitialPrompt` the fields the gate reads — for Claude, that `claude-code.ts` passes
   `patternPosition: session.patternPosition`. `build-initial-prompt.test.ts` currently tests the
   *pure function* with an explicit `patternPosition`; a guard on the *adapter's* opts (e.g. extract
   the opts object into a pure helper and assert it) would catch a future drop of the forward — the
   one class of regression the pure-function test cannot see.
2. **Spawn-shaped unit:** construct the session record the way each dispatcher does
   (`furnace-stoker` standalone/review; delegate `assistant`+`persona.phases[0]`; relay
   `step`+`spec.phase`) and assert the resulting `-p` contains / omits `## Phase Skill:`.
3. **Live smoke (per phase):** spawn one real session per route, read the Context Budget panel;
   confirm prelude ≈ core + (module or nothing) matching the table.

## Open verify/decide items (rows above)

- **Row 2** — resume/phase-swap: does a resumed session that changed phase get the new phase module,
  or keep the original spawn's? (Interacts with FLUX-1378 warm-context resume.)
- **Row 6** — combiner/synthesizer: confirm it should get *no* review module (it's an `assistant`
  delegate today), or decide it needs one.
- **Row 10 / 15** — confirm the exact `phase` the gate-runner plan review and the board-rebase apply
  agent pass.
- **Row 17** — stale-install double-load is transient; never benchmark savings on a checkout whose
  installed `.claude/rules/event-horizon.md` hasn't refreshed to core (version 2.11.0+).

## Related tickets

- **FLUX-1377** — the compaction this matrix guards.
- **FLUX-1387** — portal Context Budget panel visually double-counts the injected module.
- **FLUX-1374** — parent cost epic; every remaining subtask should re-run this matrix.
