/**
 * @file background-process-holds.ts
 *
 * FLUX-1645: an opt-in, per-process, TTL-bounded "hold" that lets a verified background process
 * (a long build an agent explicitly started and wants to survive) live on across an ordinary
 * session pause/exit, while every OTHER descendant of that session still dies immediately — the
 * existing FLUX-1207 reap-everything behavior stays the default, this only carves out named
 * exceptions.
 *
 * This module is a pure, framework/workspace-agnostic REGISTRY plus its on-disk persistence. It
 * does not itself decide whether a PID is a legitimate descendant of a session (that needs the
 * live Windows process table — a caller-supplied `childrenByParent` map from
 * `kill-process-tree.ts`'s {@link indexProcessTable}), and it does not write ticket history (the
 * callers — `mcp-server.ts`'s tool handlers, the terminal-transition hook, the sweep interval —
 * own that, so this module never needs to import task-store.ts and risk an import cycle with the
 * adapters/session-store that in turn need to query holds).
 *
 * Windows-only by design (mirrors kill-process-tree.ts's ParentProcessId graph-walk, which is the
 * only mechanism that can prove selective survival across an exit handler firing after the root
 * pid itself has already exited). Callers must reject hold creation on any other platform.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getActiveFluxDir } from './workspace.js';
import type { Workspace } from './workspace-context.js';
import {
  isPidAlive,
  isSameOrDescendantPid,
  killDescendantsByPid,
  killSingleWin32Pid,
  listWin32ProcessSnapshot,
} from './kill-process-tree.js';

export const MIN_TTL_MINUTES = 1;
export const MAX_TTL_MINUTES = 120;
export const DEFAULT_TTL_MINUTES = 30;

export interface BackgroundProcessHold {
  pid: number;
  /** Win32 `CreationDate` string captured at registration — the PID-reuse fingerprint. Empty
   *  string if the platform/query couldn't produce one (never happens on a successful Windows
   *  registration; kept as a string rather than optional so persistence round-trips cleanly). */
  fingerprint: string;
  workspaceRoot: string | null;
  taskId: string;
  sessionId: string;
  reason: string;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  expiresAt: string;
}

type HoldKey = string;
function holdKey(workspaceRoot: string | null, pid: number): HoldKey {
  return `${workspaceRoot ?? ''}::${pid}`;
}

const holdsByKey = new Map<HoldKey, BackgroundProcessHold>();

// ── Read paths ───────────────────────────────────────────────────────────────

export function findHold(workspaceRoot: string | null, pid: number): BackgroundProcessHold | undefined {
  return holdsByKey.get(holdKey(workspaceRoot, pid));
}

export function getHoldsForWorkspace(workspaceRoot: string | null): BackgroundProcessHold[] {
  return [...holdsByKey.values()].filter((h) => h.workspaceRoot === workspaceRoot);
}

export function getHoldsForSession(sessionId: string): BackgroundProcessHold[] {
  return [...holdsByKey.values()].filter((h) => h.sessionId === sessionId);
}

export function getHoldsForTask(workspaceRoot: string | null, taskId: string): BackgroundProcessHold[] {
  return getHoldsForWorkspace(workspaceRoot).filter((h) => h.taskId === taskId);
}

export function getHoldsForWorktree(worktreePath: string): BackgroundProcessHold[] {
  return [...holdsByKey.values()].filter((h) => h.worktreePath === worktreePath);
}

export function getHoldsForBranch(workspaceRoot: string | null, branch: string): BackgroundProcessHold[] {
  return getHoldsForWorkspace(workspaceRoot).filter((h) => h.branch === branch);
}

/** Every hold currently registered, across every workspace — used by the sweep tick, which has
 *  no single "current" workspace to scope to. */
export function getAllHolds(): BackgroundProcessHold[] {
  return [...holdsByKey.values()];
}

/** The exempt-root PID set for one session — pass directly as `killProcessTree`'s `exemptPids`
 *  on an ORDINARY exit (never on an explicit Stop — callers must clear-and-kill instead, see
 *  below, so Stop always wins the race per AC7). */
export function getExemptPidsForSession(sessionId: string): Set<number> {
  return new Set(getHoldsForSession(sessionId).map((h) => h.pid));
}

/** The exempt-root PID set for every hold on one ticket — AC8's repair-retry/lock-holder-reaping
 *  protection needs this (a known-session-pid reap keyed on ticket id, not a single session). */
