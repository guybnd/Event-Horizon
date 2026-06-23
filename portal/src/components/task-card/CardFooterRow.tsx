import { useMemo } from 'react';
import { User, Bot, GitCompare } from 'lucide-react';
import { motion } from 'framer-motion';
import type { Task } from '../../types';
import { CardCommentBadge } from './CardCommentBadge';
import { TokenBadge } from '../TokenBadge';
import { CardChip, CARD_CHIP_BASE, CARD_CHIP_TEXT } from './CardChip';
import { reporterInitials } from './reporterInitials';
import type { TaskCardController } from '../../hooks/useTaskCardController';
import { useAppSelector } from '../../store/useAppSelector';

function useSpeedDemon(task: Task): boolean {
  return useMemo(() => {
    const history = task.history ?? [];
    let inProgressAt: number | undefined;
    let doneAt: number | undefined;
    for (const e of history) {
      if (e.type !== 'status_change') continue;
      const to = (e as { to?: string }).to ?? '';
      const t = new Date(e.date).getTime();
      if (/in.?progress/i.test(to) && !inProgressAt) inProgressAt = t;
      if (/done/i.test(to)) doneAt = t;
    }
    if (!inProgressAt || !doneAt) return false;
    return (doneAt - inProgressAt) < 2 * 60 * 60 * 1000; // < 2 hours
  }, [task.history]);
}

