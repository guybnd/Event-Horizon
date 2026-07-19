// The Furnace — batch persistence (FLUX-1008 → FLUX-1053 batch redesign).
//
// Cache + on-disk sidecar + change events for Furnace batches, mirroring the discipline of
// `task-store.ts` (atomic write, shared in-memory cache) and the file layout of `models/workflow.ts`
// (JSON under a subdir of the active flux dir).
//
// WHY PERSISTED: a batch must survive a mid-burn engine restart, so each batch is a JSON sidecar at
// `<activeFluxDir>/furnace-batches/<id>.json` (gitignored runtime state). `getActiveFluxDir()` is
// pinned to the engine workspace root (never process.cwd()), so a worktree agent can't redirect it.
//
// CONCURRENCY: the Stoker does read-modify-write on a batch every tick while REST/MCP callers mutate
// the same batch. `mutateFurnaceBatch(id, fn)` serializes those through a per-batch async lock so an
// update can't clobber a concurrent one. All writes go through `atomicWriteFile` (tmp + rename).
//
// NO BACKWARD COMPAT: the old FurnaceRun/magazine sidecars lived under `furnace/`. The Furnace never
// shipped, so those are simply not read — this store uses a fresh `furnace-batches/` directory.

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { getActiveFluxDir } from './workspace.js';
import { getWorkspace, getDefaultWorkspace, resolveWorkspaceByRoot, runWithWorkspace, type Workspace } from './workspace-context.js';
import { atomicWriteFile } from './task-store.js';
import { broadcastEvent } from './events.js';
import { getConfig } from './config.js';
import {
  type FurnaceBatch,
  type BatchStatus,
  type BatchKind,
  type BatchTicket,
  type BatchTrigger,
  type FurnaceReport,
  type ReviewDepth,
  newFurnaceBatch,
  normalizeTicketOrder,
  clampBurnRate,
  furnaceReservedTicketIds,
  computeSlotsInUse,
  batchBranchName,
  isBatchTerminal,
  batchBelongsToWorkspaceRoot,
  BATCH_ICON_PALETTE,
  MAX_BURN_RATE,
} from './models/furnace.js';

// In-memory cache shared across REST routes, MCP tools, and the Stoker (all one process — FLUX-705).
// FLUX-1554: batch ids are process-wide-unique UUIDs (`randomUUID()` in `createFurnaceBatch`), so one
// flat id-keyed cache is safe to share across every board — no root-scoping needed for lookups. The
// split-brain bug was `loaded` being a SINGLE global flag: `ensureFurnaceLoaded()` only ever loaded
// whichever board's directory was ambiently active at the FIRST touch, so a second board's sidecars
// were never read into the cache at all (and a batch mutated while a different board was active wrote
// its `persist()` to THAT board's dir instead of its own — see `persist()` below). Track "have we
// loaded this root's directory" PER ROOT instead, so each live board's furnace-batches dir gets merged
// into the shared cache on its own first touch.
let cache: Record<string, FurnaceBatch> = {};
const loadedRoots = new Set<string>();
let iconCursor = 0;

/** Resolve `root`'s own furnace-batches dir — NOT `getActiveFluxDir()` (which resolves whatever board
 *  is ambiently active) — so a per-board load/persist always lands in the RIGHT board's dir regardless
 *  of what else is active when it runs (FLUX-1554, same fix shape as hitl-prompts.ts's `fluxDirForRoot`,
 *  FLUX-1555). Omitting `root` preserves the old ambient behavior byte-for-byte: `resolveWorkspaceByRoot`
 *  misses for an unregistered root (the common single-board case) and `runWithWorkspace(null, …)` then
 *  falls through to `getWorkspace()`'s own active/default resolution, which in single-board mode IS the
 *  ambient root already captured by the default parameter. */
export function getFurnaceDir(root: string | null = getWorkspace().root): string {
  return path.join(runWithWorkspace(resolveWorkspaceByRoot(root ?? ''), () => getActiveFluxDir()), 'furnace-batches');
}

