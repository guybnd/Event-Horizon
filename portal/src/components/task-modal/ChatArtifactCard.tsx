import { useEffect, useState } from 'react';
import { LayoutTemplate, ExternalLink } from 'lucide-react';
import { useAppActions } from '../../store/useAppSelector';
import type { Task } from '../../types';

/**
 * FLUX-887: an inline artifact card surfaced in the CHAT stream (not just the sideview's
 * {@link ArtifactPanel}). When a grooming agent publishes via `publish_artifact`, the user reasons
 * against the chat — so the connection between "the agent proposed this" and "here's the rendered
 * thing" should live there too. This is the lightweight metadata surface (rev #, title, note, byte
 * size, revision count) with an "Open in panel" affordance that focuses the sideview viewer; the
 * heavy sandboxed iframe stays in the sideview (no second opaque-origin frame in the transcript).
 *
 * Live: the metadata refreshes on its own because a publish broadcasts `taskUpdated` → the store's
 * `task.artifacts` pointer updates → this card re-renders with the new revision. We additionally
 * listen for `artifactReady` purely to flash a transient "new" highlight (consistent with the panel
 * jumping to the fresh revision), so a newly published rev visibly surfaces without a manual refresh.
 */

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatArtifactCard({ task, onOpen }: { task: Task; onOpen?: () => void }) {
  const { subscribeToEvent } = useAppActions();
  const revisions = task.artifacts?.revisions ?? [];
  const latest = task.artifacts?.latest ?? (revisions.length > 0 ? revisions[revisions.length - 1]!.rev : 0);
  const current = revisions.find((r) => r.rev === latest) ?? revisions[revisions.length - 1];

  // Transient "just published" highlight. The data itself arrives via `taskUpdated` (store → prop);
  // this only drives the brief accent pulse so a fresh publish is impossible to miss in the stream.
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const off = subscribeToEvent('artifactReady', (data) => {
      const payload = data as { ticketId?: string };
      if (payload?.ticketId !== task.id) return;
      setFresh(true);
    });
    return off;
  }, [subscribeToEvent, task.id]);

  // Clear the highlight after a few seconds; re-arms when `latest` advances (a new revision lands).
  useEffect(() => {
    if (!fresh) return;
    const t = window.setTimeout(() => setFresh(false), 6000);
    return () => window.clearTimeout(t);
  }, [fresh, latest]);

  if (revisions.length === 0 || !current) return null;

  const interactive = !!onOpen;
  const Tag = interactive ? 'button' : 'div';

  return (
    <Tag
      {...(interactive ? { type: 'button' as const, onClick: onOpen } : {})}
      title={interactive ? 'Open this artifact in the ticket panel' : undefined}
      className={`group/artifact flex w-full min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
        fresh
          ? 'border-primary/40 bg-primary/[0.07]'
          : 'border-primary/20 bg-primary/[0.03]'
      } ${interactive ? 'hover:border-primary/40 hover:bg-primary/[0.07]' : ''}`}
    >
      <LayoutTemplate className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary/80" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <span className="font-semibold text-[var(--eh-text-primary)]">
            {current.title || 'Artifact'}
          </span>
          <span className="flex-shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] font-semibold text-primary">
            rev {current.rev}
          </span>
          {fresh && (
            <span role="status" aria-live="polite" className="flex-shrink-0 text-[10px] font-semibold text-emerald-500">
              ✓ new
            </span>
          )}
        </div>
        {current.note && (
          <p className="min-w-0 truncate text-[11px] text-[var(--eh-text-secondary)]">{current.note}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--eh-text-muted)]">
          <span>{formatBytes(current.bytes)}</span>
          {revisions.length > 1 && <span>· {revisions.length} revisions</span>}
        </div>
      </div>
      {interactive && (
        <span className="mt-0.5 flex flex-shrink-0 items-center gap-1 text-[10px] font-semibold text-primary/70 transition-colors group-hover/artifact:text-primary">
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          Open in panel
        </span>
      )}
    </Tag>
  );
}
