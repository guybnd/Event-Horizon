import { serializeTaskForAgent, type TaskRecord } from './task-store.js';
import { AGENT_BODY_LIMIT } from './task-serialize.js';
import { measureJson } from './payload-measure.js';

export interface PayloadSection {
  name: string;
  bytes: number;
  tokensEst: number;
  pct: number;
}

export interface AgentPayloadMetrics {
  id: string;
  totalBytes: number;
  totalTokensEst: number;
  sections: PayloadSection[];
  historyBreakdown: Array<{ name: string; count: number; bytes: number; tokensEst: number }>;
}

/**
 * Ticket/frontmatter-shaped input. There is no single canonical Task type in
 * this codebase (tickets are runtime-validated, loosely-typed records) — this
 * narrow interface covers only the field this module reads directly (the rest
 * passes through {@link serializeTaskForAgent} untouched).
 */
interface AgentPayloadTask {
  id: string;
  [key: string]: unknown;
}

/** A digested history entry as returned by {@link serializeTaskForAgent} — only the `type` discriminant is read here. */
interface AgentHistoryEntry {
  type?: string;
  [key: string]: unknown;
}

/**
 * Debug-only: measures the agent-facing `get_ticket` payload by section so we can
 * see where an agent's persistent context budget actually goes. Computed off
 * {@link serializeTaskForAgent} (the exact bytes `get_ticket` / `?view=agent`
 * return) but NEVER attached to that payload — only surfaced through the debug
 * endpoint, so measurement never inflates what an agent reads.
 */
export function computeAgentPayloadMetrics(
  task: AgentPayloadTask,
  historyLimit?: number,
  opts: { fullHistory?: boolean } = {},
): AgentPayloadMetrics {
  const { _path, ...payload } = serializeTaskForAgent(task as TaskRecord, historyLimit, opts) as Record<string, unknown>;
  const total = measureJson(payload);

  const history: AgentHistoryEntry[] = Array.isArray(payload.history) ? payload.history : [];
  const sessions = history.filter((e) => e?.type === 'agent_session');
  const comments = history.filter((e) => e?.type === 'comment');
  const otherHistory = history.filter((e) => e?.type !== 'agent_session' && e?.type !== 'comment');

  const sessionsObj = payload.cliSessions ?? payload.cliSession;

  const named = [
    { name: 'body', ...measureJson(payload.body) },
    { name: 'history', ...measureJson(payload.history) },
    { name: 'tags', ...measureJson(payload.tags) },
    { name: 'cliSessions', ...measureJson(sessionsObj) },
  ];

  const accountedBytes = named.reduce((sum, s) => sum + s.bytes, 0);
  const accountedTokens = named.reduce((sum, s) => sum + s.tokensEst, 0);
  const remainderBytes = Math.max(0, total.bytes - accountedBytes);
  const remainderTokens = Math.max(0, total.tokensEst - accountedTokens);

  const pct = (bytes: number) => (total.bytes ? Math.round((bytes / total.bytes) * 1000) / 10 : 0);

  const sections: PayloadSection[] = [
    ...named.map((s) => ({ ...s, pct: pct(s.bytes) })),
    { name: 'frontmatter (other)', bytes: remainderBytes, tokensEst: remainderTokens, pct: pct(remainderBytes) },
  ].sort((a, b) => b.bytes - a.bytes);

  const historyBreakdown = [
    { name: 'agent_session digests', count: sessions.length, ...measureJson(sessions) },
    { name: 'comments', count: comments.length, ...measureJson(comments) },
    { name: 'other (status/activity)', count: otherHistory.length, ...measureJson(otherHistory) },
  ];

  return {
    id: task.id,
    totalBytes: total.bytes,
    totalTokensEst: total.tokensEst,
    sections,
    historyBreakdown,
  };
}

/**
 * FLUX-1512: how much the FLUX-501/503 history digest (summary-collapse + windowing) actually
 * saves for THIS ticket, in the same chars/4 tokensEst unit `computeAgentPayloadMetrics` uses.
 * Compares the real digested payload against an undigested re-serialization of the same
 * in-memory task — both passes are cheap in-process re-serializations, no extra store/file read.
 *
 * `fullHistory:true` alone still WINDOWS to the most recent `historyLimit` entries
 * (digestHistoryForAgent's `cap`) — so a truly undigested measurement also needs `historyLimit`
 * set to (at least) the task's full history length, which is what the second call below does.
 */
export interface DigestSavings {
  undigestedTokensEst: number;
  actualTokensEst: number;
  tokensSaved: number;
  pctSaved: number;
}

export function computeDigestSavings(task: AgentPayloadTask, historyLimit?: number): DigestSavings {
  const actual = computeAgentPayloadMetrics(task, historyLimit);
  const rawHistory = (task as { history?: unknown[] }).history;
  const historyLength = Array.isArray(rawHistory) ? rawHistory.length : 0;
  const undigested = computeAgentPayloadMetrics(task, Math.max(historyLength, 1), { fullHistory: true });
  const tokensSaved = Math.max(0, undigested.totalTokensEst - actual.totalTokensEst);
  const pctSaved = undigested.totalTokensEst ? Math.round((tokensSaved / undigested.totalTokensEst) * 1000) / 10 : 0;
  return { undigestedTokensEst: undigested.totalTokensEst, actualTokensEst: actual.totalTokensEst, tokensSaved, pctSaved };
}

// AGENT_BODY_LIMIT is a char threshold (task-serialize.ts's own truncation cutoff) — convert to
// the same chars/4 tokensEst unit this module measures in, so both flags compare like units.
const BODY_OVERSIZED_TOKENS_THRESHOLD = Math.ceil(AGENT_BODY_LIMIT / 4);
// No existing convention for a "heavy history digest" threshold — documented heuristic, tune later.
export const HISTORY_OVERSIZED_TOKENS_THRESHOLD = 6000;

export interface OversizedFlags {
  bodyOversized: boolean;
  historyOversized: boolean;
}

/** FLUX-1512: cheap post-hoc flags off an already-computed {@link AgentPayloadMetrics} — no
 *  re-serialization — so callers that already have `metrics` (the debug/budget route, the
 *  per-ticket stats/tokens row) can get these for free. */
export function computeOversizedFlags(metrics: AgentPayloadMetrics): OversizedFlags {
  const bodyTokens = metrics.sections.find((s) => s.name === 'body')?.tokensEst ?? 0;
  const historyTokens = metrics.sections.find((s) => s.name === 'history')?.tokensEst ?? 0;
  return {
    bodyOversized: bodyTokens > BODY_OVERSIZED_TOKENS_THRESHOLD,
    historyOversized: historyTokens > HISTORY_OVERSIZED_TOKENS_THRESHOLD,
  };
}