function batchPath(id: string, root: string | null): string {
  return path.join(getFurnaceDir(root), `${id}.json`);
}

// ── Per-batch serialization ────────────────────────────────────────────────────
const chains = new Map<string, Promise<void>>();

export function withFurnaceLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  chains.set(id, result.then(() => {}, () => {}));
  return result;
}

// ── Load / read ──────────────────────────────────────────────────────────────

/** A parsed sidecar is a batch only if it carries the batch shape (id + tickets[] + kind). */
function looksLikeBatch(v: unknown): v is FurnaceBatch {
  const b = v as Partial<FurnaceBatch> | null;
  return !!b && typeof b.id === 'string' && Array.isArray(b.tickets) && typeof b.kind === 'string';
}

/**
 * Load `root`'s batches from disk, MERGING them into the shared cache (FLUX-1554) — replacing the
 * whole cache here (the pre-1554 shape) would drop every other already-loaded board's entries the
 * instant a second board's directory was read. Marks `root` loaded even on an empty/missing dir so a
 * board with zero batches doesn't get rescanned on every call.
 */
export async function loadFurnaceBatches(root: string | null = getWorkspace().root): Promise<FurnaceBatch[]> {
  const dir = getFurnaceDir(root);
  const loadedHere: FurnaceBatch[] = [];
  if (existsSync(dir)) {
    let files: string[];
    try { files = await fs.readdir(dir); } catch { files = []; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf-8');
        const parsed = JSON.parse(raw);
        if (looksLikeBatch(parsed)) { cache[parsed.id] = parsed; loadedHere.push(parsed); }
      } catch { /* skip a malformed sidecar rather than crash the load */ }
    }
  }
  loadedRoots.add(rootKey(root));
  return loadedHere;
}

/** Load `root`'s batches into the cache if we haven't yet (call before first read in a request path). */
export async function ensureFurnaceLoaded(root: string | null = getWorkspace().root): Promise<void> {
  if (!loadedRoots.has(rootKey(root))) await loadFurnaceBatches(root);
}

export function getFurnaceBatchesCache(): FurnaceBatch[] {
  return Object.values(cache);
}

export function getFurnaceBatch(id: string): FurnaceBatch | undefined {
  return cache[id];
}

/** All batches currently burning. */
export function getBurningBatches(): FurnaceBatch[] {
  return Object.values(cache).filter((b) => b.status === 'burning');
}

/**
 * FLUX-1513: batches (any status) belonging to `ws` — tagged batches by their own `workspaceRoot`,
 * untagged legacy batches by falling back to the default workspace. See `batchBelongsToWorkspaceRoot`.
 */
export function getFurnaceBatchesCacheForWorkspace(ws: Workspace): FurnaceBatch[] {
  const defaultRoot = getDefaultWorkspace().root;
  return getFurnaceBatchesCache().filter((b) => batchBelongsToWorkspaceRoot(b, ws.root, defaultRoot));
}

/** FLUX-1513: `getBurningBatches()` narrowed to the batches belonging to `ws`. */
export function getBurningBatchesForWorkspace(ws: Workspace): FurnaceBatch[] {
  const defaultRoot = getDefaultWorkspace().root;
  return getBurningBatches().filter((b) => batchBelongsToWorkspaceRoot(b, ws.root, defaultRoot));
}

// ── Worktree-slot accounting (global, across all burning batches) ────────────────

export const FURNACE_SLOT_CAP = MAX_BURN_RATE;

/** FLUX-1551: normalize a workspace root to a stable Map key — `Workspace.root` can be `null`
 *  (unbound state), so every per-root accessor below funnels through this rather than keying
 *  on `null` directly (which would collide across genuinely-unbound workspaces). */
function rootKey(root: string | null): string {
  return root ?? '';
}

