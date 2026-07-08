import { useState } from 'react';
import { AlertTriangle, Bot, Loader2 } from 'lucide-react';
import type { Task } from '../types';
import type { TaskCardController } from '../hooks/useTaskCardController';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { runAgentAction } from '../agentActions';
import { resolveEffectiveAgent } from '../utils';

/**
 * The `swimlane: 'merge-conflict'` rebase CTA (FLUX-986), generalized off its original
 * `PrDeckCard.tsx`-only scoping (FLUX-1270) so a plain, non-PR ticket can render it too — the
 * engine now also sets this swimlane on a ticket whose branch a merge was about to delete out
 * from under a still-open dependent PR (`cleanupMergedBranch`, `pr-cleanup.ts`), not only on a
 * real `gh pr merge` git conflict. Persistent (not hover-gated) so it can't be missed; status is
 * left untouched by the engine until the user actually clicks through here.
 */
export function MergeConflictBanner({ task, c }: { task: Task; c: TaskCardController }) {
  const { triggerRefresh } = useAppActions();
  const currentUser = useAppSelector((s) => s.currentUser);
  const config = useAppSelector((s) => s.config);
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState('');

  if (task.swimlane !== 'merge-conflict') return null;

  const doLaunchRebase = async () => {
    if (c.hasActiveCliSession) {
      setErr(`${task.id} already has an active session running. Wait for it to finish, or stop it first.`);
      return;
    }
    setErr('');
    setLaunching(true);
    const mission =
      `Branch \`${task.branch}\` needs manual attention before it can proceed — either a real git conflict on merge, ` +
      `or its base branch was kept alive because another open PR still depends on it (check the ticket's history for which). ` +
      `Check out the branch (or use the existing worktree), rebase onto \`origin/master\` (or merge master in, or fold ` +
      `onto the branch the history comment names), resolve everything with code judgment, push, and retry.`;
    try {
      const fw = resolveEffectiveAgent(undefined, config?.defaultFramework);
      await runAgentAction({
        taskId: task.id,
        framework: fw,
        action: { kind: 'prompt', appendPrompt: mission, focusComment: mission },
        currentUser,
        phase: 'implementation',
        preStatus: 'In Progress',
      });
      triggerRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to launch rebase session');
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="mb-2 rounded-md border border-rose-300 bg-rose-50 p-2 dark:border-rose-500/30 dark:bg-rose-500/10">
      <p className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
        <AlertTriangle className="h-3.5 w-3.5" /> Branch needs attention
      </p>
      <button
        disabled={launching}
        onClick={doLaunchRebase}
        title="Start an agent session to rebase/resolve and retry"
        className="flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
      >
        {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
        {launching ? 'Launching…' : 'Launch Rebase Session'}
      </button>
      {err && <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>}
    </div>
  );
}
