import path from 'path';
import { realpathSync } from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import type chokidar from 'chokidar';
import type { Response } from 'express';
import type { StoredDoc } from './file-utils.js';
import type { SyncWorker } from './sync-watcher.js';
import type { GroupContext, MemberGroupBinding } from './group.js';

/** A ticket file that failed to parse/validate, keyed by ticket id in `Workspace.parseErrors`. */
export interface TaskParseError {
  id: string;
  path: string;
  error: string;
}

type FsWatcher = ReturnType<typeof chokidar.watch>;

/**
 * Serializes workspace activation (FLUX-343). `activateWorkspace` used to be guarded by nothing
 * but the `workspaceActivating` boolean — a signal, not a lock: two concurrent switch calls could
 * interleave cache-clear, watcher teardown, and `setWorkspaceRoot`, leaving the engine bound to
 * one root with the other root's watchers. Every activation now runs through `runExclusive`,
 * which chains callers so a second switch waits for the first to fully finish (including its
 * `finally` cleanup) before starting.
 */
export class ActivationLock {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    // Keep the chain alive whether fn resolved or rejected; the rejection still
    // propagates to `run`'s caller.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * The one active workspace's live state (FLUX-343, epic FLUX-1043). Everything here used to be
 * scattered module-level singletons — `tasksCache`/`docsCache`/`parseErrors`/`workspaceActivating`
 * in task-store.ts, `workspaceRoot` in workspace.ts, `configCache` in config.ts, plus the three
 * chokidar watcher handles — which made workspace switching racy and a parallel-workspaces mode
 * structurally impossible. Scope here is deliberately "one active workspace, encapsulated":
 * `getWorkspace()` is the single accessor, and the follow-up epic (FLUX-1230) swaps it for a
 * registry lookup without another consumer-wide rewrite.
 */
export class Workspace {
  /** Canonical absolute root path (realpath-normalized on activation), or null before first bind. */
  root: string | null = null;

  /**
   * All loaded tickets keyed by id. The value type intentionally stays `any` (FLUX-1073):
   * narrowing it cascades `| undefined` (noUncheckedIndexedAccess) into ~40 consumer files that
   * read/assign entries directly — see task-store.ts's TaskRecord doc comment for the history.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: Record<string, any> = {};

  /** All loaded docs (project docs + group docs) keyed by doc path. */
  docs: Record<string, StoredDoc> = {};

  /** Ticket files that failed to parse/validate, keyed by ticket id. */
  parseErrors: Record<string, TaskParseError> = {};

  /**
   * The workspace's merged config (defaults + config.json). Seeded lazily by config.ts's
   * `getConfig()` — stays `any` for the same FLUX-1073 reason as `tasks`. `null` only before
   * the very first `getConfig()` call in the process.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any = null;

  /**
   * True while `activateWorkspace` is mid-switch. Downstream write paths (REST create/update,
   * MCP tools, bootstrap import) check this and return a transient-retry error instead of
   * writing into a half-cleared cache. Serialization of the switch itself is `activationLock`'s
   * job — this flag is the cheap read-only signal for everyone else.
   */
  isActivating = false;

  /** chokidar watcher over the active .flux / .flux-store dir (tickets + config.json). */
  fluxWatcher: FsWatcher | null = null;

  /** chokidar watcher over the docs dir. */
  docsWatcher: FsWatcher | null = null;

  /** chokidar watcher over the active group's .flux-group store (null in single-repo mode). */
  groupDocsWatcher: FsWatcher | null = null;

  /** Serializes activateWorkspace calls — see {@link ActivationLock}. */
  readonly activationLock = new ActivationLock();

  /**
   * FLUX-1450 (epic FLUX-1230 S5): this workspace's connected SSE clients. Was the module-global
   * `clients` Set in events.ts — moved here so a board's event stream is isolated from every other
   * live workspace's. `events.ts` operates on this via an optional `ws = getWorkspace()` param, so
   * not-yet-migrated callers default-resolve to the single active workspace and behave exactly as
   * before.
   */
  sseClients: Set<Response> = new Set();

