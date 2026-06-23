import { useCallback, useEffect, useState } from 'react';
import { Check, X, Clock, GitPullRequest, GitMerge, Code2, GitCompare, ExternalLink, AlertTriangle, ArrowDown, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAppActions } from '../../store/useAppSelector';
import { fetchPrStatus, raisePr, mergePr, MergeParkedError, openWorktreeWindow, fetchBranchStatus, updatePrBranch, fetchDiffOverview, type PrStatus } from '../../api';

interface Props {
  taskId: string;
  branch?: string;
  /** Open the review launcher for this ticket (agent first-pass review, FLUX-559). */
  onSendForReview?: () => void;
}

/**
 * In-EH PR card (FLUX-558) — shown for branch/worktree tickets near the Ready prompt.
 * Surfaces live PR state (`GET /:id/pr`) with status/checks/review/mergeable chips and the
 * branch-scoped actions: Raise PR (when none), Open worktree in VS Code, View changes, and
 * Merge (squash-merge + advance, routes through review per decision #2). Degrades to nothing
 * when the ticket has no branch or gh is unavailable (pr stays null).
 */
export function PrPanel({ taskId, branch, onSendForReview }: Props) {
  const { triggerRefresh, setChangesFocus, setView } = useAppActions();
  const [pr, setPr] = useState<PrStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'raise' | 'merge' | 'open' | 'update' | null>(null);
  const [error, setError] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [parkedOwners, setParkedOwners] = useState<string[] | null>(null);
  const [behind, setBehind] = useState(0);
  const [collisions, setCollisions] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const status = await fetchPrStatus(taskId).catch(() => null);
    setPr(status);
    // Stale (behind master) + collision radar for the card warnings (FLUX-559).
    fetchBranchStatus(taskId).then((b) => setBehind(b.behindCount || 0)).catch(() => setBehind(0));
    if (branch) {
      fetchDiffOverview()
        .then((o) => {
          const group = o.groups.find((g) => g.branch === branch);
          setCollisions(group ? group.files.filter((f) => f.collidesWith && f.collidesWith.length > 0).length : 0);
        })
        .catch(() => setCollisions(0));
    }
    setLoading(false);
  }, [taskId, branch]);

  useEffect(() => { void load(); }, [load]);

  const run = async (kind: 'raise' | 'merge' | 'open' | 'update', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError('');
    try {
      await fn();
      setParkedOwners(null);
      await load();
      triggerRefresh();
    } catch (err) {
      if (err instanceof MergeParkedError) {
        setParkedOwners(err.parkedOwners);
        setError('');
      } else {
        setParkedOwners(null);
        setError(err instanceof Error ? err.message : 'Action failed');
      }
    } finally {
      setBusy(null);
      setConfirmMerge(false);
    }
  };

  if (!branch) return null;
  // No PR yet (and gh may be unavailable) → offer Raise PR; hide entirely while first loading.
  if (!pr) {
    if (loading) return null;
    return (
      <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4 shadow-sm dark:border-violet-500/30 dark:from-violet-900/15 dark:to-[#1a1b23]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <GitPullRequest className="h-4 w-4 text-violet-500" />
            <span>No open PR for <span className="font-mono text-xs">{branch}</span>.</span>
          </div>
          <button
            disabled={busy === 'raise'}
            onClick={() => void run('raise', () => raisePr(taskId))}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
          >
            <GitPullRequest className="h-4 w-4" />
            {busy === 'raise' ? 'Raising…' : 'Raise PR'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  const isOpen = pr.state === 'OPEN';
  const conflicting = pr.mergeable === 'CONFLICTING';

  return (
    <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-5 shadow-sm dark:border-violet-500/30 dark:from-violet-900/15 dark:to-[#1a1b23]">
      <div className="mb-3 flex items-start gap-3">
        <div className="rounded-xl bg-violet-100 p-2 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300">
          <GitPullRequest className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-violet-600 dark:text-violet-300">Pull request</p>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 flex items-center gap-1.5 text-base font-semibold text-gray-900 hover:underline dark:text-gray-100"
          >
            #{pr.number} {pr.title}
            <ExternalLink className="h-3.5 w-3.5 opacity-60" />
          </a>
          <p className="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">{branch}</p>
        </div>
      </div>

      {/* Status chips */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StateChip state={pr.state} />
        {pr.checks.total > 0 && <ChecksChip checks={pr.checks} />}
        {pr.reviewDecision && <ReviewChip decision={pr.reviewDecision} />}
        {conflicting && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-[11px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">
            <AlertTriangle className="h-3 w-3" /> Conflicts
          </span>
        )}
        {behind > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <ArrowDown className="h-3 w-3" /> {behind} behind
          </span>
        )}
        {collisions > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2.5 py-1 text-[11px] font-semibold text-orange-700 dark:bg-orange-500/15 dark:text-orange-300" title="Files also changed in another worktree/main">
            <AlertTriangle className="h-3 w-3" /> {collisions} collision{collisions > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={busy === 'open'}
          onClick={() => void run('open', async () => {
            const r = await openWorktreeWindow(taskId);
            if (!r.opened) await navigator.clipboard.writeText(r.worktree).catch(() => {});
          })}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
        >
          <Code2 className="h-4 w-4" /> Open worktree
        </button>
        <button
          onClick={() => { setChangesFocus(branch); setView('changes'); }}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
        >
          <GitCompare className="h-4 w-4" /> View changes
        </button>
        {behind > 0 && (
          <button
            disabled={busy === 'update'}
            onClick={() => void run('update', () => updatePrBranch(taskId))}
            className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
          >
            <RefreshCw className="h-4 w-4" /> {busy === 'update' ? 'Updating…' : 'Update branch'}
          </button>
        )}
        {onSendForReview && isOpen && (
          <button
            onClick={onSendForReview}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
          >
            <ShieldCheck className="h-4 w-4" /> Send for review
          </button>
        )}

        <div className="flex-1" />

        {parkedOwners ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              {parkedOwners.length} parked session{parkedOwners.length > 1 ? 's' : ''} will be ended (warm resume lost; committed work safe).
            </span>
            <button
              disabled={busy === 'merge'}
              onClick={() => void run('merge', () => mergePr(taskId, { stopParkedSessions: true }))}
              className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
            >
              <GitMerge className="h-4 w-4" /> {busy === 'merge' ? 'Stopping & merging…' : 'Stop & merge'}
            </button>
            <button
              onClick={() => setParkedOwners(null)}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        ) : confirmMerge ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Squash-merge & advance?</span>
            <button
              disabled={busy === 'merge'}
              onClick={() => void run('merge', () => mergePr(taskId))}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              <GitMerge className="h-4 w-4" /> {busy === 'merge' ? 'Merging…' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirmMerge(false)}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            disabled={!isOpen}
            title={!isOpen ? `PR is ${pr.state.toLowerCase()}` : conflicting ? 'PR has conflicts — merge may fail' : undefined}
            onClick={() => setConfirmMerge(true)}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GitMerge className="h-4 w-4" /> Merge
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const map: Record<string, string> = {
    OPEN: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
    MERGED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    CLOSED: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${map[state] ?? map.CLOSED}`}>{state}</span>;
}

function ChecksChip({ checks }: { checks: PrStatus['checks'] }) {
  const { passed, failed, pending } = checks;
  const tone = failed > 0
    ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
    : pending > 0
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300';
  const Icon = failed > 0 ? X : pending > 0 ? Clock : Check;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
      <Icon className="h-3 w-3" /> {passed}/{checks.total} checks
    </span>
  );
}

function ReviewChip({ decision }: { decision: string }) {
  const map: Record<string, string> = {
    APPROVED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    CHANGES_REQUESTED: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    REVIEW_REQUIRED: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  };
  const label = decision.replace(/_/g, ' ').toLowerCase();
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${map[decision] ?? 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400'}`}>{label}</span>;
}
