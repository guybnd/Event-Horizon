// Per-doc History tab (FLUX-1653) — git IS the revision store, this just surfaces `git log
// --follow` for one doc: hash/author/date/message, an expandable per-commit unified diff, a
// rendered "view this revision", and "Restore this revision" (re-saves the old content through
// the normal doc-save path, producing a NEW commit — never rewrites history).
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, History, RotateCcw, Eye } from 'lucide-react';
import { fetchDocRevisions, fetchDocRevisionDiff, fetchDocRevision, type DocRevision } from '../../api';
import type { Doc } from '../../types';
import { DiffLines } from '../DiffLines';
import { DocMarkdownPreview } from '../DocMarkdownPreview';
import { SkeletonLines } from '../ui/Skeleton';
import { TicketRefChip } from '../TicketRefChip';
import { formatRelative } from '../../lib/relativeTime';

interface DocHistoryPanelProps {
  docPath: string;
  docs: Doc[];
  canRestore: boolean;
  onRestore: (revision: DocRevision, content: Doc) => void;
}

type ExpandedPanel = { hash: string; mode: 'diff' | 'preview' } | null;

export function DocHistoryPanel({ docPath, docs, canRestore, onRestore }: DocHistoryPanelProps) {
  const [revisions, setRevisions] = useState<DocRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedPanel>(null);
  const [panelContent, setPanelContent] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [restoringHash, setRestoringHash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRevisions(null);
    setError(null);
    setExpanded(null);
    fetchDocRevisions(docPath)
      .then((list) => { if (!cancelled) setRevisions(list); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load history'); });
    return () => { cancelled = true; };
  }, [docPath]);

  const togglePanel = (hash: string, mode: 'diff' | 'preview') => {
    if (expanded && expanded.hash === hash && expanded.mode === mode) {
      setExpanded(null);
      return;
    }
    setExpanded({ hash, mode });
    setPanelContent(null);
    setPanelError(null);
    const load = mode === 'diff'
      ? fetchDocRevisionDiff(docPath, hash)
      : fetchDocRevision(docPath, hash).then((doc) => doc.body);
    load
      .then((content) => setPanelContent(content))
      .catch((err) => setPanelError(err instanceof Error ? err.message : 'Failed to load'));
  };

  const handleRestore = async (revision: DocRevision) => {
    setRestoringHash(revision.hash);
    try {
      const content = await fetchDocRevision(docPath, revision.hash);
      onRestore(revision, content);
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Failed to load that revision');
    } finally {
      setRestoringHash(null);
    }
  };

  if (error) {
    return <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">{error}</p>;
  }

  if (revisions === null) {
    return <SkeletonLines count={5} />;
  }

  if (revisions.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500 dark:border-white/10">
        <History className="h-4 w-4 shrink-0" />
        No revision history yet — this doc isn't tracked by git, or it has no commits.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {revisions.map((revision) => {
        const isExpandedDiff = expanded?.hash === revision.hash && expanded.mode === 'diff';
        const isExpandedPreview = expanded?.hash === revision.hash && expanded.mode === 'preview';
        const shortHash = revision.hash.slice(0, 7);
        return (
          <div key={revision.hash} className="rounded-2xl border border-gray-200 bg-white/70 dark:border-white/10 dark:bg-[#181922]/70">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="flex-none rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-white/10 dark:text-gray-400" title={revision.hash}>{shortHash}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-gray-700 dark:text-gray-200" title={revision.message}>{revision.message || '(no message)'}</span>
              {revision.ticketId && <TicketRefChip ticketId={revision.ticketId} />}
              <span className="flex-none text-[10px] text-gray-400" title={revision.date}>
                {revision.author}
                {revision.date && <span className="ml-1 text-gray-400">· {formatRelative(revision.date)}</span>}
              </span>
              <button
                type="button"
                onClick={() => togglePanel(revision.hash, 'diff')}
                className={`flex-none rounded-lg p-1.5 transition-colors ${isExpandedDiff ? 'bg-primary/10 text-primary' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'}`}
                title="View this revision's commit diff"
              >
                {isExpandedDiff ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => togglePanel(revision.hash, 'preview')}
                className={`flex-none rounded-lg p-1.5 transition-colors ${isExpandedPreview ? 'bg-primary/10 text-primary' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'}`}
                title="View this revision rendered"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
              {canRestore && (
                <button
                  type="button"
                  onClick={() => void handleRestore(revision)}
                  disabled={restoringHash === revision.hash}
                  className="flex-none rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-primary disabled:opacity-50 dark:hover:bg-white/5"
                  title="Restore this revision — loads it into the editor as an unsaved draft; Save to commit it as a new revision"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {(isExpandedDiff || isExpandedPreview) && (
              <div className="border-t border-gray-200 px-3 py-2.5 dark:border-white/10">
                {panelError && <p className="text-xs text-red-500">{panelError}</p>}
                {!panelError && panelContent === null && <SkeletonLines count={4} />}
                {!panelError && panelContent !== null && (
                  isExpandedDiff
                    ? <DiffLines content={panelContent} />
                    : <DocMarkdownPreview markdown={panelContent} docs={docs} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
