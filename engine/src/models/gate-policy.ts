// Gate policy (FLUX-1261) — per-gate autonomy dial, replacing Temper's (FLUX-1071) board-wide
// `temperEnabled` boolean with a generalized board-default -> ticket-override cascade shared by
// both the `plan` (Grooming -> Todo) and `review` (Ready) gates. Parent epic: FLUX-1247.
//
// `merge` is deliberately NEVER a representable key here — that's the STRUCTURAL half of the
// merge-lock (no field exists to misconfigure). `hasHumanGateTouch` below is the RUNTIME half
// (FLUX-1264, sibling "presets + merge-lock" subtask) — belt-and-suspenders in case a future code
// path reaches a merge call without going through the schema at all.
//
//   auto          — clears the gate silently and loops to completion (re-tried up to the shared
//                   `DEFAULT_RETRY_CAP`, then parks for a human).
//   auto-then-you — runs exactly ONE automated pass, then always stops and flags a human to
//                   confirm — never loops (looping is `auto`-exclusive).
//   you           — always waits for a human; no automated pass ever runs.
//
// Only `review`'s `auto` value is wired to real runtime behavior in this ticket (Temper's existing
// loop-forever driver in `temper.ts`, re-gated off this schema instead of the old boolean).
// `plan` and `auto-then-you` are schema-and-UI only until the generalized loop-driver ("Plan-review
// runner" subtask) lands their trigger + one-pass-then-flag semantics.

export type GateName = 'plan' | 'review';
export type GateValue = 'auto' | 'auto-then-you' | 'you';

export const GATE_NAMES: readonly GateName[] = ['plan', 'review'] as const;
export const GATE_VALUES: readonly GateValue[] = ['auto', 'auto-then-you', 'you'] as const;

export interface GatePolicy {
  boardDefault: Record<GateName, GateValue>;
}

/** Manual (safe) is the default for a board that has never configured either gate. */
export const DEFAULT_GATE_POLICY: GatePolicy = {
  boardDefault: { plan: 'you', review: 'you' },
};

/** FLUX-1292: seed value for a board whose gatePolicy has NEVER been migrated/configured at all —
 *  covers BOTH a genuinely fresh workspace (no config.json yet) AND an existing config.json that
 *  predates the gatePolicy field (gatePolicyMigrated has never fired, e.g. an old Temper-era config,
 *  regardless of what temperEnabled was set to). Mirrors portal/src/lib/gatePolicyPresets.ts'
 *  GATE_POLICY_PRESETS.autonomous. Deliberately NOT used as DEFAULT_GATE_POLICY's fallback — that
 *  constant stays 'you'/'you', resolveGateValue()'s ultra-safe last-resort backstop, and must never
 *  retroactively change a board that already has an explicit, persisted gatePolicy. */
export const UNMIGRATED_GATE_POLICY_DEFAULT: GatePolicy = {
  boardDefault: { plan: 'auto', review: 'auto' },
};

/** A per-ticket override of one or both gates, stored directly on the ticket's own frontmatter
 *  (mirrors `tempering`/`temperAttempts` — engine-internal; not yet portal-settable in v1, see the
 *  ticket's implementation plan item 4 — the preset picker subtask surfaces override authorship). */
export type GatePolicyOverride = Partial<Record<GateName, GateValue>>;

/**
 * Board-default -> ticket-override cascade (mirrors the `permissions: {boardDefault, ticketDefault}`
 * shape, FLUX-605): an explicit per-ticket override for this gate wins; otherwise fall back to the
 * board default, or the hard-coded safe default if config is missing entirely.
 */
export function resolveGateValue(
  policy: GatePolicy | undefined | null,
  override: GatePolicyOverride | undefined | null,
  gate: GateName,
): GateValue {
  return override?.[gate] ?? policy?.boardDefault?.[gate] ?? DEFAULT_GATE_POLICY.boardDefault[gate];
}

// FLUX-1263 (Plan-review runner): the `plan` gate's review depth/breadth, auto-selected by ticket
// effort (operationalizes the existing FLUX-978 Plan Discipline scaling) unless a column-level fixed
// override is dialed in the same ⚙ modal as the gate policy.
//   quick    — XS/S effort: anchor-existence check only, reground skipped.
//   standard — M effort: anchor verification + reground (.docs/release-notes/INDEX.md + recent/sibling
//              tickets) + `## Acceptance criteria` coverage check.
//   thorough — L/XL effort: standard + duplicate/sibling-ticket cross-check + the adversarial
//              self-review pass (Plan Discipline item 4 — reused, not reimplemented).

export type PlanReviewDepth = 'quick' | 'standard' | 'thorough';

export const PLAN_REVIEW_DEPTHS: readonly PlanReviewDepth[] = ['quick', 'standard', 'thorough'] as const;

/** A column-level fixed depth overrides the per-ticket effort pick; `'auto'` (the default) defers to it. */
export type PlanReviewDepthSetting = 'auto' | PlanReviewDepth;

/** XS/S -> quick; L/XL -> thorough; M (or an unrecognized/missing effort) -> standard. */
export function depthForEffort(effort: string | null | undefined): PlanReviewDepth {
  if (effort === 'XS' || effort === 'S') return 'quick';
  if (effort === 'L' || effort === 'XL') return 'thorough';
  return 'standard';
}