export function getExemptPidsForTask(workspaceRoot: string | null, taskId: string): Set<number> {
  return new Set(getHoldsForTask(workspaceRoot, taskId).map((h) => h.pid));
}

/** The exempt-root PID set for every hold anywhere, across every workspace — the broadest form,
 *  for a reaper (the worktree lock-holder hunt) that has no single ticket/workspace to scope to. */
export function getAllExemptPids(): Set<number> {
  return new Set(getAllHolds().map((h) => h.pid));
}

/** True iff `pid` is itself a held root, a live descendant of one, or an ANCESTOR of one — the
 *  full "never kill an ancestor containing a held child" rule (AC4) — per the current process
 *  table. Used by the worktree lock-holder reaper and repair-retry paths to exclude a candidate
 *  kill target that would otherwise reach into (or above) a protected subtree. */
export function isPidProtected(
  childrenByParent: ReadonlyMap<number, number[]>,
  pid: number,
  exemptRoots: ReadonlySet<number>,
): boolean {
  for (const root of exemptRoots) {
    if (isSameOrDescendantPid(childrenByParent, pid, root) || isSameOrDescendantPid(childrenByParent, root, pid)) return true;
  }
  return false;
}

// ── Overlap / ownership ──────────────────────────────────────────────────────

/** An existing hold in the same workspace whose pid is an ancestor OR descendant of `pid` (per
 *  the live process table) — excluding an exact-pid match, which is a renew, not an overlap.
 *  Independent sibling branches never collide. */
export function findOverlappingHold(
  workspaceRoot: string | null,
  pid: number,
  childrenByParent: ReadonlyMap<number, number[]>,
): BackgroundProcessHold | undefined {
  for (const hold of getHoldsForWorkspace(workspaceRoot)) {
    if (hold.pid === pid) continue;
    if (isSameOrDescendantPid(childrenByParent, hold.pid, pid) || isSameOrDescendantPid(childrenByParent, pid, hold.pid)) {
      return hold;
    }
  }
  return undefined;
}

// ── Create / renew / release ─────────────────────────────────────────────────

export type HoldActionError = 'overlap' | 'owned-by-other-session';

export interface CreateHoldParams {
  workspaceRoot: string | null;
  taskId: string;
  sessionId: string;
  pid: number;
  fingerprint: string;
  reason: string;
  ttlMinutes: number;
  worktreePath: string | null;
  branch: string | null;
  now?: number;
}

export type CreateHoldResult =
  | { ok: true; hold: BackgroundProcessHold; renewed: boolean }
  | { ok: false; error: HoldActionError; owner: string };

/** Create a fresh hold, or — when `params.pid` already has a live hold owned by the SAME session
 *  — renew its deadline/reason/fingerprint in place (AC3: "renews its deadline/reason"). A pid
 *  already held by a DIFFERENT session is rejected outright (never silently reassigned); a pid
 *  that overlaps (ancestor/descendant of) an unrelated hold is rejected too (AC5). Caller must
 *  have already validated: platform is win32, the pid is alive, it is a genuine descendant of the
 *  calling session's own root process, the ticket/session/workspace are all in good standing, and
 *  the TTL is in range — this function only enforces ownership + overlap, both of which need the
 *  registry's own state to answer. */
export function createOrRenewHold(params: CreateHoldParams, childrenByParent: ReadonlyMap<number, number[]>): CreateHoldResult {
  const key = holdKey(params.workspaceRoot, params.pid);
  const existing = holdsByKey.get(key);
  if (existing && existing.sessionId !== params.sessionId) {
    return { ok: false, error: 'owned-by-other-session', owner: existing.sessionId };
  }
  if (!existing) {
    const overlap = findOverlappingHold(params.workspaceRoot, params.pid, childrenByParent);
    if (overlap) return { ok: false, error: 'overlap', owner: overlap.sessionId };
  }
  const now = params.now ?? Date.now();
  const hold: BackgroundProcessHold = {
    pid: params.pid,
    fingerprint: params.fingerprint,
    workspaceRoot: params.workspaceRoot,
    taskId: params.taskId,
    sessionId: params.sessionId,
    reason: params.reason,
    worktreePath: params.worktreePath,
    branch: params.branch,
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    expiresAt: new Date(now + params.ttlMinutes * 60_000).toISOString(),
  };
  holdsByKey.set(key, hold);
  return { ok: true, hold, renewed: !!existing };
}

export type ReleaseHoldResult =
  | { ok: true; hold: BackgroundProcessHold }
  | { ok: false; error: 'not-found' | 'owned-by-other-session'; owner?: string };

