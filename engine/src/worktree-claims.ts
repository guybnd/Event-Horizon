/**
 * @file worktree-claims.ts
 *
 * FLUX-1771: a TTL-bounded, restart-durable "claim" that shields a `branch(action:'create')`
 * worktree from reclaim while a NON-EH session (a user's own Claude Code / desktop Code-tab
 * session talking to the EH MCP server) is working in it.
 *
 * WHY THIS EXISTS. `worktreeUnreclaimableReason` (`pr-cleanup.ts`) only protects a worktree it can
 * attribute to something: a registered EH session on the branch, a background-process hold, a
 * benchmark collection window, or a short recent-activity buffer. A non-EH session has no
 * `x-eh-session-id`, so `getVerifiedSessionId()` returns `null` and it is invisible to every one
 * of those guards. The only prior shield was `WORKTREE_CREATION_GRACE_MS` — a blind 30-minute
 * timer from creation, not a liveness signal — so a session that spends over 30 minutes reading
 * or planning before its first commit lost its worktree mid-work (the towero incident). This
 * module replaces the blind timer with an explicit claim any tool call from that session renews.
 *
 * WHY A NEW MODULE, NOT AN EXTENSION OF `background-process-holds.ts`. That module is PID-keyed,
 * Windows-only, kills on expiry, and requires a verified EH session id plus proof the PID
 * descends from that session's own root process — a non-EH chat session supplies none of those.
 * The right precedent is `benchmark-collection-guard.ts`: a small, import-free, TTL-bounded
 * registry that adds one reason to `worktreeUnreclaimableReason`. This module reuses that shape,
 * plus `background-process-holds.ts`'s stub-persistence pattern (a claim, unlike a benchmark
 * collection window, must survive an engine restart — see below).
 *
 * WHY NO IMPORTS FROM `task-store.ts`. Same cycle-avoidance rule as the two precedent modules:
 * `pr-cleanup.ts` queries this module, and `pr-cleanup.ts` is itself reachable from the
 * session/adapter layer. Ticket-history writing goes through an injected `setClaimHistoryWriter`
 * callback registered once in `index.ts`, exactly like `setHoldHistoryWriter`.
 *
 * WHY PERSISTED, unlike a benchmark collection window. A benchmark run's engine-restart exposure
 * is bounded by the run itself (nothing to come back to if the engine restarts mid-run). A claim
 * protects an ordinary, possibly long-lived chat session's worktree — without persistence, every
 * engine restart re-opens exactly the bug this module exists to close (the post-restart grace in
 * `isWithinReclaimGrace()` covers only the immediate window, and nothing re-creates a claim
 * afterwards, since creation is deliberately narrow — see decision 2 on FLUX-1771).
 *
 * WHY A 2-HOUR IDLE TTL, deliberately longer than the 30-minute creation grace it supersedes. An
 * EH tool call is the ONLY renewal signal available — editing files, running builds, and reading
 * source in the worktree produce none, and no cheap second signal exists (file mtime doesn't move
 * for a read-only agent; a first commit removes the ticket from the zero-commit reclaim backstop
 * entirely, so there is nothing left to protect). Sizing the claim at the same 30 minutes that
 * already failed would leave the exact reported failure reachable: a clean tree, zero commits, and
 * no EH call for 30 minutes. The cost of the longer window is bounded and cheap — with
 * `DEFAULT_MAX_TASK_WORKTREES = 4` an abandoned session pins at most one of four slots,
 * `describeWorktreeSlotHolders` names it in a `Task worktree limit reached` error, and the
 * portal's worktree-chip Clean up action (which routes through `removeTaskWorktree`) releases it
 * instantly.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getActiveFluxDir } from './workspace.js';
import type { Workspace } from './workspace-context.js';

/** Idle window, renewed on every heartbeat — see the module header for the sizing rationale. */
export const WORKTREE_CLAIM_IDLE_TTL_MS = 2 * 60 * 60_000;

export interface WorktreeClaim {
  workspaceRoot: string | null;
  ticketId: string;
  branch: string;
  worktreePath: string;
  /** `currentMcpSessionId()` at creation, or `'unbound'` — diagnostics only, never used for auth. */
  ownerId: string;
  createdAt: string;
  expiresAt: string;
}

type ClaimKey = string;
function claimKey(workspaceRoot: string | null, ticketId: string): ClaimKey {
  return `${workspaceRoot ?? ''}::${ticketId}`;
}

const claimsByKey = new Map<ClaimKey, WorktreeClaim>();

// ── Create / renew / release ─────────────────────────────────────────────────

export interface ClaimWorktreeParams {
  workspaceRoot: string | null;
  ticketId: string;
  branch: string;
  worktreePath: string;
  ownerId: string;
  now?: number;
}

