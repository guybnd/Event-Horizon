import { useEffect, useRef, useState } from 'react';
import { fetchSessionOutput } from '../api';
import type { CliSessionSummary } from '../types';

export interface SessionOutputState {
  /** Text to render — the tail until the full fetch lands, then the full buffer. */
  text: string;
  loading: boolean;
  /** True once a fetch has 404'd (engine restart — the session record is gone). */
  notAvailable: boolean;
  /** Short caption for `OutputTail`'s notice slot, or undefined when there's nothing to say. */
  notice?: string;
}

/**
 * FLUX-1685: resolves the text a collapsible session row should render for its output tail.
 * Sessions under the truncation cap (active, or terminal but small) carry no `liveOutputChars`
 * and are returned as-is with no fetch. A truncated session fetches its full buffer once, the
 * first time it's expanded — never while collapsed, and never refetched on subsequent expands.
 */
export function useSessionOutput(session: CliSessionSummary, expanded: boolean): SessionOutputState {
  const [full, setFull] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [notAvailable, setNotAvailable] = useState(false);
  const fetchedFor = useRef<string | undefined>(undefined);

  const truncated = session.liveOutputChars != null;

  useEffect(() => {
    if (!expanded || !truncated) return;
    if (fetchedFor.current === session.id) return;
    fetchedFor.current = session.id;
    setLoading(true);
    setNotAvailable(false);
    fetchSessionOutput(session.taskId, session.id)
      .then((output) => setFull(output))
      .catch(() => setNotAvailable(true))
      .finally(() => setLoading(false));
  }, [expanded, truncated, session.taskId, session.id]);

  if (!truncated) {
    return { text: session.liveOutput ?? '', loading: false, notAvailable: false };
  }

  const notice = notAvailable
    ? 'output no longer available (engine restarted)'
    : loading
    ? 'loading full output…'
    : full === undefined
    ? `showing last 2 KB of ${Math.ceil((session.liveOutputChars ?? 0) / 1024)} KB`
    : undefined;

  return { text: full ?? session.liveOutput ?? '', loading, notAvailable, notice };
}