/** Owner-only, idempotent release — removes protection WITHOUT killing the process (AC3). A
 *  missing hold is reported as `not-found` (idempotent from the caller's perspective: releasing
 *  an already-released/expired hold is not an error condition the caller needs to react to, but
 *  the tool handler still distinguishes it from success for the activity-log wording). */
export function releaseHold(workspaceRoot: string | null, pid: number, sessionId: string): ReleaseHoldResult {
  const key = holdKey(workspaceRoot, pid);
  const existing = holdsByKey.get(key);
  if (!existing) return { ok: false, error: 'not-found' };
  if (existing.sessionId !== sessionId) return { ok: false, error: 'owned-by-other-session', owner: existing.sessionId };
  holdsByKey.delete(key);
  return { ok: true, hold: existing };
}

// ── Ticket-history logging, injected (cycle-avoidance) ───────────────────────
// AC9: every forced-clear/expiry/stale-clear action appends ONE ticket activity. This module
// deliberately never imports task-store.ts (adapters, session-store.ts, task-worktree.ts, and
// task-store.ts's own terminal-transition hook all need to call INTO this module, so this module
// importing back OUT to task-store.ts for `updateTaskWithHistory` would cycle). Instead, mirrors
// the established injected-launcher pattern already used for the same reason elsewhere in this
// codebase (session-store.ts's `setCombinerLauncher`/`setRelayStepLauncher`): index.ts registers
// the real writer once at boot, after every module is loaded.
export type HoldHistoryWriter = (workspaceRoot: string | null, taskId: string, message: string) => void;
let historyWriter: HoldHistoryWriter | null = null;
export function setHoldHistoryWriter(fn: HoldHistoryWriter): void {
  historyWriter = fn;
}
function logCleared(cleared: BackgroundProcessHold[], reasonLabel: string): void {
  if (!historyWriter) return;
  for (const h of cleared) {
    historyWriter(h.workspaceRoot, h.taskId, `Background-process hold force-cleared (${reasonLabel}): pid ${h.pid}, reason "${h.reason}".`);
  }
}

// ── Force clear-and-kill (Stop / terminal transition / teardown / shutdown) ──
// These NEVER check ownership — they are engine-initiated overrides that always win the race
// against a live hold (AC7: "Stop wins exit races"). Each returns the holds it cleared so the
// caller can force-kill the corresponding subtree (via {@link forceKillHeldSubtree}) — the ONE
// ticket-activity entry AC9 requires is appended internally via the injected writer above.

function clearMatching(predicate: (hold: BackgroundProcessHold) => boolean): BackgroundProcessHold[] {
  const cleared: BackgroundProcessHold[] = [];
  for (const [key, hold] of holdsByKey) {
    if (!predicate(hold)) continue;
    holdsByKey.delete(key);
    cleared.push(hold);
  }
  return cleared;
}

export function clearHoldsForSession(sessionId: string, reasonLabel = 'session stopped'): BackgroundProcessHold[] {
  const cleared = clearMatching((h) => h.sessionId === sessionId);
  logCleared(cleared, reasonLabel);
  return cleared;
}

export function clearHoldsForTask(workspaceRoot: string | null, taskId: string, reasonLabel = 'ticket reached a terminal transition'): BackgroundProcessHold[] {
  const cleared = clearMatching((h) => h.workspaceRoot === workspaceRoot && h.taskId === taskId);
  logCleared(cleared, reasonLabel);
  return cleared;
}

export function clearHoldsForWorktree(worktreePath: string, reasonLabel = 'worktree torn down'): BackgroundProcessHold[] {
  const cleared = clearMatching((h) => h.worktreePath === worktreePath);
  logCleared(cleared, reasonLabel);
  return cleared;
}

export function clearHoldsForBranch(workspaceRoot: string | null, branch: string, reasonLabel = 'branch removed'): BackgroundProcessHold[] {
  const cleared = clearMatching((h) => h.workspaceRoot === workspaceRoot && h.branch === branch);
  logCleared(cleared, reasonLabel);
  return cleared;
}

export function clearAllHoldsForWorkspace(workspaceRoot: string | null, reasonLabel = 'workspace shutdown'): BackgroundProcessHold[] {
  const cleared = clearMatching((h) => h.workspaceRoot === workspaceRoot);
  logCleared(cleared, reasonLabel);
  return cleared;
}

/** Engine-wide graceful shutdown — every hold, regardless of workspace. Deliberately NOT promised
 *  to survive a deliberate shutdown (see the ticket's Risks section): this is that override. */