  /**
   * FLUX-1450: this workspace's `GET /api/tasks` ETag version counter. Was the module-global
   * `tasksVersion` in events.ts — per-workspace so board A's mutations can't invalidate board B's
   * cached ETag.
   */
  tasksVersion = 0;

  /**
   * FLUX-1453 (epic FLUX-1230 S8): this workspace's git-sync worker (orphan-mode flux-data sync) —
   * watcher/scheduler/status/conflicts/mutex/resurface-throttle, previously all module-level
   * singletons in sync-watcher.ts. `null` until first touched: sync-watcher.ts's internal
   * `workerFor(ws)` helper lazily constructs it (`ws.syncWorker ??= new SyncWorker(ws)`) rather
   * than this class doing so eagerly — that keeps this field a `type`-only import (erased at
   * runtime) instead of a real circular value-import between this module and sync-watcher.ts
   * (which itself imports `getWorkspace` from here for its free-function shims).
   */
  syncWorker: SyncWorker | null = null;

  /**
   * FLUX-1558: this workspace's own group context when it is a group parent, else `null`.
   * Populated in `hydrateWorkspace` alongside the `activateGroup` singleton it also still sets
   * (other not-yet-migrated consumers still read that global — see group.ts) so MCP handlers can
   * resolve the *bound* workspace's group instead of whichever workspace activated last.
   */
  groupContext: GroupContext | null = null;

