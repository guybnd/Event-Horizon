import { useEffect, useState, type ReactNode } from 'react';
import { FloatingPanel } from './FloatingPanel';
import { fetchEnginePerf, type EnginePerfHistogram, type EnginePerfSnapshot } from '../api';
import { snapshot as readClientPerf, type PerfSnapshot } from '../perfClient';

/**
 * FLUX-1134: hidden debug panel — the one place that reads both perf snapshots (engine
 * `GET /api/perf`, FLUX-1129/1130 + client `window.__ehPerf`, FLUX-1133) so a lag episode can be
 * diagnosed without DevTools. Hidden by default (no nav entry): open with `?perf=1` in the URL or
 * the Alt+Shift+P shortcut (works even without the query param, and toggles closed again).
 *
 * Deliberately does NOT subscribe to AppContext/useAppSelector — this is a debug tool measuring
 * app performance, so it must not add re-render load to the thing it measures. It owns a single
 * `setInterval` poll, only while open, and reads `perfClient`'s `snapshot()` directly (a plain
 * function call, not a subscription) on the same tick.
 */

const POLL_MS = 3000;
const SHORTCUT_KEY = 'p';

/** Mirrors the engine/client warn thresholds documented in rest-api.md § Perf — used only to
 *  highlight a hot row here, not to reflect whatever the process's actual env-var overrides are. */
const BREACH_MS = {
  http: 200, // EH_PERF_SLOW_REQ_MS
  eventloop: 150, // EH_PERF_LOOP_STALL_MS
  git: 2000, // EH_PERF_SLOW_GIT_MS (FLUX-1131)
  storeSse: 1000, // EH_PERF_SLOW_RESCAN_MS (FLUX-1132, not yet landed)
  client: 300, // perfClient's own SLOW_DURATION_MS
} as const;

type SectionKey = 'http' | 'eventloop' | 'git' | 'storeSse' | 'other';

/** Buckets a registry key by its documented prefix. `git.`/`gh.` (FLUX-1131) and `store.`/`sse.`
 *  (FLUX-1132) are populated by their respective sinks once installed; until a given one lands
 *  its group is simply empty (rendered as "no data"), and no panel code needs to change once it does. */
function sectionFor(key: string): SectionKey {
  if (key.startsWith('http.')) return 'http';
  if (key.startsWith('eventloop.')) return 'eventloop';
  if (key.startsWith('git.') || key.startsWith('gh.')) return 'git';
  if (key.startsWith('store.') || key.startsWith('sse.')) return 'storeSse';
  return 'other';
}

interface Group {
  counters: Record<string, number>;
  histograms: Record<string, EnginePerfHistogram>;
}

function emptyGroup(): Group {
  return { counters: {}, histograms: {} };
}

function groupSnapshot(s: EnginePerfSnapshot): Record<SectionKey, Group> {
  const groups: Record<SectionKey, Group> = {
    http: emptyGroup(),
    eventloop: emptyGroup(),
    git: emptyGroup(),
    storeSse: emptyGroup(),
    other: emptyGroup(),
  };
  for (const [k, v] of Object.entries(s.counters)) groups[sectionFor(k)].counters[k] = v;
  for (const [k, v] of Object.entries(s.histograms)) groups[sectionFor(k)].histograms[k] = v;
  return groups;
}