/** Create a claim, or renew one already held for this `(workspaceRoot, ticketId)`. Idempotent. */
export function claimWorktree(params: ClaimWorktreeParams): WorktreeClaim {
  const key = claimKey(params.workspaceRoot, params.ticketId);
  const existing = claimsByKey.get(key);
  const now = params.now ?? Date.now();
  const claim: WorktreeClaim = {
    workspaceRoot: params.workspaceRoot,
    ticketId: params.ticketId,
    branch: params.branch,
    worktreePath: params.worktreePath,
    ownerId: params.ownerId,
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    expiresAt: new Date(now + WORKTREE_CLAIM_IDLE_TTL_MS).toISOString(),
  };
  claimsByKey.set(key, claim);
  return claim;
}

/** Renew an EXISTING claim's deadline. No-op when no claim exists for this ticket — a heartbeat
 *  never creates a claim (only `branch(action:'create')` does; see the module header). */
export function renewClaim(workspaceRoot: string | null, ticketId: string, now: number = Date.now()): void {
  const claim = claimsByKey.get(claimKey(workspaceRoot, ticketId));
  if (!claim) return;
  claim.expiresAt = new Date(now + WORKTREE_CLAIM_IDLE_TTL_MS).toISOString();
}

/** Is this ticket's worktree claimed right now? Lazily evicts an expired entry so a query after
 *  the TTL lapses reads correctly even before the next sweep tick runs — routed through
 *  {@link expireClaim} so this path writes the same "claim expired" ticket history entry
 *  `sweepClaims` would have (FLUX-1778: the reclaim reconcile tick runs more often than the
 *  sweep, so this used to win the race and silently delete the claim with no history entry). */
export function hasActiveClaim(workspaceRoot: string | null, ticketId: string, now: number = Date.now()): boolean {
  const key = claimKey(workspaceRoot, ticketId);
  const claim = claimsByKey.get(key);
  if (!claim) return false;
  if (Date.parse(claim.expiresAt) <= now) {
    expireClaim(key, claim);
    return false;
  }
  return true;
}

export function getClaim(workspaceRoot: string | null, ticketId: string): WorktreeClaim | undefined {
  return claimsByKey.get(claimKey(workspaceRoot, ticketId));
}

export function releaseClaim(workspaceRoot: string | null, ticketId: string): WorktreeClaim | undefined {
  const key = claimKey(workspaceRoot, ticketId);
  const claim = claimsByKey.get(key);
  if (claim) claimsByKey.delete(key);
  return claim;
}

export function releaseClaimsForBranch(workspaceRoot: string | null, branch: string): WorktreeClaim[] {
  const released: WorktreeClaim[] = [];
  for (const [key, claim] of claimsByKey) {
    if (claim.workspaceRoot !== workspaceRoot || claim.branch !== branch) continue;
    claimsByKey.delete(key);
    released.push(claim);
  }
  return released;
}

export function releaseClaimsForWorktree(worktreePath: string): WorktreeClaim[] {
  const released: WorktreeClaim[] = [];
  for (const [key, claim] of claimsByKey) {
    if (claim.worktreePath !== worktreePath) continue;
    claimsByKey.delete(key);
    released.push(claim);
  }
  return released;
}

// ── Ticket-history logging, injected (cycle-avoidance) ───────────────────────

export type ClaimHistoryWriter = (workspaceRoot: string | null, taskId: string, message: string) => void;
let historyWriter: ClaimHistoryWriter | null = null;
export function setClaimHistoryWriter(fn: ClaimHistoryWriter): void {
  historyWriter = fn;
}

// ── Sweep (expiry enforcement) ────────────────────────────────────────────────

export interface ClaimSweepOutcome {
  claim: WorktreeClaim;
}

/** Drop `claim` and write its one "claim expired" ticket history entry, if a writer is
 *  registered. Shared by `sweepClaims` and `hasActiveClaim`'s lazy eviction (FLUX-1778) so
 *  whichever of the two observes the expiry first — the sweep (`BACKGROUND_HOLD_SWEEP_INTERVAL_MS`)
 *  or the reclaim reconcile calling `hasActiveClaim` via `worktreeUnreclaimableReason`
 *  (`PR_RECONCILE_INTERVAL_MS`) — writes exactly one entry, never zero or two: the key is deleted
 *  before either caller can observe the claim again. */
function expireClaim(key: ClaimKey, claim: WorktreeClaim): void {
  claimsByKey.delete(key);
  if (!historyWriter) return;
  historyWriter(
    claim.workspaceRoot,
    claim.ticketId,
    `Worktree claim expired (idle ${Math.round(WORKTREE_CLAIM_IDLE_TTL_MS / 60_000)} min with no EH tool call): worktree is reclaimable again.`,
  );
}

/** One sweep pass: drop every claim past its `expiresAt`, via {@link expireClaim} so it writes the
 *  same history entry regardless of which caller wins the expiry race. */
