// S9 (epic FLUX-996): structured operation telemetry. Every git/gh/spawn/handshake operation
// emits ONE completed OperationEvent (start+end folded together, mirroring git-exec.ts's own
// `emit()` shape) — never a separate "pending" entry — so a crash mid-flight simply never
// produces an event instead of leaving an unbounded-lifetime placeholder in the buffer.
//
// This is the S1 stub's real sink (git-exec.ts's `setGitOperationSink`, installed once by
// `installOperationTelemetry()`), plus net-new instrumentation call sites for agent spawn
// (claude-code.ts) and the Serena/MCP shared-server handshake (shared-mcp-server.ts).
//
// MCP-safe: this module NEVER writes to process.stdout — telemetry only ever reaches the
// in-memory ring buffer and the existing SSE broadcast channel (events.ts).

import { randomUUID } from 'node:crypto';
import { broadcastEvent } from './events.js';
import { setGitOperationSink, type GitOperationEvent } from './git-exec.js';

export type OperationKind = 'git' | 'gh' | 'spawn' | 'handshake';
export type OperationOutcome = 'ok' | 'timeout' | 'error' | 'aborted';

export interface OperationEvent {
  opId: string;
  kind: OperationKind;
  ticketId?: string | undefined;
  sessionId?: string | undefined;
  cmd: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  outcome: OperationOutcome;
  reason?: string | undefined;
}

// Fixed-capacity ring buffer, FIFO eviction, in-memory only (no persistence across restart) —
// this is telemetry, not an audit log. No existing bounded-buffer helper in engine/src to reuse.
const BUFFER_CAPACITY = 500;
const buffer: OperationEvent[] = [];

/**
 * Record one completed operation. Assigns `opId` and pushes onto the bounded buffer + SSE
 * broadcast. Defensive like git-exec's own `emit()`: a broadcast failure must never break the
 * underlying git/spawn/handshake call that already completed.
 */
export function emitOperationEvent(event: Omit<OperationEvent, 'opId'>): void {
  const full: OperationEvent = { ...event, opId: randomUUID() };
  buffer.push(full);
  if (buffer.length > BUFFER_CAPACITY) buffer.shift();
  try {
    broadcastEvent('operation', full);
  } catch {
    /* a broken telemetry broadcast must never break the underlying operation */
  }
}

export interface OperationQuery {
  ticketId?: string | undefined;
  sessionId?: string | undefined;
  kind?: OperationKind | undefined;
  outcome?: OperationOutcome | undefined;
  limit?: number | undefined;
}

/** Recent events, newest-first, honoring the optional filters. `limit` defaults to 100. */
export function getRecentOperations(query: OperationQuery = {}): OperationEvent[] {
  const { ticketId, sessionId, kind, outcome } = query;
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, BUFFER_CAPACITY) : 100;
  const result: OperationEvent[] = [];
  for (let i = buffer.length - 1; i >= 0 && result.length < limit; i--) {
    const e = buffer[i]!;
    if (ticketId && e.ticketId !== ticketId) continue;
    if (sessionId && e.sessionId !== sessionId) continue;
    if (kind && e.kind !== kind) continue;
    if (outcome && e.outcome !== outcome) continue;
    result.push(e);
  }
  return result;
}

// Exposed for tests only (verifying eviction never leaks memory beyond capacity).
export function _getBufferLengthForTests(): number {
  return buffer.length;
}

let installed = false;

/**
 * Install the real git-exec telemetry sink. Intended to be called once at bootstrap, but
 * idempotent — a second call is a no-op — matching perf/git-timing.ts's startGitTiming(), since
 * `setGitOperationSink` is a multicast (FLUX-1131): without this guard a second call would add a
 * second sink instance and double every emitted OperationEvent (FLUX-1164). `GitOperationEvent`'s
 * `outcome`/`file` already line up 1:1 with `OperationOutcome`/`'git'|'gh'` — no mapping needed.
 * git/gh events carry no ticketId/sessionId: `GitExecOptions` doesn't thread caller context today
 * and is a shared surface used by 6+ call sites (FLUX-996/997/998) — deliberately not extended here
 * (scope cut, see FLUX-1005).
 */
export function installOperationTelemetry(): void {
  if (installed) return;
  installed = true;
  setGitOperationSink((e: GitOperationEvent) => {
    emitOperationEvent({
      kind: e.file,
      cmd: `${e.file} ${e.args.join(' ')}`,
      startedAt: e.startedAt,
      endedAt: e.startedAt + e.durationMs,
      durationMs: e.durationMs,
      outcome: e.outcome,
      reason: e.reason,
    });
  });
}

/**
 * Test-only teardown: resets the installed guard and clears every sink (`setGitOperationSink(null)`
 * is a blunt "clear every sink" reset — see git-exec.ts), safe here only because tests don't also
 * have perf/git-timing's sink installed in the same module registry. Never called from production
 * code.
 */
export function stopOperationTelemetry(): void {
  if (!installed) return;
  installed = false;
  setGitOperationSink(null);
}