export function clearAllHolds(reasonLabel = 'engine shutdown'): BackgroundProcessHold[] {
  const cleared = clearMatching(() => true);
  logCleared(cleared, reasonLabel);
  return cleared;
}

/** Force-kill a held root + its full subtree with NO exemptions — the actual teardown action
 *  behind every clear-and-kill path above. Best-effort/fire-and-forget, matching every other kill
 *  primitive in kill-process-tree.ts. No-op on non-Windows (holds only ever exist on win32). */
export function forceKillHeldSubtree(hold: BackgroundProcessHold): void {
  if (process.platform !== 'win32') return;
  killSingleWin32Pid(hold.pid);
  killDescendantsByPid(hold.pid, { kill: killSingleWin32Pid }).catch(() => {});
}

// ── Sweep (expiry enforcement + liveness/fingerprint healing) ────────────────
// AC6: "Expiry is enforced no later than the next one-minute sweep and rechecked at every
// hold-sensitive operation." The interval wiring lives in index.ts; this is the tick body.

export interface SweepOutcome {
  hold: BackgroundProcessHold;
  outcome: 'expired-killed' | 'cleared-dead' | 'cleared-stale-fingerprint';
}

/** One sweep pass over every registered hold, regardless of workspace. Takes a single fresh
 *  Windows process snapshot (one CIM query) and evaluates every hold against it:
 *   - pid absent from the live table → the process already exited on its own → cleared, no kill.
 *   - pid present but its `CreationDate` no longer matches the captured fingerprint → the pid was
 *     reused by an unrelated later process → cleared, no kill (never signal the reused pid, AC5).
 *   - pid present, fingerprint matches, but past `expiresAt` → force-killed + cleared (AC6).
 *   - otherwise → left in place; still within its TTL.
 *  Returns every outcome so the caller can force-kill (`expired-killed` only) and append the ONE
 *  ticket-activity entry AC9 requires per outcome — this function itself never touches ticket
 *  history or triggers a kill directly (kept a pure/testable state transition; `deps.kill` lets a
 *  caller opt into having this function also perform the kill inline instead of doing it itself,
 *  for the one production call site that wants both in a single await). */
export async function sweepHolds(
  now: number,
  deps: {
    snapshot?: () => Promise<Array<{ pid: number; creationDate: string }>>;
    kill?: (hold: BackgroundProcessHold) => void;
  } = {},
): Promise<SweepOutcome[]> {
  const snapshotFn = deps.snapshot ?? listWin32ProcessSnapshot;
  const rows = await snapshotFn();
  const liveFingerprints = new Map<number, string>();
  for (const r of rows) liveFingerprints.set(r.pid, r.creationDate);

  const outcomes: SweepOutcome[] = [];
  for (const [key, hold] of [...holdsByKey]) {
    const current = liveFingerprints.get(hold.pid);
    if (current === undefined) {
      holdsByKey.delete(key);
      outcomes.push({ hold, outcome: 'cleared-dead' });
      continue;
    }
    if (hold.fingerprint && current !== hold.fingerprint) {
      holdsByKey.delete(key);
      outcomes.push({ hold, outcome: 'cleared-stale-fingerprint' });
      continue;
    }
    if (Date.parse(hold.expiresAt) <= now) {
      holdsByKey.delete(key);
      deps.kill?.(hold);
      outcomes.push({ hold, outcome: 'expired-killed' });
    }
  }
  const outcomeLabel: Record<SweepOutcome['outcome'], string> = {
    'expired-killed': 'TTL expired',
    'cleared-dead': 'process had already exited',
    'cleared-stale-fingerprint': 'pid was reused by a different process',
  };
  for (const { hold, outcome } of outcomes) {
    if (!historyWriter) break;
    historyWriter(hold.workspaceRoot, hold.taskId, `Background-process hold cleared (${outcomeLabel[outcome]}): pid ${hold.pid}, reason "${hold.reason}".`);
  }
  return outcomes;
}

// ── Persistence — mirrors session-store.ts's SessionStub pattern (FLUX-1060/1556) ───────────────
// Local runtime state: gitignored, excluded from flux-data sync, never travels between machines.
// Persisted so a still-live, unexpired hold survives an unclean engine restart (AC8); NOT promised
// across a deliberate shutdown (graceful shutdown force-clears every hold before exit, above).

