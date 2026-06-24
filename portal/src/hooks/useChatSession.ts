import { useEffect, useRef, useState } from 'react';
import { useAppActions } from '../store/useAppSelector';
import {
  startTaskCliSessionEx,
  sendTaskCliInput,
  fetchTaskCliSession,
  fetchTaskTranscript,
  stopTaskCliSession,
  clearTaskTranscript,
  type TranscriptMessage,
  type ChatAttachment,
} from '../api';
import { uploadChatImage } from '../taskAssetUploads';
import { getTranscript, hasTranscript, setTranscript } from '../transcriptCache';

/** FLUX-674: per-turn send options, including pasted-image attachments. */
export interface ChatSendOptions {
  model?: string;
  effort?: string;
  permissionMode?: string;
  attachments?: ChatAttachment[];
}

/** FLUX-748: a message the user submitted while the agent was mid-turn, parked to auto-send
 *  the moment the turn finishes. `id` is a stable client key for the queued-indicator list. */
export interface QueuedMessage {
  id: string;
  text: string;
  opts: ChatSendOptions;
}

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
  send: (text: string, opts?: ChatSendOptions) => Promise<void>;
  /**
   * FLUX-748: messages submitted while the agent was mid-turn, awaiting auto-dispatch (FIFO,
   * one per turn). Empty when the session is idle / nothing is queued.
   */
  queued: QueuedMessage[];
  /** FLUX-748: park a message to auto-send when the current turn finishes. No-op if empty. */
  enqueue: (text: string, opts?: ChatSendOptions) => void;
  /** FLUX-748: remove a still-queued message (by id) before it dispatches. */
  dequeue: (id: string) => void;
  /** FLUX-748: drop every queued message. */
  clearQueued: () => void;
  stop: () => Promise<void>;
  /** Stop any live session and wipe the durable transcript — a fresh start (orchestrator reset). */
  reset: () => Promise<void>;
  /** FLUX-674: upload one pasted/dropped image for this conversation, returning its ref. */
  uploadImage: (file: File) => Promise<ChatAttachment>;
  /**
   * FLUX-691: in-progress assistant text streamed token-by-token for the *current* turn, accrued
   * from `assistantDelta` SSE events. Non-empty only while a turn is mid-stream; cleared the moment
   * the committed message lands in the durable transcript (so the final, markdown-rendered message
   * replaces it with no duplicate). The consumer renders this as a cheap plain-text live node.
   */
  liveText: string;
  /**
   * FLUX-750: true only during a genuine **cold** open — a conversation never loaded this session
   * (or evicted from the transcript LRU) whose transcript is being fetched for the first time, with
   * nothing cached to show. A reopen with a cache hit hydrates synchronously, so `loading` is false
   * and the consumer renders the cached transcript at once (no blank flash). Flips false the moment
   * the first fetch resolves. The consumer shows a skeleton/spinner instead of a blank pane.
   */
  loading: boolean;
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
export function useChatSession(conversationId: string, enabled = true, working = false): UseChatSession {
  const { subscribeToEvent } = useAppActions();
  // FLUX-750: lazy-hydrate from the module-level transcript cache so a reopened (previously
  // minimized) chat renders its history synchronously on mount — no blank flash, no cold re-fetch
  // pop. A cache miss seeds [] and flags `loading` for the cold-open spinner. The initializer runs
  // once; a conversationId switch on a reused hook re-seeds via the effect below.
  const [messages, setMessages] = useState<TranscriptMessage[]>(() => getTranscript(conversationId) ?? []);
  // True only on a genuine cold open (enabled + nothing cached). Cleared when the first fetch resolves.
  const [loading, setLoading] = useState(() => enabled && !hasTranscript(conversationId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // FLUX-748: client-side message queue. `working` (the live `running` session, owned by the
  // caller) is the dispatch gate; `busy` is this hook's own in-flight POST flag. A monotonic
  // ref supplies stable list keys without Date.now()/Math.random().
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const queueIdRef = useRef(0);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  // FLUX-691: token-by-token live stream for the current turn (see `liveText` in UseChatSession).
  const [liveText, setLiveText] = useState('');
  // Mirror of `messages` so the event-driven `load()` can tell a real transcript change (the turn
  // committed) from a no-op refetch (mid-turn activity/progress tick) without a stale closure.
  const messagesRef = useRef<TranscriptMessage[]>(getTranscript(conversationId) ?? []);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // FLUX-750: re-seed on a conversationId switch within a reused hook instance. The lazy `useState`
  // initializers above run only once, so without this a hook reused for a different id would keep
  // showing the previous conversation's messages until the next fetch lands. Guarded on a real id
  // change (skips the initial mount, already handled by the lazy init) so it never clobbers state.
  const seededIdRef = useRef(conversationId);
  useEffect(() => {
    if (seededIdRef.current === conversationId) return;
    seededIdRef.current = conversationId;
    const cached = getTranscript(conversationId) ?? [];
    messagesRef.current = cached;
    setMessages(cached);
    setLoading(enabled && !hasTranscript(conversationId));
    setLiveText('');
  }, [conversationId, enabled]);

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
        if (cancelled) return;
        // FLUX-750: cold-open fetch resolved — drop the spinner. Write through to the transcript
        // cache (the freshest copy + marks this conversation warm) on every successful fetch, even
        // when unchanged, so an empty/idle conversation still hydrates instantly on its next reopen.
        setLoading(false);
        setTranscript(conversationId, msgs);
        // Keep the same array reference when nothing changed — avoids needless re-renders
        // (and the scroll-jank they caused).
        if (sameMessages(messagesRef.current, msgs)) return;
        messagesRef.current = msgs;
        setMessages(msgs);
        // FLUX-691: the committed turn just landed in the durable transcript — drop the live
        // streaming node so the final (markdown-rendered, memoized) message replaces it with no
        // duplicate. Gated on a *real* change: mid-turn activity/progress refetches return the
        // same transcript while text is still streaming, so they never clear/flicker the node.
        setLiveText('');
      } catch {
        // Transient — keep last good. Clear the spinner so a failed cold fetch falls back to the
        // empty hint rather than hanging on a spinner until the next event.
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const matches = (d: unknown): boolean => {
      const o = d as { taskId?: string; id?: string } | null;
      return !!o && (o.taskId === conversationId || o.id === conversationId);
    };
    const onEvent = (d: unknown) => { if (matches(d)) void load(); };
    // FLUX-691: accrue token-by-token deltas for THIS conversation into the live node.
    const onDelta = (d: unknown) => {
      const o = d as { taskId?: string; text?: string } | null;
      if (o && o.taskId === conversationId && typeof o.text === 'string' && o.text) {
        setLiveText((prev) => prev + o.text);
      }
    };
    const unsubs = [
      subscribeToEvent('activity', onEvent),
      subscribeToEvent('progress', onEvent),
      subscribeToEvent('taskUpdated', onEvent),
      subscribeToEvent('assistantDelta', onDelta),
    ];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [conversationId, enabled, subscribeToEvent]);

  async function send(text: string, sendOpts?: ChatSendOptions) {
    const trimmed = text.trim();
    const attachments = sendOpts?.attachments ?? [];
    // FLUX-674: allow an image-only turn (no text) as long as something is attached.
    if ((!trimmed && attachments.length === 0) || busy) return;
    setBusy(true);
    setError(null);
    setLiveText(''); // FLUX-691: fresh turn — drop any live node left over from a prior turn.
    setPendingUser(trimmed);
    setPendingAttachments(attachments);
    try {
      let resumable = false;
      try {
        const current = await fetchTaskCliSession(conversationId);
        // FLUX-606: resume the most-recent session whenever the engine says it's resumable
        // (terminal-or-active with a claudeSessionId) — this continues a dispatched grooming
        // session's thread instead of spawning a fresh, amnesiac chat. `completed` is now
        // included via the engine's `resumable` flag, not just running/waiting-input.
        resumable = !!current?.resumable;
      } catch {
        /* no live session — start a fresh chat */
      }
      const startFresh = () =>
        startTaskCliSessionEx(conversationId, {
          framework: 'claude',
          phase: 'chat',
          appendPrompt: trimmed,
          skipPermissions: true,
          model: sendOpts?.model || undefined,
          effortOverride: sendOpts?.effort || undefined,
          permissionMode: sendOpts?.permissionMode || undefined,
          attachments: attachments.length ? attachments : undefined,
        });
      if (resumable) {
        // The engine refuses to resume when the worktree is gone (finished ticket). That's an
        // expected fallback, not an error — fall back to a fresh chat. A genuine failure of the
        // fresh start still propagates to the catch below and surfaces via setError.
        try {
          await sendTaskCliInput(conversationId, trimmed, 'User', { ...sendOpts, attachments });
        } catch {
          await startFresh();
        }
      } else {
        await startFresh();
      }
      // Pull immediately so the just-sent user turn shows without waiting a poll.
      try {
        const fresh = await fetchTaskTranscript(conversationId);
        setMessages((prev) => (sameMessages(prev, fresh) ? prev : fresh));
        setTranscript(conversationId, fresh); // FLUX-750: write-through keeps the cache fresh.
      } catch { /* poll catches up */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setPendingUser(null);
      setPendingAttachments([]);
      setBusy(false);
    }
  }

  /** FLUX-748: park a message to auto-send once the current turn finishes. */
  function enqueue(text: string, opts?: ChatSendOptions) {
    const trimmed = text.trim();
    const attachments = opts?.attachments ?? [];
    if (!trimmed && attachments.length === 0) return;
    setQueued((q) => [...q, { id: `q${queueIdRef.current++}`, text: trimmed, opts: opts ?? {} }]);
  }

  function dequeue(id: string) {
    setQueued((q) => q.filter((m) => m.id !== id));
  }

  function clearQueued() {
    setQueued([]);
  }

  // FLUX-748: auto-dispatch the head of the queue on the `working` true→false edge — the moment
  // the live turn finishes. Edge-triggered (not a steady-state `!working && !busy` check) on
  // purpose: `busy` resets when our POST returns (~1s), well BEFORE the engine flips the session
  // to `running` (the FLUX-714 race), so a steady-state gate would fire the next queued message
  // into that gap and double-dispatch. Waiting for the genuine turn-completion edge serializes
  // FIFO — one message per turn — because each dispatched send drives `working` true→false again.
  const prevWorkingRef = useRef(working);
  useEffect(() => {
    const wasWorking = prevWorkingRef.current;
    prevWorkingRef.current = working;
    if (wasWorking && !working && !busy && queued.length > 0) {
      const [head, ...rest] = queued;
      setQueued(rest);
      void send(head!.text, head!.opts);
    }
    // `send` is intentionally omitted — it's re-created each render and the edge guard above
    // (plus `busy` in deps) keeps the captured closure fresh enough; listing it would only add
    // render-churn without changing behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, busy, queued]);

  /** FLUX-674: upload a pasted/dropped image to this ticket's asset sidecar. */
  async function uploadImage(file: File): Promise<ChatAttachment> {
    return uploadChatImage(conversationId, file);
  }

  // Optimistic pending bubble, unless the transcript already has it.
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastIsPending = pendingUser !== null && last?.role === 'user' && last.text === pendingUser;
  const merged: TranscriptMessage[] =
    pendingUser !== null && !lastIsPending
      ? [...messages, { role: 'user', text: pendingUser, ts: '', attachments: pendingAttachments.length ? pendingAttachments : undefined }]
      : messages;

  async function stop() {
    try {
      await stopTaskCliSession(conversationId);
    } catch {
      /* ignore — session may already be done */
    }
  }

  // Reset = stop the live turn (if any) then clear the transcript, so the conversation starts
  // empty. We optimistically clear locally; the engine also broadcasts `taskUpdated`, which
  // refetches and confirms the empty transcript.
  async function reset() {
    setError(null);
    try {
      await stopTaskCliSession(conversationId);
    } catch {
      /* no live session — nothing to stop */
    }
    try {
      await clearTaskTranscript(conversationId);
      setMessages([]);
      setTranscript(conversationId, []); // FLUX-750: reflect the cleared transcript in the cache.
      setLiveText('');
      setPendingUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset conversation');
    }
  }

  return { messages: merged, busy, error, send, queued, enqueue, dequeue, clearQueued, stop, reset, uploadImage, liveText, loading };
}