/**
 * FLUX-1067: the count of ACTUAL live task worktrees, observed from the git worktree pool
 * (`listTaskWorktrees`) rather than inferred from the Furnace's own burn state. The Stoker refreshes
 * this each drive cycle (and the read/ignite paths refresh it on demand — see `refreshWorktreePool`),
 * so a worktree that is live for a reason the Furnace isn't tracking — a manually resumed/driven session,
 * a taken-over parked ticket — is still counted. Without this the gauge could read `0/4 used` while a
 * real worktree ran, and igniting would over-spawn past the real pool. Defaults to 0 until first refresh.
 *
 * FLUX-1551: keyed PER WORKSPACE ROOT — one board's `refreshWorktreePool()` scan must not overwrite
 * (or be read as) another board's observed pool. `globalSlotsInUse` still sums every root's pool into
 * the ONE shared cap (see below) — this is a census-correctness fix, not a budget-policy change.
 */
const observedWorktreesByRoot = new Map<string, { count: number; ticketIds: Set<string> }>();

/**
 * FLUX-1067: record the live task-worktree pool observed from disk — by IDENTITY, not just a count (M3).
 * Each entry is the owning ticket id recovered from the worktree path (`ticketIdFromWorktreePath`), or null
 * when a path doesn't resolve to a task worktree. Keeping the ids lets {@link globalSlotsInUse} tell a
 * Furnace-backed worktree apart from an independent one, so a freshly-claimed reservation whose worktree
 * isn't on disk yet is ADDED to the observed pool rather than masked by a `max()`.
 */
export function setObservedWorktrees(root: string | null, ticketIds: readonly (string | null)[]): void {
  observedWorktreesByRoot.set(rootKey(root), {
    count: ticketIds.length,
    ticketIds: new Set(ticketIds.filter((id): id is string => !!id)),
  });
}

/**
 * Worktree slots currently in use (FLUX-1067, revised for M3, re-derived per-root for FLUX-1551). Sums the
 * INDEPENDENT observed worktrees (live for a reason the Furnace isn't tracking — a manually resumed/taken-over
 * ticket) with the Furnace's own reservations, counting a reservation once whether or not its worktree is
 * on disk yet. See {@link computeSlotsInUse} for why the old `max(reservations, observed)` could undercount.
 *
 * FLUX-1157: counts EVERY observed worktree — no batch-state exclusion. FLUX-1090 used to drop an observed
 * worktree belonging to a ticket in a terminal (done/parked) batch on the assumption that batch finalizing
 * meant the worktree was reclaimed — it wasn't (takeover semantics never delete it, and a dirty tree or a
 * non-reclaimable ticket status can leave it on disk indefinitely). That let the gauge report free slots
 * while `createTaskWorktree`'s own physical count — which has no such exemption — was genuinely full, so
 * ignite kept admitting batches into guaranteed spawn failures. The real fix is to actually reclaim what's
 * reclaimable before counting (see `igniteBatch`/`resumeBatch` in furnace-stoker.ts, which run
 * `reclaimReadyWorktrees` first), so what's left on disk here is the physical truth.
 *
 * FLUX-1551: computed PER ROOT then summed, rather than one flat `computeSlotsInUse` call over every
 * reservation/observation regardless of board. Two boards can share a bare ticket id (`FLUX-` prefix on
 * both), so comparing a reserved id against an observed id across DIFFERENT roots' pools would falsely
 * dedup (or fail to dedup) them by identity. Per-root computation keeps the identity match scoped to a
 * single board while the SUM across roots still counts against the one shared `FURNACE_SLOT_CAP` — a
 * per-machine budget (see FLUX-1452's `driveStokeTick` comment in furnace-stoker.ts), not a per-board one.
 */
