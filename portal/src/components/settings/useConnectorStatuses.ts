import { useEffect, useState } from 'react';
import { fetchConnectors, triggerConnectorProbe, ehEventSourceUrl } from '../../api';
import type { ConnectorStatus, ProbeResult } from '../../types';

export interface ConnectorStatusesState {
  connectors: ConnectorStatus[];
  loading: boolean;
  /** Re-run one connector's probe, optimistically flipping it to `checking` first. */
  recheck: (id: string) => void;
}

/** FLUX-1656: fetch the connector list once, auto-probe every connector on first load (the
 *  ticket's resolved default — cheap and matches the "instantly caught" intent), then keep every
 *  card's probe result live via the `connector-status` SSE event. Modeled on ModulesSection.tsx's
 *  inline fetch+SSE pattern, factored out since ConnectorsSection has no sibling consumer to share
 *  a single fetch with (unlike useSkillStatus.ts). */
export function useConnectorStatuses(): ConnectorStatusesState {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchConnectors()
      .then((list) => {
        if (cancelled) return;
        setConnectors(list);
        list.forEach((c) => { triggerConnectorProbe(c.id).catch(() => {}); });
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const es = new EventSource(ehEventSourceUrl('/events'));
    es.addEventListener('connector-status', (e: MessageEvent) => {
      const { id, ...probe } = JSON.parse(e.data) as { id: string } & ProbeResult;
      setConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, probe } : c)));
    });
    return () => es.close();
  }, []);

  const recheck = (id: string) => {
    setConnectors((prev) => prev.map((c) => (
      c.id === id ? { ...c, probe: { status: 'checking', message: 'Probing connection…', checkedAt: new Date().toISOString() } } : c
    )));
    triggerConnectorProbe(id).catch(() => {});
  };

  return { connectors, loading, recheck };
}
