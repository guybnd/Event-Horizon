import express from 'express';
import { performance } from 'node:perf_hooks';
import { recordDuration } from './registry.js';
import { log } from '../log.js';
import { broadcastEvent } from '../events.js';

const DEFAULT_SLOW_REQ_MS = 200;

/** Long-lived SSE routes — timing/logging these would just record their (huge) open duration. */
const EXCLUDED_PATHS = new Set(['/api/events', '/api/sync-status/stream']);

/** Ticket-id-shaped segment, e.g. `FLUX-123`, `abc-1`. */
const TICKET_ID_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** Bare numeric or UUID segment, e.g. `42`, `9b1d...` (v1-v5 UUID shape). */
const OPAQUE_ID_SEGMENT_RE = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Collapses id-shaped path segments so ad-hoc ids don't blow up histogram cardinality. */
function normalizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => (TICKET_ID_SEGMENT_RE.test(segment) || OPAQUE_ID_SEGMENT_RE.test(segment) ? ':id' : segment))
    .join('/');
}

function routeName(req: express.Request): string {
  if (typeof req.route?.path === 'string') {
    const subPath = req.route.path === '/' ? '' : req.route.path;
    return `${req.baseUrl}${subPath}`;
  }
  return normalizePath(req.path);
}

function slowRequestThresholdMs(): number {
  const raw = Number(process.env.EH_PERF_SLOW_REQ_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_REQ_MS;
}

/**
 * Times every request, records it into the perf registry, and sets a `Server-Timing` response
 * header. `res.on('finish')` fires only after headers have already been flushed, so it can
 * record the duration but can't set the header — the header is set by wrapping `writeHead`
 * (Node's implicit-header flush on `res.end()` calls `this.writeHead(...)`, so this catches
 * both explicit and implicit header sends).
 */
export function requestTiming(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (EXCLUDED_PATHS.has(req.path)) {
    next();
    return;
  }

  const start = performance.now();
  let headerSet = false;
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
    if (!headerSet && !res.headersSent) {
      headerSet = true;
      res.setHeader('Server-Timing', `app;dur=${(performance.now() - start).toFixed(1)}`);
    }
    return originalWriteHead(...args);
  }) as typeof res.writeHead;

  res.on('finish', () => {
    const ms = performance.now() - start;
    const name = routeName(req);
    recordDuration(`http.${req.method} ${name}`, ms);

    const threshold = slowRequestThresholdMs();
    if (ms > threshold) {
      const message = `[perf] slow request: ${req.method} ${name} took ${ms.toFixed(1)}ms (> ${threshold}ms)`;
      log.warn(message);
      broadcastEvent('perf', { kind: 'slow-request', message, valueMs: ms, detail: `${req.method} ${name}` });
    }
  });

  next();
}