export function globalSlotsInUse(): number {
  const batches = Object.values(cache);
  const defaultRoot = getDefaultWorkspace().root;
  const reservedByRoot = new Map<string, Set<string>>();
  const addReserved = (root: string | null, ids: readonly string[]): void => {
    if (!ids.length) return;
    const key = rootKey(root);
    let set = reservedByRoot.get(key);
    if (!set) { set = new Set(); reservedByRoot.set(key, set); }
    for (const id of ids) set.add(id);
  };
  for (const b of batches) addReserved(b.workspaceRoot ?? defaultRoot, furnaceReservedTicketIds(b));
  for (const [key, ids] of temperReservedByRoot) addReserved(key, [...ids]);

  const allRootKeys = new Set([...reservedByRoot.keys(), ...observedWorktreesByRoot.keys()]);
  let total = 0;
  for (const key of allRootKeys) {
    const reserved = [...(reservedByRoot.get(key) ?? [])];
    const pool = observedWorktreesByRoot.get(key);
    total += computeSlotsInUse(reserved, { count: pool?.count ?? 0, ticketIds: pool ? [...pool.ticketIds] : [] });
  }
  return total;
}

/** Free worktree slots right now (cap − in-use), floored at 0. Still ONE shared budget across every board. */
export function freeSlots(cap: number = FURNACE_SLOT_CAP): number {
  return Math.max(0, cap - globalSlotsInUse());
}

/**
 * FLUX-1244: does this ticket ALREADY hold an observed worktree on disk, on `root`? A re-spawn on such a
 * ticket (Temper re-implement/re-review, a resumed session) reuses that worktree via the shared branch —
 * it claims NO new slot — so a slot-availability gate must exempt it, otherwise the ticket's own worktree
 * counts against it and a full pool self-stalls its in-flight loop. Reads the identity set maintained by
 * {@link setObservedWorktrees} (FLUX-1067) for `root`'s pool specifically (FLUX-1551) — a same-id ticket
 * on a DIFFERENT board's pool must never satisfy this check. Pair with a `refreshWorktreePool()` when
 * freshness matters.
 */
export function ticketHasObservedWorktree(root: string | null, ticketId: string): boolean {
  return observedWorktreesByRoot.get(rootKey(root))?.ticketIds.has(ticketId) ?? false;
}

/**
 * FLUX-1239: Temper's own in-memory pending-slot reservations. A Furnace batch's active tickets count
 * toward {@link globalSlotsInUse} synchronously via `furnaceReservedTicketIds` the instant a ticket's
 * state flips to implementing/reviewing — but Temper has no persisted batch state to derive a reservation
 * from, and the on-disk worktree it will eventually claim isn't observed until a later
 * `refreshWorktreePool()`. Without this, a same-tick/same-TTL burst of `spawnTemper` calls (several branch
 * tickets entering Ready within the TTL-coalesced refresh window) all read the same stale free-slot count
 * and can all pass the gate, over-committing the pool. `spawnTemper` checks-then-reserves synchronously (no
 * await in between), so the next sibling call in the same burst sees the slot as taken. Released on spawn
 * failure (no worktree was actually claimed) or once Temper stops driving the ticket; while the reservation
 * and an observed worktree overlap for the same id, the identity-based dedup in `computeSlotsInUse` counts
 * it once.
 *
 * FLUX-1551: keyed PER ROOT (`Map<root, Set<ticketId>>`) — two boards sharing a bare ticket id must reserve
 * (and release) independently; the earlier flat `Set<ticketId>` let one board's `setTemperReserved(id, false)`
 * silently clear the OTHER board's reservation for the same id.
 */
const temperReservedByRoot = new Map<string, Set<string>>();

export function setTemperReserved(root: string | null, ticketId: string, reserved: boolean): void {
  const key = rootKey(root);
  if (reserved) {
    let set = temperReservedByRoot.get(key);
    if (!set) { set = new Set(); temperReservedByRoot.set(key, set); }
    set.add(ticketId);
  } else {
    const set = temperReservedByRoot.get(key);
    if (set) {
      set.delete(ticketId);
      if (set.size === 0) temperReservedByRoot.delete(key);
    }
  }
}