function isEmptyGroup(g: Group): boolean {
  return Object.keys(g.counters).length === 0 && Object.keys(g.histograms).length === 0;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${rem}s`;
  return `${rem}s`;
}

function SectionHeader({ title }: { title: string }) {
  return <h4 className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500">{title}</h4>;
}

function HistogramTable({
  histograms,
  thresholdMs,
  stripPrefix,
}: {
  histograms: Record<string, EnginePerfHistogram>;
  thresholdMs?: number;
  stripPrefix?: string;
}) {
  const rows = Object.entries(histograms).sort(([, a], [, b]) => b.p95 - a.p95);
  if (rows.length === 0) return null;
  return (
    <table className="mb-1 w-full border-collapse text-[11px]">
      <thead>
        <tr className="text-gray-400 dark:text-gray-500">
          <th className="text-left font-medium">name</th>
          <th className="pl-2 text-right font-medium">n</th>
          <th className="pl-2 text-right font-medium">p50</th>
          <th className="pl-2 text-right font-medium">p95</th>
          <th className="pl-2 text-right font-medium">max</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, h]) => {
          const breach = thresholdMs != null && h.p95 > thresholdMs;
          const label = stripPrefix && name.startsWith(stripPrefix) ? name.slice(stripPrefix.length) : name;
          return (
            <tr
              key={name}
              className={breach ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-gray-700 dark:text-gray-300'}
            >
              <td className="max-w-[160px] truncate font-mono" title={name}>{label}</td>
              <td className="pl-2 text-right font-mono">{h.count}</td>
              <td className="pl-2 text-right font-mono">{h.p50.toFixed(0)}</td>
              <td className="pl-2 text-right font-mono">{h.p95.toFixed(0)}</td>
              <td className="pl-2 text-right font-mono">{h.max.toFixed(0)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CounterList({ counters, stripPrefix }: { counters: Record<string, number>; stripPrefix?: string }) {
  const rows = Object.entries(counters).sort(([, a], [, b]) => b - a);
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-[11px]">
      {rows.map(([name, count]) => {
        const label = stripPrefix && name.startsWith(stripPrefix) ? name.slice(stripPrefix.length) : name;
        return (
          <li key={name} className="flex items-center justify-between gap-2 text-gray-700 dark:text-gray-300">
            <span className="truncate font-mono" title={name}>{label}</span>
            <span className="font-mono text-gray-500">{count}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  return (
    <div className="mb-3">
      <SectionHeader title={title} />
      {empty ? <p className="text-[11px] italic text-gray-400 dark:text-gray-600">No data yet.</p> : children}
    </div>
  );
}

export function PerfPanel() {
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('perf') === '1';
  });
  const [engine, setEngine] = useState<EnginePerfSnapshot | null>(null);
  const [client, setClient] = useState<PerfSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);

  // The toggle shortcut is always listening (not just while open) so it can open the panel too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === SHORTCUT_KEY) {
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const snap = await fetchEnginePerf();
        if (cancelled) return;
        setEngine(snap);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to fetch /api/perf');
      }
      if (cancelled) return;
      setClient(readClientPerf());
      setLastPolledAt(Date.now());
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  if (!open) return null;

  const groups = engine ? groupSnapshot(engine) : null;

  return (
    <FloatingPanel
      storageKey="eh-perf-panel-geom"
      title="Perf"
      defaultWidth={420}
      defaultHeight={520}
      minimizable
      onClose={() => setOpen(false)}
    >
      <div className="space-y-1 text-xs">
        {error && (
          <div className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </div>
        )}

        {!engine && !error && <p className="text-gray-400">Loading…</p>}

        {engine && groups && (
          <>
            <div className="mb-2 flex items-center justify-between text-[10px] text-gray-400">
              <span>engine up {formatUptime(engine.uptimeSeconds)}</span>
              <span>rss {formatBytes(engine.rss)}</span>
            </div>

            <Section title="HTTP" empty={isEmptyGroup(groups.http)}>
              <HistogramTable histograms={groups.http.histograms} thresholdMs={BREACH_MS.http} stripPrefix="http." />
              <CounterList counters={groups.http.counters} stripPrefix="http." />
            </Section>

            <Section title="Event loop" empty={isEmptyGroup(groups.eventloop)}>
              <HistogramTable
                histograms={groups.eventloop.histograms}
                thresholdMs={BREACH_MS.eventloop}
                stripPrefix="eventloop."
              />
            </Section>

            <Section title="Git" empty={isEmptyGroup(groups.git)}>
              <HistogramTable histograms={groups.git.histograms} thresholdMs={BREACH_MS.git} />
              <CounterList counters={groups.git.counters} />
            </Section>

            <Section title="Store / SSE" empty={isEmptyGroup(groups.storeSse)}>
              <HistogramTable histograms={groups.storeSse.histograms} thresholdMs={BREACH_MS.storeSse} />
              <CounterList counters={groups.storeSse.counters} />
            </Section>

            {!isEmptyGroup(groups.other) && (
              <Section title="Other" empty={false}>
                <HistogramTable histograms={groups.other.histograms} />
                <CounterList counters={groups.other.counters} />
              </Section>
            )}
          </>
        )}

        <div className="mt-2 border-t border-gray-100 pt-2 dark:border-white/10">
          <div className="mb-1 flex items-center justify-between">
            <SectionHeader title="Client" />
            {client && <span className="text-[10px] text-gray-400">tab up {formatUptime(client.uptimeMs / 1000)}</span>}
          </div>
          {client ? (
            <>
              <HistogramTable histograms={client.histograms} thresholdMs={BREACH_MS.client} />
              <CounterList counters={client.counters} />
              {client.slowEvents.length > 0 && (
                <div className="mt-2">
                  <h5 className="mb-0.5 text-[10px] font-semibold text-gray-400">recent slow (&gt;300ms)</h5>
                  <ul className="space-y-0.5 text-[11px]">
                    {client.slowEvents
                      .slice(-5)
                      .reverse()
                      .map((ev) => (
                        <li
                          key={`${ev.name}-${ev.at}`}
                          className="flex items-center justify-between gap-2 text-rose-600 dark:text-rose-400"
                        >
                          <span className="truncate font-mono" title={ev.name}>{ev.name}</span>
                          <span className="font-mono">{ev.ms.toFixed(0)}ms</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="text-[11px] italic text-gray-400 dark:text-gray-600">Loading…</p>
          )}
        </div>

        {lastPolledAt && (
          <p className="mt-2 text-[10px] text-gray-300 dark:text-gray-600">
            updated {new Date(lastPolledAt).toLocaleTimeString()}
          </p>
        )}
      </div>
    </FloatingPanel>
  );
}