export function CardFooterRow({ task, isOverlay, c }: { task: Task; isOverlay?: boolean; c: TaskCardController }) {
  const boardFx = useAppSelector((s) => s.config?.boardFx);
  const isSpeedDemon = useSpeedDemon(task);
  const {
    tagMenuRef,
    tagAreaHoverTimeout,
    setIsTagAreaActive,
    tagPreviewRowRef,
    tagMenuOpen,
    isTagAreaActive,
    setTagMenuOpen,
    setPriorityMenuOpen,
    setEffortMenuOpen,
    setAssigneeMenuOpen,
    tagNames,
    getTagColor,
    isTagRowOverflowing,
    allTags,
    handleTagToggle,
    config,
    saveConfig,
    diffFocusKey,
    setChangesFocus,
    setView,
    assigneeMenuRef,
    rattleControls,
    hasActiveCliSession,
    visibleAssignee,
    assigneeMenuOpen,
    allUsers,
    handleAssigneeChange,
  } = c;

  // Defensively clean tag lists: drop empty/whitespace-only tags and de-duplicate
  // so React keys derived from the tag string are always non-empty and unique.
  // (task.tags can carry empties/dupes from external/legacy edits; a card showing
  // the same tag twice or a blank chip is itself wrong, so we don't render those.)
  const visibleTags = Array.from(new Set(tagNames.map((t) => t.trim()).filter(Boolean)));
  const menuTags = Array.from(new Set(allTags.map((t) => t.trim()).filter(Boolean)));

  return (
    // Containment contract (FLUX-652): two deterministic aligned rows instead of one flex-wrap row
    // that laddered chips down as the card narrowed. Row 1 = tags (own line). Row 2 = a single
    // non-wrapping meta line (cost · diffs · reporter · assignee · comments) where truncation — not
    // wrapping — absorbs overflow, so the chips stay locked on one baseline. Live agent
    // progress/activity now lives in CardSessionRow.
    <div className="mt-auto flex flex-col gap-2">
      <div
        ref={tagMenuRef}
        className="group/tags relative min-w-0 max-w-full"
        onMouseEnter={() => {
          if (tagAreaHoverTimeout.current !== null) {
            window.clearTimeout(tagAreaHoverTimeout.current);
          }
          tagAreaHoverTimeout.current = window.setTimeout(() => {
            setIsTagAreaActive(true);
            tagAreaHoverTimeout.current = null;
          }, 250);
        }}
        onMouseLeave={() => {
          if (tagAreaHoverTimeout.current !== null) {
            window.clearTimeout(tagAreaHoverTimeout.current);
            tagAreaHoverTimeout.current = null;
          }
          setIsTagAreaActive(false);
        }}
      >
        <div ref={tagPreviewRowRef} className={`flex gap-1.5 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${tagMenuOpen ? 'max-h-28 flex-wrap overflow-y-auto pr-1' : isTagAreaActive ? 'max-h-24 flex-wrap overflow-hidden' : 'max-h-5 flex-nowrap overflow-hidden'}`}>
        {!isOverlay && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              setTagMenuOpen((open) => !open);
              setPriorityMenuOpen(false);
              setEffortMenuOpen(false);
              setAssigneeMenuOpen(false);
            }}
            className={`rounded border border-dashed text-[10px] font-medium text-gray-500 transition-all duration-200 hover:border-primary hover:text-primary dark:text-gray-400 ${visibleTags.length > 0 && !tagMenuOpen ? isTagAreaActive ? 'max-w-24 border-gray-300 px-1.5 py-0.5 opacity-100 dark:border-white/15' : 'max-w-0 overflow-hidden border-transparent px-0 py-0 opacity-0' : 'border-gray-300 px-1.5 py-0.5 dark:border-white/15'}`}
          >
            {visibleTags.length ? 'Edit tags' : 'Add tags'}
          </button>
        )}
        {visibleTags.map(tag => (
          <button
            key={tag}
            onClick={(event) => {
              event.stopPropagation();
              if (!isOverlay) {
                setTagMenuOpen(true);
                setPriorityMenuOpen(false);
                setEffortMenuOpen(false);
                setAssigneeMenuOpen(false);
              }
            }}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getTagColor(tag)}`}
          >
            {tag}
          </button>
        ))}
        </div>
        {!tagMenuOpen && isTagRowOverflowing && (
          <span className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white via-white/90 to-transparent transition-opacity dark:from-[#1e1f2a] dark:via-[#1e1f2a]/90 ${isTagAreaActive ? 'opacity-0' : 'opacity-100'}`} />
        )}
        {tagMenuOpen && !isOverlay && (
          <div
            className="absolute left-0 top-full z-[90] mt-1 min-w-40 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
            onClick={(event) => event.stopPropagation()}
          >
            {menuTags.length ? menuTags.map((tag) => (
              <button
                key={tag}
                onClick={() => void handleTagToggle(tag)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs ${tagNames.includes(tag) ? 'bg-gray-100 text-gray-900 dark:bg-white/10 dark:text-white' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5'}`}
              >
                <span>{tag}</span>
                <span>{tagNames.includes(tag) ? 'On' : 'Off'}</span>
              </button>
            )) : (
              <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">No tags configured</div>
            )}
          </div>
        )}
      </div>

      {/* Meta row: cost · diffs · reporter · assignee · comments on one aligned, non-wrapping line. */}
      <div className="flex min-w-0 items-center gap-2">
      <TokenBadge
        data={task.tokenMetadata}
        config={config}
        variant="card"
        onToggle={config ? () => void saveConfig({ ...config, tokenDisplayMode: config.tokenDisplayMode === 'tokens' ? 'cost' : 'tokens' }) : undefined}
      />

      {boardFx?.speedDemon !== false && isSpeedDemon && (
        <span title="Completed in under 2 hours" className="select-none text-sm leading-none" aria-label="Speed demon">⚡</span>
      )}

      {diffFocusKey && !isOverlay && (
        <button
          onClick={(e) => { e.stopPropagation(); setChangesFocus(diffFocusKey); setView('changes'); }}
          title="View this ticket's diffs in the Changes viewer"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-gray-400 transition-colors hover:bg-primary/10 hover:text-primary"
        >
          <GitCompare className="h-3 w-3" />
          <span>Diffs</span>
        </button>
      )}

      <div ref={assigneeMenuRef} className="relative flex min-w-0 items-center gap-1.5">
        {task.createdBy && (
          <CardChip title={`Reporter: ${task.createdBy}`} className="text-gray-500 dark:text-gray-400">
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[7px] font-bold uppercase leading-none text-white ring-1 ring-white/25"
              style={{ background: 'linear-gradient(135deg, var(--eh-accent), var(--eh-accent-hover))' }}
            >
              {reporterInitials(task.createdBy)}
            </span>
            <span className={`${CARD_CHIP_TEXT} max-w-[72px]`}>{task.createdBy}</span>
          </CardChip>
        )}
        {/* Live agent progress + activity moved to CardSessionRow (FLUX-652) — a bounded full-width
            lane — so this footer cluster stays fixed-size and can't overflow the card. */}
        <motion.button
          animate={rattleControls}
          onClick={(event) => {
            event.stopPropagation();
            if (!isOverlay && !hasActiveCliSession) {
              setAssigneeMenuOpen((open) => !open);
              setPriorityMenuOpen(false);
              setEffortMenuOpen(false);
              setTagMenuOpen(false);
            }
          }}
          className={`${CARD_CHIP_BASE} transition-colors ${hasActiveCliSession ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 bot-assignee-glow cursor-default' : 'bg-gray-100 text-gray-500 dark:bg-black/20 dark:text-gray-400'}`}
        >
          {hasActiveCliSession ? <Bot className="w-3 h-3 shrink-0" /> : <User className="w-3 h-3 shrink-0" />}
          <span className={`${CARD_CHIP_TEXT} max-w-[88px]`}>{hasActiveCliSession && task.cliSession ? task.cliSession.label : visibleAssignee === 'unassigned' ? 'Unassigned' : visibleAssignee}</span>
        </motion.button>
        {assigneeMenuOpen && !isOverlay && !hasActiveCliSession && (
          <div
            className="absolute right-0 top-full z-[90] mt-1 min-w-32 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => void handleAssigneeChange('unassigned')}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
            >
              Unassigned
            </button>
            {allUsers.map((user) => (
              <button
                key={user}
                onClick={() => void handleAssigneeChange(user)}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
              >
                {user}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Comment section — pushed to the far right of the footer (reporter + assignee sit to its
          left). Relocated here from the card's top-right corner so chat can own that spot. */}
      {!isOverlay && (
        <div className="ml-auto flex items-center">
          <CardCommentBadge task={task} c={c} inline />
        </div>
      )}
      </div>
    </div>
  );
}
