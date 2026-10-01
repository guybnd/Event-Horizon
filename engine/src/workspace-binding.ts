import { existsSync } from 'fs';
import { openWorkspaceLive } from './task-store.js';
import {
  findRegisteredWorkspace,
  forgetOpenWorkspace,
  getRememberedOpenWorkspaces,
  hasWorkspaceStore,
  pathsEqual,
  rememberOpenWorkspace,
} from './workspace.js';
import {
  getDefaultWorkspace,
  getWorkspaceByRoot,
  normalizeWorkspaceKey,
  type Workspace,
  type WorkspaceBindingSource,
} from './workspace-context.js';

/**
 * Multi-board binding resolution — the ONE place that turns an `X-EH-Workspace` value (HTTP header,
 * `?ws=`, or the MCP per-connection header) into a `Workspace` + how it was resolved.
 *
 * Why this exists: before it, both the HTTP middleware (`attachWorkspace`) and the MCP mount
 * (`extractBoundWorkspaceFromRequest`) resolved the header against the LIVE registry only
 * (`getWorkspaceByRoot`, plus the boot/default root). A board that the user has "definitely open"
 * in the portal but that the engine has not `openWorkspaceLive()`-d in THIS process — the normal
 * state for every secondary board right after an engine restart, since only `lastWorkspace` is
 * re-activated at boot — therefore missed the lookup, and the session bound to it silently fell
 * back to the default board while still reporting `binding: 'header'` (the ALS store was non-null).
 * Agents dispatched on a secondary board then reported being "unable to bind" to a workspace the
 * user could see was open. This module closes that gap two ways:
 *
 * 1. A header naming a REGISTERED board (settings `workspaces[]`) that isn't live is auto-opened via
 *    the same non-destructive `openWorkspaceLive` path the portal's "open board" action uses, then
 *    bound — the board the caller asked for is exactly the board it gets.
 * 2. A header naming a root that is NOT registered at all resolves to `'header-unresolved'` rather
 *    than pretending to be a verified `'header'` binding, so disclosure surfaces
 *    (`get_board_config`, the MCP instructions line) and mutation guards can act on it.
 *
 * `restoreRememberedOpenWorkspaces` is the complementary boot-time fix: every board that was live
 * when the engine last ran (persisted by `rememberOpenWorkspace`) is brought back up after the
 * default board activates, so the "open" set survives a restart instead of collapsing to one board.
 */
export interface ResolvedWorkspaceBinding {
  /** The bound workspace, or `null` for unrouted/unresolved (callers fall back to the default). */
  ws: Workspace | null;
  source: WorkspaceBindingSource;
  /** Echo of the header value when `source === 'header-unresolved'`. */
  requestedRoot?: string;
  /** True when this call itself brought the board live (auto-open). */
  opened: boolean;
}

/**
 * Synchronous leg: a live registry entry, or the boot/default workspace when `root` names its root
 * (the default board is deliberately never a registry entry — see `defaultWorkspace`'s doc comment
 * in workspace-context.ts). `null` on a miss. Mirrors what `resolveWorkspaceFromRoot`
 * (middleware.ts) did before this module existed, minus its silent `getWorkspace()` fallback.
 */
export function resolveLiveWorkspace(root: string): Workspace | null {
  const registered = getWorkspaceByRoot(root);
  if (registered) return registered;
  const defaultWs = getDefaultWorkspace();
  if (defaultWs.root && normalizeWorkspaceKey(defaultWs.root) === normalizeWorkspaceKey(root)) return defaultWs;
  return null;
}

/** Collapse a repeated header/query value (`string[]`) to its first entry; `undefined` when absent. */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first : undefined;
}

/**
 * Bring a registered-but-not-live board up so a caller that named it can bind to it. Returns the
 * live `Workspace`, or `null` when `root` is not a registered board (or its folder/store is gone —
 * a registered entry whose directory was deleted must not be "opened" into an empty phantom).
 * Idempotent and concurrency-safe: `openWorkspaceLive` serializes on the target's own
 * `ActivationLock`, so N concurrent first requests for the same board hydrate it once and all
 * bind to the hydrated instance. Persists the board into the remembered open set on success.
 */
export async function autoOpenRegisteredWorkspace(root: string): Promise<Workspace | null> {
  const entry = await findRegisteredWorkspace(root);
  if (!entry) return null;
  if (!existsSync(entry.path) || !hasWorkspaceStore(entry.path)) return null;
  const ws = await openWorkspaceLive(entry.path);
  if (ws.root) {
    // Fire-and-forget: the binding must not wait on a settings-file write, and a failed persist
    // only costs the restore-on-restart convenience, never the binding itself.
    rememberOpenWorkspace(ws.root).catch((err) =>
      console.warn(`[workspace-binding] could not persist open board ${ws.root}:`, err),
    );
  }
  return ws;
}

/**
 * Resolve a routing value to a binding. `undefined`/empty → `default-fallback` (unrouted). A live
 * board (or the default root) → `header`. A registered-but-not-live board → auto-opened, `header`
 * with `opened: true`. Anything else → `header-unresolved` (the caller decides: HTTP reads fall back
 * to the default board, mutations are refused by `requireWorkspace`; MCP refuses all but the
 * diagnostic tools).
 */
export async function resolveWorkspaceBinding(root: string | string[] | undefined): Promise<ResolvedWorkspaceBinding> {
  const key = firstHeaderValue(root);
  if (!key) return { ws: null, source: 'default-fallback', opened: false };
  const live = resolveLiveWorkspace(key);
  if (live) return { ws: live, source: 'header', opened: false };
  try {
    const opened = await autoOpenRegisteredWorkspace(key);
    if (opened) return { ws: opened, source: 'header', opened: true };
  } catch (err) {
    console.error(`[workspace-binding] auto-open of "${key}" failed — treating the header as unresolved:`, err);
  }
  return { ws: null, source: 'header-unresolved', requestedRoot: key, opened: false };
}

/**
 * Boot-time restore of the remembered live-board set. Runs AFTER the default board has activated
 * (`index.ts`), sequentially so N boards don't hydrate in one burst, and never throws — a board
 * that can't be brought up is logged and dropped from the remembered set (its folder moved, its
 * store removed, or it was unregistered) rather than wedging the rest. Skips the default board
 * itself (already live) and anything already in the registry. Returns the roots it brought live.
 */
export async function restoreRememberedOpenWorkspaces(defaultRoot: string | null): Promise<string[]> {
  const remembered = await getRememberedOpenWorkspaces();
  const restored: string[] = [];
  for (const root of remembered) {
    if (defaultRoot && pathsEqual(root, defaultRoot)) {
      // The boot board is restored via `lastWorkspace`, never via this set — scrub a stale entry.
      await forgetOpenWorkspace(root).catch(() => {});
      continue;
    }
    if (getWorkspaceByRoot(root)) { restored.push(root); continue; }
    const entry = await findRegisteredWorkspace(root);
    if (!entry || !existsSync(entry.path) || !hasWorkspaceStore(entry.path)) {
      console.warn(`[workspace-binding] not restoring remembered board ${root}: ${!entry ? 'no longer registered' : 'folder or .flux/.flux-store missing'} — forgetting it.`);
      await forgetOpenWorkspace(root).catch(() => {});
      continue;
    }
    try {
      const ws = await openWorkspaceLive(entry.path);
      if (ws.root) restored.push(ws.root);
    } catch (err) {
      console.error(`[workspace-binding] failed to restore remembered board ${root}:`, err);
    }
  }
  if (restored.length) console.warn(`[workspace-binding] restored ${restored.length} previously open board(s): ${restored.join(', ')}`);
  return restored;
}