export function sweepClaims(now: number = Date.now()): ClaimSweepOutcome[] {
  const outcomes: ClaimSweepOutcome[] = [];
  for (const [key, claim] of claimsByKey) {
    if (Date.parse(claim.expiresAt) > now) continue;
    expireClaim(key, claim);
    outcomes.push({ claim });
  }
  return outcomes;
}

// ── Persistence — mirrors background-process-holds.ts's stub pattern ────────
// Local runtime state: gitignored, excluded from flux-data sync, never travels between machines.
// Persisted so a still-live, unexpired claim survives an unclean engine restart — see the module
// header for why this (unlike benchmark-collection-guard.ts) needs to persist at all.

interface ClaimStub {
  ticketId: string;
  branch: string;
  worktreePath: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
  workspaceRoot?: string;
}

function claimsDir(): string {
  return path.join(getActiveFluxDir(), 'worktree-claims');
}
function claimStubFileName(ticketId: string): string {
  return `${ticketId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}
function claimStubPath(ticketId: string): string {
  return path.join(claimsDir(), claimStubFileName(ticketId));
}

async function writeClaimStub(stub: ClaimStub): Promise<void> {
  const file = claimStubPath(stub.ticketId);
  const body = JSON.stringify(stub, null, 2);
  const tmp = `${file}.tmp`;
  try {
    await fs.writeFile(tmp, body, 'utf-8');
    await fs.rename(tmp, file);
  } catch {
    await fs.writeFile(file, body, 'utf-8').catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}

// Guard mirroring background-process-holds.ts's `rehydratedHoldWorkspaceRoots`: a sync that runs
// before rehydrate for a given root would see an empty in-memory registry and delete every
// on-disk stub.
const rehydratedClaimWorkspaceRoots = new Set<string | null>();

/** Write the current in-memory claims for `workspaceRoot` to disk, pruning any stub for a claim
 *  that's gone (released/expired). No-op until {@link rehydrateClaimStubs} has run once for this
 *  root (boot-ordering guard). Caller is responsible for running this inside
 *  `runWithWorkspace(ws, ...)` so `getActiveFluxDir()` resolves to the right board. */
export async function syncClaimStubs(workspaceRoot: string | null): Promise<void> {
  if (!rehydratedClaimWorkspaceRoots.has(workspaceRoot)) return;
  try {
    const dir = claimsDir();
    const keep = new Set<string>();
    await fs.mkdir(dir, { recursive: true });
    for (const claim of claimsByKey.values()) {
      if (claim.workspaceRoot !== workspaceRoot) continue;
      const stub: ClaimStub = {
        ticketId: claim.ticketId,
        branch: claim.branch,
        worktreePath: claim.worktreePath,
        ownerId: claim.ownerId,
        createdAt: claim.createdAt,
        expiresAt: claim.expiresAt,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      };
      keep.add(claimStubFileName(claim.ticketId));
      await writeClaimStub(stub);
    }
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json') || keep.has(file)) continue;
      await fs.unlink(path.join(dir, file)).catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

/** Boot-time restore for one workspace: drops an already-expired stub outright rather than
 *  resuming it (mirrors `rehydrateHoldStubs`'s AC8 handling) — an idle claim past its TTL has
 *  nothing left to protect. Foreign-residue (a stub tagged for a different workspaceRoot) is
 *  pruned unconditionally. */
export async function rehydrateClaimStubs(ws: Workspace): Promise<number> {
  let count = 0;
  try {
    const dir = claimsDir();
    if (existsSync(dir)) {
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dir, file);
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const stub = JSON.parse(raw) as ClaimStub;
          if (!stub || typeof stub.ticketId !== 'string' || typeof stub.worktreePath !== 'string') continue;
          const belongsHere = stub.workspaceRoot !== undefined ? stub.workspaceRoot === ws.root : true;
          if (!belongsHere) {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }
          if (Date.parse(stub.expiresAt) <= now) {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }
          const key = claimKey(ws.root, stub.ticketId);
          claimsByKey.set(key, {
            workspaceRoot: ws.root,
            ticketId: stub.ticketId,
            branch: stub.branch,
            worktreePath: stub.worktreePath,
            ownerId: stub.ownerId,
            createdAt: stub.createdAt,
            expiresAt: stub.expiresAt,
          });
          count++;
        } catch {
          /* skip malformed stub */
        }
      }
    }
  } catch {
    /* best-effort */
  }
  rehydratedClaimWorkspaceRoots.add(ws.root);
  return count;
}

/** TEST-ONLY: drop every in-memory claim and rehydrate guard. Not part of the runtime API. */
export function __resetWorktreeClaimsForTest(): void {
  claimsByKey.clear();
  rehydratedClaimWorkspaceRoots.clear();
}
