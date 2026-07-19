import express from 'express';
import { getWorkspaceRoot } from './workspace.js';
import { getDefaultWorkspace, getWorkspace, getWorkspaceByRoot, normalizeWorkspaceKey, runWithWorkspace, type Workspace } from './workspace-context.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express request augmentation requires the ambient namespace
  namespace Express {
    interface Request {
      /** The active workspace, attached by {@link attachWorkspace} (FLUX-343). */
      workspace?: Workspace;
    }
  }
}

/**
 * Resolves a `x-eh-workspace`/`?ws=` value against the S1 registry (FLUX-1530), mirroring
 * `extractBoundWorkspaceFromRequest`/`boundWorkspace` in mcp-server.ts: an array (repeated
 * header/query param) collapses to its first entry, and an unset or unregistered root falls
 * back to `getWorkspace()` — never an error, same "unrouted" semantics as the MCP path.
 *
 * FLUX-1455 review fix: a root naming the legacy default/boot binding must resolve to
 * `defaultWorkspace` even when it's not a registry entry (it never is — see `defaultWorkspace`'s
 * doc comment in workspace-context.ts) and even when `activeKey` has since moved to a different
 * board opened via `openWorkspaceLive`. Without this, a client pinned to the boot board sends its
 * root back on every request but `getWorkspaceByRoot` misses (unregistered) and the `getWorkspace()`
 * fallback silently served whichever board was most recently opened instead.
 *
 * FLUX-1571: this comparison MUST use the same `normalizeWorkspaceKey` (realpath'd + case-folded)
 * rule the S1 registry keys itself with — `getWorkspaceByRoot` below already does, via that
 * function, but the `defaultWs` fallback used a bare `path.resolve()` + case-fold local `pathsEqual`
 * that had no realpath step. A client that echoes back an 8.3-short-form or differently-cased
 * (but on-disk-identical) root for the *default* board missed both checks and silently fell through
 * to `getWorkspace()`'s ambient resolution — usually still correct today, but no longer guaranteed
 * once a second board is open (S10 switcher), which is exactly the silent-misroute this ticket
 * covers.
 */
export function resolveWorkspaceFromRoot(root: string | string[] | undefined): Workspace {
  const key = Array.isArray(root) ? root[0] : root;
  if (!key) return getWorkspace();
  const registered = getWorkspaceByRoot(key);
  if (registered) return registered;
  const defaultWs = getDefaultWorkspace();
  if (defaultWs.root && normalizeWorkspaceKey(defaultWs.root) === normalizeWorkspaceKey(key)) return defaultWs;
  return getWorkspace();
}

/**
 * Attach the request's workspace (FLUX-343, routed per-request as of FLUX-1530). Resolves the
 * `X-EH-Workspace` header against the S1 registry via {@link resolveWorkspaceFromRoot}; an
 * unset or unregistered root falls back to the registry's active/default workspace, so
 * single-workspace mode (empty registry) is byte-for-byte unchanged.
 *
 * Header absent → fall back to `?ws=` (same value/semantics): browser-navigated resources —
 * the artifact `<iframe src>`, plain link opens — can't set custom headers, exactly like the
 * SSE route's `EventSource` (events.ts). Without this, an artifact iframe on board A served
 * whatever board was most recently opened via the S10 switcher.
 */
export function attachWorkspace(req: express.Request, _res: express.Response, next: express.NextFunction) {
  let root: string | string[] | undefined = req.headers['x-eh-workspace'];
  if (!root || (Array.isArray(root) && !root.length)) {
    const q = req.query?.ws;
    if (typeof q === 'string') root = q;
    else if (Array.isArray(q)) root = q.filter((v): v is string => typeof v === 'string');
  }
  req.workspace = resolveWorkspaceFromRoot(root);
  next();
}

