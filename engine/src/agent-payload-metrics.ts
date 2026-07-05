import { serializeTaskForAgent, type TaskRecord } from './task-store.js';

function measure(value: unknown): { bytes: number; tokensEst: number } {
  if (value === undefined) return { bytes: 0, tokensEst: 0 };
  const json = JSON.stringify(value);
  if (json === undefined) return { bytes: 0, tokensEst: 0 };
  // tokensEst is a rough chars/4 heuristic — good enough to rank sections by
  // relative weight, not an exact tokenizer count.
  return { bytes: Buffer.byteLength(json, 'utf8'), tokensEst: Math.ceil(json.length / 4) };
}

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
export function computeAgentPayloadMetrics(task: AgentPayloadTask, historyLimit?: number): AgentPayloadMetrics {
  const { _path, ...payload } = serializeTaskForAgent(task as TaskRecord, historyLimit) as Record<string, unknown>;
  const total = measure(payload);

  const history: AgentHistoryEntry[] = Array.isArray(payload.history) ? payload.history : [];
  const sessions = history.filter((e) => e?.type === 'agent_session');
  const comments = history.filter((e) => e?.type === 'comment');
  const otherHistory = history.filter((e) => e?.type !== 'agent_session' && e?.type !== 'comment');

  const sessionsObj = payload.cliSessions ?? payload.cliSession;

  const named = [
    { name: 'body', ...measure(payload.body) },
    { name: 'history', ...measure(payload.history) },
    { name: 'tags', ...measure(payload.tags) },
    { name: 'cliSessions', ...measure(sessionsObj) },
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
    { name: 'agent_session digests', count: sessions.length, ...measure(sessions) },
    { name: 'comments', count: comments.length, ...measure(comments) },
    { name: 'other (status/activity)', count: otherHistory.length, ...measure(otherHistory) },
  ];

  return {
    id: task.id,
    totalBytes: total.bytes,
    totalTokensEst: total.tokensEst,
    sections,
    historyBreakdown,
  };
}