export function isTemperReserved(root: string | null, ticketId: string): boolean {
  return temperReservedByRoot.get(rootKey(root))?.has(ticketId) ?? false;
}

/** FLUX-1257: snapshot of every ticket Temper currently holds a slot reservation for, across ALL boards —
 *  see {@link setTemperReserved}. Diagnostic/naming use only (`describeSlotHolders`, `checkFurnaceSlotHealth`);
 *  a same ticket id reserved on two different roots collapses to one entry when de-duped by a caller. */
export function getTemperReservedTicketIds(): string[] {
  return [...temperReservedByRoot.values()].flatMap((set) => [...set]);
}

// ── Persist / mutate ───────────────────────────────────────────────────────────

/** Always writes to the batch's OWN root — never the ambiently-active board's dir (FLUX-1554's
 *  split-brain fix) — so a batch created on board B and mutated while board A is active still lands
 *  its sidecar under B's `furnace-batches/`. Untagged legacy batches fall back to the default
 *  workspace, mirroring `batchBelongsToWorkspaceRoot`'s own fallback (models/furnace.ts). */
async function persist(batch: FurnaceBatch): Promise<void> {
  const root = batch.workspaceRoot ?? getDefaultWorkspace().root;
  const dir = getFurnaceDir(root);
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(batchPath(batch.id, root), JSON.stringify(batch, null, 2));
}

function emit(event: 'furnace-updated' | 'furnace-deleted', data: unknown): void {
  broadcastEvent(event, data);
}

function nextIcon(): string {
  const icon = BATCH_ICON_PALETTE[iconCursor % BATCH_ICON_PALETTE.length] ?? 'bolt';
  iconCursor += 1;
  return icon;
}

export interface CreateBatchInput {
  title: string;
  kind?: BatchKind;
  tickets?: BatchTicket[];
  burnRate?: number;
  retryCap?: number;
  maxConsecutiveFailures?: number;
  rateLimitRetryIntervalMs?: number;
  rateLimitMaxWaitMs?: number;
  reviewDepth?: ReviewDepth;
  reviewPersonaId?: string;
  sessionTimeoutMs?: number;
  trigger?: BatchTrigger;
  branch?: string;
  icon?: string;
  createdBy?: string;
  spawnedFrom?: { batchId: string; ticketId: string };
  /** FLUX-1513: owning-workspace root, stamped by the caller from its bound workspace. */
  workspaceRoot?: string;
}

export async function createFurnaceBatch(input: CreateBatchInput): Promise<FurnaceBatch> {
  const id = randomUUID();
  // FLUX-1063: new batches inherit the global rate-limit cooldown settings as their defaults; an
  // explicit per-batch value on the input still wins. `newFurnaceBatch` falls back to the DEFAULT_*
  // constants when neither is set (e.g. no config loaded).
  const fs = getConfig().furnaceSettings || {};
  const rateLimitRetryIntervalMs = input.rateLimitRetryIntervalMs ?? fs.rateLimitRetryIntervalMs;
  const rateLimitMaxWaitMs = input.rateLimitMaxWaitMs ?? fs.rateLimitMaxWaitMs;
  const sessionTimeoutMs = input.sessionTimeoutMs ?? fs.sessionTimeoutMs;
  const batch = newFurnaceBatch({
    id,
    now: new Date().toISOString(),
    title: input.title,
    icon: input.icon ?? nextIcon(),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.tickets ? { tickets: input.tickets } : {}),
    ...(input.burnRate !== undefined ? { burnRate: input.burnRate } : {}),
    ...(input.retryCap !== undefined ? { retryCap: input.retryCap } : {}),
    ...(input.maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures: input.maxConsecutiveFailures } : {}),
    ...(rateLimitRetryIntervalMs !== undefined ? { rateLimitRetryIntervalMs } : {}),
    ...(rateLimitMaxWaitMs !== undefined ? { rateLimitMaxWaitMs } : {}),
    ...(input.reviewDepth ? { reviewDepth: input.reviewDepth } : {}),
    ...(input.reviewPersonaId ? { reviewPersonaId: input.reviewPersonaId } : {}),
    ...(sessionTimeoutMs !== undefined ? { sessionTimeoutMs } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    ...(input.spawnedFrom ? { spawnedFrom: input.spawnedFrom } : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
  });
  cache[id] = batch;
  await persist(batch);
  emit('furnace-updated', { id, batch });
  return batch;
}