/** Board-level fixed-depth override -> effort-based auto-pick, mirroring `resolveGateValue`'s cascade shape. */
export function resolvePlanReviewDepth(
  effort: string | null | undefined,
  depthSetting: PlanReviewDepthSetting | null | undefined,
): PlanReviewDepth {
  if (depthSetting && depthSetting !== 'auto') return depthSetting;
  return depthForEffort(effort);
}

/** FLUX-1303: GateValue → loop mode for a human-requested REVISE ("Send for re-grooming").
 *  Deliberately NOT the same mapping as `resolvePlanGateMode` (mcp-server.ts), which maps a
 *  Grooming→Todo redirect and sends 'auto-then-you' AND 'you' to loop-confirm/one-pass differently:
 *  here `you` maps to `one-pass` — the human explicitly asked for this one revise, so the revision
 *  earns exactly ONE automatic re-review and then stops for the human, never an open-ended loop
 *  under a gate value that promises no automation. Kept next to the schema so the two mappings are
 *  side-by-side instead of drifting apart in separate modules. */
export function planGateModeForRevise(gateValue: GateValue): 'one-pass' | 'loop-confirm' | 'loop-auto' {
  return gateValue === 'auto' ? 'loop-auto' : gateValue === 'auto-then-you' ? 'loop-confirm' : 'one-pass';
}

/** FLUX-1303: stable non-cryptographic hash (djb2/base36) of a plan body, recorded as
 *  `planReviewBodyHash` whenever a plan verdict lands — lets surfaces tell whether the plan changed
 *  since the last review (gates the panel's "Re-review plan" enabled-ness, so re-reviewing an
 *  unchanged plan — which can only re-produce the same verdict — isn't offered).
 *  Mirrored in `portal/src/lib/planBodyHash.ts` (the portal can't import the engine package — same
 *  duplication pattern as `resolvePlanGateValue`); keep the two in sync. */
export function planBodyHash(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// FLUX-1264 (sibling "presets + merge-lock" subtask, parent epic FLUX-1247): the runtime half of the
// merge-lock. `merge` being unrepresentable in `GateValue` above is the structural guarantee — no
// config knob can ever be set to auto-merge. This is the belt-and-suspenders backstop: `finish_ticket`
// is the one merge path an agent session can reach entirely on its own initiative (the portal's own
// merge buttons — `POST /api/tasks/:id/merge`, `POST /api/furnace/:id/merge` — are REST-only, gated
// behind an actual human clicking something, and are not exposed as an MCP tool at all). Without this
// check, one agent session could implement a ticket, move it to Ready with its own completion
// comment, and immediately `finish_ticket` it — merging with zero human ever having looked at it.
// It should never actually fire while a ticket goes through the intended flow (a human reviewing,
// commenting, or moving it); its only job is to not be a silent single point of failure if some
// future path skips that.
export const AGENT_ACTOR = 'Agent';

/** FLUX-1271 hardening: `add_note`'s `type:'comment'` MCP tool lets the *same session* that can
 *  call `finish_ticket` also set `user` to any freeform string it likes — e.g.
 *  `add_note({ user: 'SomeHuman', ... })` — with zero verification. That defeats the check below on
 *  its own, honest, documented tool surface (no curl/bypass needed). `mcp-server.ts`'s `add_note`
 *  handler stamps every `comment` entry it writes with this marker so `hasHumanGateTouch` can refuse
 *  to trust the claimed `user` regardless of what string was passed. Entries written through any
 *  other path (the portal's REST `PUT /:id`, or the engine's own hardcoded `user: 'Agent'` writes)
 *  never carry it. This does NOT make the signal cryptographic — the app is local-first with no real
 *  auth, and a session willing to shell out straight to the REST API instead of the sanctioned MCP
 *  tools could still forge it — it only closes the specific same-tool-call spoof this ticket raised. */
export const SELF_ATTESTED_AUTHOR_FIELD = 'selfAttested';

/** A loose shape covering just the fields this check reads — real history entries carry many more
 *  (see `HistoryEntryLike` in `history.ts`, not imported here to keep this module dependency-free). */
export interface GateTouchHistoryEntry {
  type?: string | undefined;
  user?: unknown;
  [key: string]: unknown;
}

/**
 * `true` if at least one `comment` or `status_change` entry in `history` was authored by someone
 * other than the `Agent` actor — every agent/engine-driven write in this codebase uses that literal
 * string (including `finish_ticket`'s own completion comment), so a different, non-empty `user`
 * reliably means a real person (the portal's `currentUser`, default `'You'`, or a configured board
 * user) touched this ticket at some point — UNLESS the entry is marked
 * {@link SELF_ATTESTED_AUTHOR_FIELD}, meaning its `user` is a caller-controlled claim from the
 * `add_note` MCP tool rather than an authenticated write (FLUX-1271).
 *
 * Also applies to `kind:'pr'` tickets: a PR deck card is itself a merge path (its own `finish_ticket`
 * is the sanctioned shared-merge surface exempted from the FLUX-569 sibling guard), so it needs the
 * same independent "a human touched this" proof as any other ticket — intentional, not an oversight.
 */
export function hasHumanGateTouch(history: readonly GateTouchHistoryEntry[] | null | undefined): boolean {
  if (!Array.isArray(history)) return false;
  return history.some((entry) => {
    if (!entry || (entry.type !== 'comment' && entry.type !== 'status_change')) return false;
    if (entry[SELF_ATTESTED_AUTHOR_FIELD] === true) return false;
    const user = entry.user;
    return typeof user === 'string' && user.trim() !== '' && user !== AGENT_ACTOR;
  });
}
