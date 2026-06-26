import express from 'express';
import { workspaceRoot } from './workspace.js';

export function requireWorkspace(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!workspaceRoot) {
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