interface HoldStub {
  pid: number;
  fingerprint: string;
  taskId: string;
  sessionId: string;
  reason: string;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  expiresAt: string;
  /** Tagged so rehydration assigns the stub to the right board without ambiguity — same
   *  convention as SessionStub.workspaceRoot (FLUX-1636 Fix A2). */
  workspaceRoot?: string;
}

function holdsDir(): string {
  return path.join(getActiveFluxDir(), 'process-holds');
}
function holdStubFileName(sessionId: string, pid: number): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}__${pid}.json`;
}
function holdStubPath(sessionId: string, pid: number): string {
  return path.join(holdsDir(), holdStubFileName(sessionId, pid));
}

async function writeHoldStub(stub: HoldStub): Promise<void> {
  const file = holdStubPath(stub.sessionId, stub.pid);
  const body = JSON.stringify(stub, null, 2);
  const tmp = `${file}.tmp`;
  try {
    await fs.writeFile(tmp, body, 'utf-8');
    await fs.rename(tmp, file);
  } catch {
    // Rename can fail on some FS setups (network share, Windows lock) — best-effort direct write.
    await fs.writeFile(file, body, 'utf-8').catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}

// Guard mirroring session-store.ts's `rehydratedWorkspaceRoots`: a sync before rehydrate has run
// for this root would see an empty in-memory registry and delete every on-disk stub.
const rehydratedHoldWorkspaceRoots = new Set<string | null>();

/** Write the current in-memory holds for `workspaceRoot` to disk, pruning any stub for a hold
 *  that's gone (released/expired/cleared). No-op until {@link rehydrateHoldStubs} has run once
 *  for this root (boot-ordering guard, same rationale as syncActiveSessionStubs). Caller is
 *  responsible for running this inside `runWithWorkspace(ws, ...)` so `getActiveFluxDir()`
 *  resolves to the right board. */
export async function syncHoldStubs(workspaceRoot: string | null): Promise<void> {
  if (!rehydratedHoldWorkspaceRoots.has(workspaceRoot)) return;
  try {
    const dir = holdsDir();
    const keep = new Set<string>();
    await fs.mkdir(dir, { recursive: true });
    for (const hold of getHoldsForWorkspace(workspaceRoot)) {
      const stub: HoldStub = {
        pid: hold.pid,
        fingerprint: hold.fingerprint,
        taskId: hold.taskId,
        sessionId: hold.sessionId,
        reason: hold.reason,
        worktreePath: hold.worktreePath,
        branch: hold.branch,
        createdAt: hold.createdAt,
        expiresAt: hold.expiresAt,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      };
      keep.add(holdStubFileName(hold.sessionId, hold.pid));
      await writeHoldStub(stub);
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

/** Boot-time restore for one workspace: drops overdue or already-dead leases outright (AC8:
 *  "overdue/fingerprint-mismatched leases are cleared safely") rather than resuming them — a
 *  fingerprint re-check happens naturally on the next sweep tick for anything restored here, so a
 *  reused pid is caught within a minute even though this pass only checks liveness + expiry (a
 *  synchronous restore path can't afford a second CIM round-trip per stub on top of the readdir).
 *  Foreign-residue (a stub tagged for a different workspaceRoot) is pruned unconditionally, same
 *  as SessionStub's rehydrate. */
export async function rehydrateHoldStubs(ws: Workspace): Promise<number> {
  let count = 0;
  try {
    const dir = holdsDir();
    if (existsSync(dir)) {
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dir, file);
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const stub = JSON.parse(raw) as HoldStub;
          if (!stub || typeof stub.pid !== 'number' || typeof stub.sessionId !== 'string') continue;
          const belongsHere = stub.workspaceRoot !== undefined ? stub.workspaceRoot === ws.root : true;
          if (!belongsHere) {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }
          if (Date.parse(stub.expiresAt) <= now || !isPidAlive(stub.pid)) {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }
          const key = holdKey(ws.root, stub.pid);
          holdsByKey.set(key, {
            pid: stub.pid,
            fingerprint: stub.fingerprint,
            workspaceRoot: ws.root,
            taskId: stub.taskId,
            sessionId: stub.sessionId,
            reason: stub.reason,
            worktreePath: stub.worktreePath,
            branch: stub.branch,
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
  rehydratedHoldWorkspaceRoots.add(ws.root);
  return count;
}

/** TEST-ONLY: drop every in-memory hold and rehydrate guard. Not part of the runtime API. */
export function __resetBackgroundProcessHoldsForTest(): void {
  holdsByKey.clear();
  rehydratedHoldWorkspaceRoots.clear();
}