/**
 * Read-modify-write a batch under its per-batch lock. The mutator receives a structured clone it may
 * freely mutate (or return a replacement); returning `null` aborts the write. `updatedAt` and
 * ticket-order normalization are applied automatically. Returns the persisted batch, or null if the
 * batch is unknown / the mutator aborted.
 */
export async function mutateFurnaceBatch(
  id: string,
  mutator: (batch: FurnaceBatch) => FurnaceBatch | null | void,
): Promise<FurnaceBatch | null> {
  return withFurnaceLock(id, async () => {
    const current = cache[id];
    if (!current) return null;
    const draft = structuredClone(current);
    const returned = mutator(draft);
    if (returned === null) return null;
    const next = (returned ?? draft) as FurnaceBatch;
    next.id = current.id;
    next.createdAt = current.createdAt;
    next.updatedAt = new Date().toISOString();
    next.tickets = normalizeTicketOrder(next.tickets);
    // Stamp completedAt the first time a batch reaches a terminal status.
    if (isBatchTerminal(next.status) && !next.completedAt) next.completedAt = next.updatedAt;
    cache[id] = next;
    await persist(next);
    emit('furnace-updated', { id, batch: next });
    return next;
  });
}

export interface UpdateBatchPatch {
  title?: string;
  kind?: BatchKind;
  tickets?: BatchTicket[];
  burnRate?: number;
  retryCap?: number;
  maxConsecutiveFailures?: number;
  rateLimitRetryIntervalMs?: number;
  rateLimitMaxWaitMs?: number;
  reviewDepth?: ReviewDepth;
  reviewPersonaId?: string;
  sessionTimeoutMs?: number;
  trigger?: BatchTrigger | null;
  branch?: string;
  status?: BatchStatus;
  report?: FurnaceReport;
  consecutiveFailures?: number;
  ignitedAt?: string;
  completedAt?: string;
  stopReason?: string;
}

/**
 * Shallow-patch a batch's top-level fields. Guards the immutables:
 *   - `branch` is only patchable while the batch is a `draft` (immutable after ignite).
 *   - `kind` is only patchable while `draft`.
 *   - a title rename is always allowed; while `draft` it also recomputes `branch` (no live ref yet),
 *     but once burning/terminal the branch is fixed and only the display title changes (FLUX-1062).
 *   - `status` here is a raw write; transitions with side effects (ignite/stop) go through the Stoker.
 */