/**
 * Run the rest of the request inside the {@link runWithWorkspace} binding for
 * `req.workspace` (epic FLUX-1230's per-request resolution seam) so every legacy
 * `getWorkspace()`/`getWorkspaceRoot()`/`getActiveFluxDir()` call downstream — route handlers,
 * backgrounded launch work started from them, and child-process event handlers registered
 * during a spawn — resolves to the board this request targeted instead of whichever board was
 * most recently opened. Mounted globally right after {@link attachWorkspace}. For a request
 * with no routing header/param this binds exactly what `getWorkspace()` would have returned
 * anyway (resolveWorkspaceFromRoot's fallback), so behavior is unchanged there.
 */
export function workspaceScope(req: express.Request, _res: express.Response, next: express.NextFunction) {
  runWithWorkspace(req.workspace ?? null, () => next());
}

export function requireWorkspace(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!getWorkspaceRoot()) {
    res.status(503).json({ error: 'No workspace configured', code: 'NO_WORKSPACE' });
    return;
  }
  next();
}

/** True for a bare hostname that resolves to loopback (no port, brackets already stripped). */
export function isLoopbackHostname(hostname: string): boolean {
  const h = (hostname || '').toLowerCase().trim();
  return (
    h === '' ||
    h === 'localhost' ||
    h === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/** Strip a trailing :port and IPv6 brackets from a `host`/URL-hostname value. */
function bareHostname(value: string): string {
  let h = (value || '').toLowerCase().trim();
  if (h.startsWith('[')) {
    // bracketed IPv6, e.g. "[::1]:3067" -> "::1"
    const end = h.indexOf(']');
    h = end > 0 ? h.slice(1, end) : h.slice(1);
  } else {
    h = h.replace(/:\d+$/, ''); // strip trailing :port
  }
  return h;
}

/**
 * Loopback-only guard (FLUX-774). EH's trust model is "single user on localhost" with NO
 * server-side authz by design, and the engine spawns agents with shell/file access — so the API
 * must never be reachable from the network. The listener binds 127.0.0.1; this additionally
 * rejects any request whose `Host` header isn't a loopback name, which closes the DNS-rebinding
 * browser vector (a malicious page that rebinds its domain to 127.0.0.1 still sends its own Host).
 * Mounted only when EH_ALLOW_REMOTE is unset; set EH_ALLOW_REMOTE=1 to deliberately expose on a
 * trusted network (the engine then binds 0.0.0.0 and this guard is skipped).
 */
export function loopbackOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isLoopbackHostname(bareHostname(req.headers.host || ''))) {
    res.status(403).json({
      error: 'Event Horizon only accepts loopback connections. Set EH_ALLOW_REMOTE=1 to expose it on your network (no auth — trusted networks only).',
      code: 'NON_LOOPBACK',
    });
    return;
  }
  next();
}

/**
 * Cross-origin guard (FLUX-783). `loopbackOnly` inspects only `Host`, but a malicious site the
 * user merely visits can still send same-Host requests to http://localhost:<port>/api/... from its
 * own origin. The browser attaches an `Origin` header on such cross-site requests; reject any
 * request whose present Origin is NOT loopback. Requests with no Origin (same-origin navigations,
 * curl, server-side callers) pass. Pairs with the loopback-only CORS allowlist in index.ts so a
 * drive-by page can neither drive the API nor read its responses. Skipped under EH_ALLOW_REMOTE.
 */
export function originGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const origin = req.headers.origin;
  if (origin) {
    let hostname = 'invalid'; // sentinel: an unparseable Origin is treated as non-loopback
    try {
      hostname = bareHostname(new URL(origin).hostname);
    } catch {
      /* keep sentinel */
    }
    if (!isLoopbackHostname(hostname)) {
      res.status(403).json({
        error: 'Cross-origin requests are not allowed — Event Horizon is loopback-only. Set EH_ALLOW_REMOTE=1 to disable this guard (trusted networks only).',
        code: 'NON_LOOPBACK_ORIGIN',
      });
      return;
    }
  }
  next();
}
