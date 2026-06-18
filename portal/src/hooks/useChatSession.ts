import { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import {
  startTaskCliSessionEx,
  sendTaskCliInput,
  fetchTaskCliSession,
  fetchTaskTranscript,
  stopTaskCliSession,
  type TranscriptMessage,
} from '../api';

function sameMessages(a: TranscriptMessage[], b: TranscriptMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.role !== b[i]!.role || a[i]!.text !== b[i]!.text) return false;
  }
  return true;
}

export interface UseChatSession {
  /** Transcript messages, with the optimistic pending user turn merged in. */
  messages: TranscriptMessage[];
  busy: boolean;
  error: string | null;
  send: (text: string, opts?: { model?: string; effort?: string; permissionMode?: string }) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * FLUX-602/604: headless chat transport — conversation-scoped, not ticket-scoped.
 *
 * `conversationId` is a ticket id today (the per-ticket chat). The always-on board
 * orchestrator (FLUX-604) will pass a board sentinel once its non-ticket session
 * path exists. Either way the data is the durable transcript (the source of truth,
 * polled while `enabled`); the dumb <ChatView/> renders whatever this returns, so
 * one core serves the modal pane, the board popup, and the orchestrator dock.
 */
export function useChatSession(conversationId: string, enabled = true): UseChatSession {
  const { subscribeToEvent } = useApp();
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);

  // Event-driven transcript sync (FLUX-611): fetch once on open, then refetch only when the
  // engine pushes an event for THIS conversation — no idle polling, so a parked chat (and N
  // of them open at once) costs nothing. The engine streams `activity`/`progress` during a
  // turn (board included — same stdout pipeline) and `taskUpdated` at turn end. The durable
  // transcript is still the source of truth, just fetched on signal instead of on a timer.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const msgs = await fetchTaskTranscript(conversationId);
        // Keep the same array reference when nothing changed — avoids needless
        // re-renders (and the scroll-jank they caused).
        if (!cancelled) setMessages((prev) => (sameMessages(prev, msgs) ? prev : msgs));
      } catch {
        /* transient — keep last good */
      }
    };
    void load();
    const matches = (d: unknown): boolean => {
      const o = d as { taskId?: string; id?: string } | null;
      return !!o && (o.taskId === conversationId || o.id === conversationId);
    };
    const onEvent = (d: unknown) => { if (matches(d)) void load(); };
    const unsubs = [
      subscribeToEvent('activity', onEvent),
      subscribeToEvent('progress', onEvent),
      subscribeToEvent('taskUpdated', onEvent),
    ];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [conversationId, enabled, subscribeToEvent]);

  async function send(text: string, sendOpts?: { model?: string; effort?: string; permissionMode?: string }) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setPendingUser(trimmed);
    try {
      let resumable = false;
      try {
        const current = await fetchTaskCliSession(conversationId);
        resumable = !!current && (current.status === 'running' || current.status === 'waiting-input');
      } catch {
        /* no live session — start a fresh chat */
      }
      if (resumable) {
        await sendTaskCliInput(conversationId, trimmed, 'User', sendOpts);
      } else {
        await startTaskCliSessionEx(conversationId, {
          framework: 'claude',
          phase: 'chat',
          appendPrompt: trimmed,
          skipPermissions: true,
          model: sendOpts?.model || undefined,
          effortOverride: sendOpts?.effort || undefined,
          permissionMode: sendOpts?.permissionMode || undefined,
        });
      }
      // Pull immediately so the just-sent user turn shows without waiting a poll.
      try {
        const fresh = await fetchTaskTranscript(conversationId);
        setMessages((prev) => (sameMessages(prev, fresh) ? prev : fresh));
      } catch { /* poll catches up */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setPendingUser(null);
      setBusy(false);
    }
  }

  // Optimistic pending bubble, unless the transcript already has it.
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastIsPending = !!pendingUser && last?.role === 'user' && last.text === pendingUser;
  const merged: TranscriptMessage[] =
    pendingUser && !lastIsPending ? [...messages, { role: 'user', text: pendingUser, ts: '' }] : messages;

  async function stop() {
    try {
      await stopTaskCliSession(conversationId);
    } catch {
      /* ignore — session may already be done */
    }
  }

  return { messages: merged, busy, error, send, stop };
}