export async function updateFurnaceBatch(id: string, patch: UpdateBatchPatch): Promise<FurnaceBatch | null> {
  return mutateFurnaceBatch(id, (b) => {
    const isDraft = b.status === 'draft';
    if (patch.title !== undefined) {
      b.title = patch.title;
      // FLUX-1062 (#3): while `draft` no worktree/branch ref exists yet, so a rename recomputes the
      // derived branch to match the new title. Once burning/terminal the branch is fixed — the title
      // still updates (display-only), but the branch is left alone. An explicit `patch.branch` below
      // still wins for draft batches.
      if (isDraft) b.branch = batchBranchName(b.id, patch.title);
    }
    if (patch.kind !== undefined && isDraft) {
      b.kind = patch.kind;
      if (b.kind === 'sequential') b.burnRate = 1;
    }
    if (patch.branch !== undefined && isDraft) b.branch = patch.branch;
    if (patch.tickets !== undefined) b.tickets = patch.tickets;
    if (patch.burnRate !== undefined) b.burnRate = b.kind === 'sequential' ? 1 : clampBurnRate(patch.burnRate);
    if (patch.retryCap !== undefined) b.retryCap = patch.retryCap;
    if (patch.maxConsecutiveFailures !== undefined) b.maxConsecutiveFailures = patch.maxConsecutiveFailures;
    if (patch.rateLimitRetryIntervalMs !== undefined) b.rateLimitRetryIntervalMs = patch.rateLimitRetryIntervalMs;
    if (patch.rateLimitMaxWaitMs !== undefined) b.rateLimitMaxWaitMs = patch.rateLimitMaxWaitMs;
    if (patch.reviewDepth !== undefined) b.reviewDepth = patch.reviewDepth;
    if (patch.reviewPersonaId !== undefined) b.reviewPersonaId = patch.reviewPersonaId;
    if (patch.sessionTimeoutMs !== undefined) b.sessionTimeoutMs = patch.sessionTimeoutMs;
    if (patch.trigger !== undefined) {
      if (patch.trigger === null) delete b.trigger;
      else b.trigger = patch.trigger;
    }
    if (patch.status !== undefined) b.status = patch.status;
    if (patch.report !== undefined) b.report = patch.report;
    if (patch.consecutiveFailures !== undefined) b.consecutiveFailures = patch.consecutiveFailures;
    if (patch.ignitedAt !== undefined) b.ignitedAt = patch.ignitedAt;
    if (patch.completedAt !== undefined) b.completedAt = patch.completedAt;
    if (patch.stopReason !== undefined) b.stopReason = patch.stopReason;
    return b;
  });
}

/**
 * Atomically claim worktree slots for a batch and flip it to `burning`. The free-slot check and the
 * in-memory status write happen with NO `await` between them, so — on the single-threaded event loop —
 * the check-and-set is indivisible: two concurrent ignites can't both observe the last free slot and
 * both reach `burning`. A parallel batch's burn rate is clamped to the free slots at claim time.
 * Returns the claimed batch, or an error `{ error, used, max }` when no slot is free / the batch is unknown.
 */
export async function claimSlotsAndIgnite(
  id: string,
  ignitedAt: string,
  cap: number = FURNACE_SLOT_CAP,
): Promise<{ ok: boolean; error?: string; used?: number; max?: number; batch?: FurnaceBatch }> {
  const current = cache[id];
  if (!current) return { ok: false, error: 'Furnace batch not found' };
  const free = freeSlots(cap);
  if (free < 1) {
    return { ok: false, error: 'no_slots', used: globalSlotsInUse(), max: cap };
  }
  // Synchronous claim — flip status before any await so a concurrent claim sees the slot(s) taken.
  current.status = 'burning';
  if (current.kind === 'parallel') current.burnRate = Math.min(clampBurnRate(current.burnRate), free);
  if (!current.ignitedAt) current.ignitedAt = ignitedAt;
  current.updatedAt = new Date().toISOString();
  await persist(current);
  emit('furnace-updated', { id, batch: current });
  return { ok: true, batch: current, used: globalSlotsInUse(), max: cap };
}

export async function deleteFurnaceBatch(id: string): Promise<boolean> {
  return withFurnaceLock(id, async () => {
    const existing = cache[id];
    if (!existing) return false;
    delete cache[id];
    const root = existing.workspaceRoot ?? getDefaultWorkspace().root;
    const p = batchPath(id, root);
    if (existsSync(p)) await fs.unlink(p).catch(() => {});
    emit('furnace-deleted', { id });
    return true;
  });
}

// Test-only: reset the module cache between test cases (no on-disk effect).
export function __resetFurnaceStoreForTests(): void {
  cache = {};
  loadedRoots.clear();
  iconCursor = 0;
  observedWorktreesByRoot.clear();
  temperReservedByRoot.clear();
  chains.clear();
}

// Re-export commonly used helpers for callers that import from the store.
export { batchBranchName };