  /**
   * FLUX-1558: this workspace's binding to a parent group when it is a member, else `null`.
   * Populated alongside `groupContext` — see that field's doc comment for why both exist
   * independently of the `group.ts` singletons.
   */
  memberBinding: MemberGroupBinding | null = null;
}

// Scope A (FLUX-343): exactly one Workspace per process, created eagerly and mutated in place by
// activation. Consumers must go through getWorkspace() at call time (not capture the fields at
// module scope) so the parallel-workspaces epic can swap this for per-request resolution.
//
// Scope B / FLUX-1230 S1 (this section): the registry primitive that swap replaces getWorkspace()
// with. `defaultWorkspace` below is kept as-is and is still what every not-yet-migrated call site
// (258 sites / 45 files as of the epic's 2026-07-16 regrounding) gets from a bare `getWorkspace()`
// call, so single-workspace behavior stays byte-for-byte unchanged until a later subtask (S2+)
// starts routing `doActivateWorkspace`/`setWorkspaceRoot` through `openWorkspace()` instead of
// mutating `defaultWorkspace` directly. That migration also owns reconciling `defaultWorkspace`
// with whatever root ends up registered under the same key — this ticket only adds the primitive.
const defaultWorkspace = new Workspace();

/**
 * FLUX-1513: the process's single/default `Workspace` instance — the one every not-yet-migrated
 * `getWorkspace()` call resolves to before anything is `openWorkspace()`-d. Exposed so a legacy
 * (untagged) Furnace batch's workspace can be resolved back to it for the back-compat filter in
 * `batchBelongsToWorkspaceRoot` (models/furnace.ts) without importing the private singleton directly.
 */
export function getDefaultWorkspace(): Workspace {
  return defaultWorkspace;
}

/**
 * Live workspace registry (FLUX-1446, epic FLUX-1230 S1). Keyed by the workspace's absolute root
 * path — chosen to match `recentEngineWrites`' existing path-keying (task-store.ts) rather than
 * inventing an opaque id. Keys are `normalizeWorkspaceKey()` output (realpath'd + case-folded on
 * win32, FLUX-1571) so a caller can pass any path *form* naming the same on-disk root — a raw
 * `path.resolve()`, an 8.3 short name, a differently-cased path — and land on the same entry;
 * every read/write below goes through that function, so callers no longer need to pre-canonicalize
 * themselves. Iteration order is maintained as least-recently-used-first (oldest) to
 * most-recently-used-last via `touch()`'s delete+re-insert, which is what `evictLeastRecentlyUsed`
 * and `closeWorkspace`'s fallback-to-next-active read.
 */
const registry = new Map<string, Workspace>();

/**
 * Root path key of the most-recently-`openWorkspace()`-d board (moved by `openWorkspace` and, on
 * close/evict, to the MRU survivor). FLUX-1557: this is now pure MRU bookkeeping only — nothing
 * reads it as a resolution target. `getWorkspace()` used to fall back to `registry.get(activeKey)`
 * when unbound, which meant "unbound" background code silently followed whichever board was
 * opened last rather than a deterministic target; see that function's doc comment for the demoted
 * (current) fallback.
 */
let activeKey: string | null = null;

/**
 * Eviction policy decision (named in the S1 PR per the ticket): explicit close is the primary,
 * expected lifecycle — callers that open a workspace are expected to close it when done. This cap
 * is a generous backstop, not the steady-state mechanism, so a leaked "forgot to close" workspace
 * can't grow the live set unboundedly; LRU (by `touch()` recency, not creation time) picks the
 * eviction candidate when it's hit.
 */
const MAX_OPEN_WORKSPACES = 8;

/**
 * Realpath-canonicalizes `rootPath` — resolves 8.3 short names and symlinks to the actual on-disk
 * form — WITHOUT case-folding, so the result stays safe to persist/display (Windows realpath
 * already returns the true on-disk casing; forcing lowercase here would corrupt a registry entry's
 * stored path / `path.basename` label fallback). Falls back to a plain `path.resolve()` when the
 * root doesn't exist yet (a stale/missing board root should still produce a stable value). Use this
 * for anything that gets STORED (`addWorkspaceEntry`, `autoRegisterWorkspace`); use
 * {@link normalizeWorkspaceKey} for COMPARISON/lookup.
 */
export function canonicalizeWorkspaceRoot(rootPath: string): string {
  try {
    return realpathSync.native(path.resolve(rootPath));
  } catch {
    return path.resolve(rootPath);
  }
}

/**
 * FLUX-1571: the registry key MUST be canonical (realpath'd + case-folded on win32), not a bare
 * `path.resolve()` — the S1 registry's own entries are already keyed this way (`openWorkspaceLive`
 * realpath's before calling `openWorkspace`, task-store.ts), but a raw caller-supplied root
 * (`getWorkspaceByRoot`/`resolveWorkspaceByRoot`, and — through them — the HTTP/MCP header
 * resolution in middleware.ts) was only ever `path.resolve()`d before the `Map.get`. An 8.3
 * short-name path or a differently-cased-but-same-file path then missed the lookup entirely and
 * silently fell back to the default board instead of erroring — the exact misroute this
 * normalizes away. Mirrors `task-worktree.ts`'s `canonical()`. Exported so every seam that needs
 * to compare against (or reproduce) a registry key uses the identical rule — see `middleware.ts`'s
 * `pathsEqual` and `workspace.ts`'s `pathsEqual`. For a value you're about to STORE rather than
 * compare, use {@link canonicalizeWorkspaceRoot} instead — this one case-folds on win32, which is
 * correct for a `Map` key but would corrupt a persisted/displayed path.
 */
export function normalizeWorkspaceKey(rootPath: string): string {
  const canonical = canonicalizeWorkspaceRoot(rootPath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Moves `key` to the most-recently-used end of the registry's iteration order. */
function touch(key: string): void {
  const ws = registry.get(key);
  if (!ws) return;
  registry.delete(key);
  registry.set(key, ws);
}

/** Closes whatever watchers a Workspace opened (FLUX-343 fields) — the "teardown" half of close/evict. */
async function teardownWorkspace(ws: Workspace): Promise<void> {
  const watchers = [ws.fluxWatcher, ws.docsWatcher, ws.groupDocsWatcher].filter(
    (w): w is FsWatcher => w != null,
  );
  ws.fluxWatcher = null;
  ws.docsWatcher = null;
  ws.groupDocsWatcher = null;
  // FLUX-1453: explicit stop on close — no symmetric restart to rely on once workspaces are
  // concurrent (a second workspace's `start()` no longer self-stops this one).
  ws.syncWorker?.stop();
  await Promise.all(watchers.map((w) => w.close()));
}

/** Shared close/evict body. `reason` only affects the error log line on a failed teardown. */
async function removeFromRegistry(rootPath: string, reason: 'close' | 'evict'): Promise<void> {
  const key = normalizeWorkspaceKey(rootPath);
  const ws = registry.get(key);
  if (!ws) return;
  registry.delete(key);
  if (activeKey === key) {
    // Fall back to the next most-recently-used still-open workspace, if any, so closing the
    // active one of several open workspaces doesn't strand `getWorkspace()` on `defaultWorkspace`
    // while sibling workspaces are still live. Map iteration order is LRU-first (see `touch`), so
    // the last key is the most-recently-used survivor.
    const remaining = [...registry.keys()];
    activeKey = remaining.length ? (remaining[remaining.length - 1] ?? null) : null;
  }
  try {
    await teardownWorkspace(ws);
  } catch (err) {
    console.error(`[workspace-registry] ${reason} teardown failed for ${key}:`, err);
  }
}

/** Evicts the single least-recently-used entry, skipping `excludeKey` (the one just opened). */
function evictLeastRecentlyUsed(excludeKey: string): void {
  for (const key of registry.keys()) {
    if (key === excludeKey) continue;
    void removeFromRegistry(key, 'evict');
    return;
  }
}

/**
 * Registers (or re-activates) the workspace rooted at `rootPath` and marks it the one
 * `getWorkspace()` resolves to. Each `Workspace` created here owns its own `ActivationLock`
 * (constructed in the `Workspace` class field initializer), so opening/closing one can never
 * race another's `activateWorkspace` — the lock is per-instance, not shared registry state.
 */
export function openWorkspace(rootPath: string): Workspace {
  const key = normalizeWorkspaceKey(rootPath);
  let ws = registry.get(key);
  if (ws) {
    touch(key);
  } else {
    ws = new Workspace();
    // FLUX-1571: `key` is case-folded on win32 (the Map key rule) — NOT what should be spawned/
    // displayed as the board's root. Store the realpath-canonical, true-cased form instead so
    // `ws.root` stays byte-identical to what `activateWorkspace`/callers expect to see and reuse.
    ws.root = canonicalizeWorkspaceRoot(rootPath);
    registry.set(key, ws);
    if (registry.size > MAX_OPEN_WORKSPACES) evictLeastRecentlyUsed(key);
  }
  activeKey = key;
  return ws;
}

/** Explicit close: deregisters `rootPath` and tears down its watchers. No-op if not open. */
export function closeWorkspace(rootPath: string): Promise<void> {
  return removeFromRegistry(rootPath, 'close');
}

/**
 * Forced removal of `rootPath`, identical teardown to `closeWorkspace` — exposed separately so a
 * caller (e.g. future ops/admin tooling) can distinguish "I decided to stop using this workspace"
 * from "the registry (or an operator) is reclaiming it out from under a possibly-still-referenced
 * caller" in logs and call sites, even though the underlying cleanup is the same today.
 */
export function evictWorkspace(rootPath: string): Promise<void> {
  return removeFromRegistry(rootPath, 'evict');
}

/** All currently-registered workspaces, LRU-first. Does not include `defaultWorkspace` unless it was also opened via `openWorkspace`. */
export function listWorkspaces(): Workspace[] {
  return [...registry.values()];
}

/**
 * FLUX-1450/FLUX-1452: workspaces that are live right now, for a fan-out that must never miss one.
 * `listWorkspaces()` only reflects workspaces opened through `openWorkspace()`; the boot/default
 * board is never itself a registry entry (see `defaultWorkspace`'s doc comment), so it's unioned in
 * explicitly — every not-yet-migrated caller (and any client that connects without a registry
 * binding) still resolves to it. Shared by the SSE broadcaster (events.ts) and the engine-lifetime
 * timers (index.ts's PR-reconcile tick, temper/gate-runner/stoke ticks).
 *
 * FLUX-1557: this used to also union the ambient `getWorkspace()` (FLUX-1548) to cover the then-
 * current "active" board on top of the default one. That's redundant now that `getWorkspace()`'s
 * unbound fallback is deterministically `defaultWorkspace` (see that function's doc comment) — every
 * caller here invokes this unbound, so `getWorkspace()` would just re-add the same workspace already
 * unioned below, while also tripping its new unbound-fallback dev warning on every tick. Any board
 * that's actually live is already covered by `registered` above.
 */
export function liveWorkspaces(): Workspace[] {
  const registered = listWorkspaces();
  // FLUX-1557: only union `getDefaultWorkspace()` — every board that's actually "live" via
  // `openWorkspace()` is already in `registered`, and `getWorkspace()` (unbound, which is how every
  // caller here invokes this) now resolves to the default workspace too (see that function's doc
  // comment), so unioning it in as well was always redundant post-demotion and would otherwise
  // spuriously trip its unbound-fallback warning on every temper/gate/stoke/PR-reconcile tick.
  const defaultWs = getDefaultWorkspace();
  const result = [...registered];
  if (!result.includes(defaultWs)) result.push(defaultWs);
  return result;
}

/**
 * Looks up a registered workspace by its root path (same key format `openWorkspace`/
 * `closeWorkspace` use — `normalizeWorkspaceKey`, realpath'd + case-folded, FLUX-1571). Returns
 * `undefined` if `rootPath` isn't currently registered — the caller (the MCP per-connection
 * binding, FLUX-1448 S3) falls back to `getWorkspace()` itself, the same "unrouted" behavior as
 * before the registry existed. In today's single-workspace mode the registry is empty (nothing
 * calls `openWorkspace` yet), so this always returns `undefined` and callers keep resolving to
 * `defaultWorkspace` via that fallback.
 */
export function getWorkspaceByRoot(rootPath: string): Workspace | undefined {
  return registry.get(normalizeWorkspaceKey(rootPath));
}

/**
 * FLUX-1555: like {@link getWorkspaceByRoot}, but also matches `getDefaultWorkspace()` — the
 * boot/single-board workspace is deliberately NEVER a registry entry (see `defaultWorkspace`'s doc
 * comment above), so a bare `getWorkspaceByRoot(root) ?? null` misses it once a SECOND board has
 * been opened (registry non-empty): `runWithWorkspace(null, fn)` would then fall through to
 * `getWorkspace()`'s ambient resolution instead of the intended default board. (Pre-FLUX-1557 that
 * ambient fallback could be a DIFFERENT board than the one this call intended to recover — the
 * exact silent-misroute this function exists to avoid; post-1557 the ambient fallback is
 * deterministically the default too, so this function is now mostly belt-and-suspenders for the
 * genuinely-registered case, but still the right thing to call.) Mirrors `resolveWorkspaceFromRoot`
 * (middleware.ts, FLUX-1455) for non-HTTP callers that need to resolve a bare root string to its
 * owning `Workspace` for a `runWithWorkspace` rebind (an unbound timer/callback recovering the
 * board that owns some persisted record) — background-loop callers that already track the record's
 * `ws` directly should keep using that instead. Returns `null` (not `getWorkspace()`) on a genuine
 * miss so callers can compose it with `runWithWorkspace`'s own "unrouted" null-fallback semantics.
 */
export function resolveWorkspaceByRoot(rootPath: string): Workspace | null {
  if (!rootPath) return null;
  const registered = getWorkspaceByRoot(rootPath);
  if (registered) return registered;
  const defaultWs = getDefaultWorkspace();
  if (defaultWs.root && normalizeWorkspaceKey(defaultWs.root) === normalizeWorkspaceKey(rootPath)) return defaultWs;
  return null;
}

/**
 * Epic FLUX-1230 (the "per-request resolution" swap promised in the Scope A note above): a
 * request/tool-call-scoped workspace binding that `getWorkspace()` consults FIRST.
 * Before this, every not-yet-migrated `getWorkspace()`/`getWorkspaceRoot()`/`getActiveFluxDir()`
 * call inside a request handler resolved to `activeKey` — i.e. whichever board was most recently
 * `openWorkspaceLive`-d (S10 switcher) — so opening board B silently repointed board A's
 * chat spawns (wrong cwd + wrong MCP binding), artifact serving, and session exit-handler
 * writes at B. Callers that route a request (HTTP `attachWorkspace`/`workspaceScope`, the MCP
 * per-connection binding) wrap the handling in `runWithWorkspace(ws, …)`; the binding then
 * propagates through every async continuation started inside it — including child-process
 * event handlers registered during a spawn, which is what keeps a session's lifecycle writes
 * on the board that launched it. A `null`/absent store falls through to `getWorkspace()`'s
 * deterministic `defaultWorkspace` fallback (FLUX-1557), so untouched background code stays
 * unambiguous rather than following whichever board happens to be "active".
 */
const requestWorkspaceALS = new AsyncLocalStorage<Workspace | null>();

/** Run `fn` with `ws` as the workspace every `getWorkspace()` call inside it resolves to.
 *  Pass `null` for "unrouted" (falls back to `getWorkspace()`'s deterministic default). */
export function runWithWorkspace<T>(ws: Workspace | null, fn: () => T): T {
  return requestWorkspaceALS.run(ws, fn);
}

/** Throttle for the unbound-fallback dev warning below — one board's worth of unmigrated
 *  background code can tick every few seconds; a `console.warn` per call would flood the log
 *  without adding signal beyond "this still happens". */
const UNBOUND_FALLBACK_WARN_INTERVAL_MS = 60_000;
let lastUnboundFallbackWarnAt = 0;

/**
 * The active workspace: the request-bound one when inside `runWithWorkspace`, else
 * `defaultWorkspace` — deterministic and independent of which board was most recently opened.
 *
 * FLUX-1557: before this ticket, the unbound path fell back to `activeKey` (the most-recently-
 * `openWorkspace()`-d board) before `defaultWorkspace`. That made any code with no ALS binding
 * (background loops not yet migrated to `runWithWorkspace`, the portal's headerless self-fetches)
 * silently follow whichever board the user last opened — with no way to point it back at the
 * default board short of closing every other tab. Once FLUX-1548 gave every background loop an
 * explicit binding, that fallback stopped being load-bearing for anything and became a footgun
 * for whatever unbound call sites remain (or get reintroduced): resolve deterministically to
 * `defaultWorkspace` instead, and warn (throttled) so a real unbound path is diagnosable rather
 * than silently landing on the wrong board. `activeKey` is still maintained by `openWorkspace`/
 * close (see its own doc comment) but is no longer consulted here.
 */
export function getWorkspace(): Workspace {
  const bound = requestWorkspaceALS.getStore();
  if (bound) return bound;
  if (registry.size > 0) {
    const now = Date.now();
    if (now - lastUnboundFallbackWarnAt >= UNBOUND_FALLBACK_WARN_INTERVAL_MS) {
      lastUnboundFallbackWarnAt = now;
      console.warn(
        `[workspace-context] getWorkspace() called with no request/runWithWorkspace binding while ${registry.size} other board(s) are open — resolving to the default workspace (${defaultWorkspace.root ?? '<unset>'}), not the "active" board. This call site needs an explicit runWithWorkspace binding.`,
      );
    }
  }
  return defaultWorkspace;
}