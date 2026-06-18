import { Bot, SendHorizontal, Play, Undo2, ChevronDown, Layers, FileText } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { TaskCardController } from '../../hooks/useTaskCardController';

export function CardActionButtons({ c }: { c: TaskCardController }) {
  const {
    isReadyForMerge,
    reviewSelectorOpen,
    returnPromptOpen,
    agentMenuOpen,
    finishMenuOpen,
    reviewSelectorRef,
    agentMenuRef,
    launchSingleDefault,
    reviewBusy,
    toggleAgentMenu,
    openLauncherWithTemplate,
    singleDefaultId,
    singleDefaultName,
    multiDefaultId,
    multiDefaultName,
    otherCardTemplates,
    setReturnPromptOpen,
    setReviewSelectorOpen,
    returnBusy,
    finishMenuRef,
    sendFinishCommand,
    finishBusy,
    toggleFinishMenu,
    openFinalizeLauncher,
    finalizeSingleId,
    finalizeSingleName,
    finalizeMultiId,
    finalizeMultiName,
    otherFinalizeTemplates,
    returnReason,
    setReturnReason,
    sendReturn,
    statusAction,
    sendStatusAction,
    actionBusy,
  } = c;

  return (
    <>
      {/* Ready column — Review (split) | Return | Finish */}
      {isReadyForMerge && (
        <div className={`relative flex items-center justify-end gap-1.5 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${reviewSelectorOpen || returnPromptOpen || agentMenuOpen || finishMenuOpen ? 'mt-2 max-h-40 overflow-visible opacity-100' : 'mt-0 max-h-0 overflow-hidden opacity-0 group-hover:mt-2 group-hover:max-h-20 group-hover:overflow-visible group-hover:opacity-100'}`} ref={reviewSelectorRef}>
          {/* Review — split button: single default one-click + menu */}
          <div className="relative flex items-stretch overflow-visible rounded-md" ref={agentMenuRef}>
            <button
              onClick={(e) => void launchSingleDefault(e)}
              disabled={reviewBusy}
              title="Review with the default single agent"
              className="flex items-center gap-1 rounded-l-md border border-gray-200 bg-white/80 px-2 py-1 text-[10px] font-semibold text-gray-600 transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-primary/10"
            >
              <Bot className="w-3 h-3" />
              {reviewBusy ? '…' : 'Review'}
            </button>
            <button
              onClick={toggleAgentMenu}
              disabled={reviewBusy}
              title="Choose a reviewer or template"
              aria-haspopup="menu"
              aria-expanded={agentMenuOpen}
              className="flex items-center rounded-r-md border border-l-0 border-gray-200 bg-white/80 px-1 py-1 text-gray-500 transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-primary/10"
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${agentMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {agentMenuOpen && (
              <div
                className="absolute bottom-full right-0 z-[90] mb-1.5 w-60 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]"
                onClick={(e) => e.stopPropagation()}
                role="menu"
              >
                <p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-gray-400">Review agents</p>
                <button
                  onClick={(e) => { e.stopPropagation(); openLauncherWithTemplate(singleDefaultId); }}
                  disabled={reviewBusy}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-gray-700 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:text-gray-200 dark:hover:bg-primary/10"
                >
                  <Bot className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">Single{singleDefaultName ? ` · ${singleDefaultName}` : ''}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); openLauncherWithTemplate(multiDefaultId); }}
                  disabled={reviewBusy}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-gray-700 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:text-gray-200 dark:hover:bg-primary/10"
                >
                  <Layers className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">Multi{multiDefaultName ? ` · ${multiDefaultName}` : ''}</span>
                </button>
                {otherCardTemplates.length > 0 && (
                  <>
                    <div className="my-1 border-t border-gray-100 dark:border-white/5" />
                    {otherCardTemplates.map((t) => (
                      <button
                        key={t.id}
                        onClick={(e) => { e.stopPropagation(); openLauncherWithTemplate(t.id); }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-gray-600 hover:bg-primary/5 hover:text-primary dark:text-gray-300 dark:hover:bg-primary/10"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{t.name}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          {/* Return */}
          <button
            onClick={(e) => { e.stopPropagation(); setReturnPromptOpen(prev => !prev); setReviewSelectorOpen(false); }}
            disabled={returnBusy}
            className="flex items-center gap-1 rounded-md border border-amber-300 bg-white/80 px-2 py-1 text-[10px] font-semibold text-amber-700 transition-colors hover:border-amber-400 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/35 dark:bg-white/5 dark:text-amber-300 dark:hover:border-amber-400 dark:hover:bg-amber-500/12"
            title="Move ticket back to In Progress"
          >
            <Undo2 className="w-3 h-3" />
            {returnBusy ? '…' : 'Return'}
          </button>
          {/* Finish — split button: one-click finish + menu of finalize templates */}
          <div className="relative flex items-stretch overflow-visible rounded-md" ref={finishMenuRef}>
            <button
              onClick={(e) => void sendFinishCommand(e)}
              disabled={finishBusy}
              title="Finish this ticket (commit + close)"
              className="flex items-center gap-1 rounded-l-md bg-primary px-3 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              <SendHorizontal className="w-3 h-3" />
              {finishBusy ? '…' : 'Finish'}
            </button>
            <button
              onClick={toggleFinishMenu}
              disabled={finishBusy}
              title="Finalize with agents"
              aria-haspopup="menu"
              aria-expanded={finishMenuOpen}
              className="flex items-center rounded-r-md border-l border-white/25 bg-primary px-1 py-1 text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${finishMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {finishMenuOpen && (
              <div
                className="absolute bottom-full right-0 z-[90] mb-1.5 w-60 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]"
                onClick={(e) => e.stopPropagation()}
                role="menu"
              >
                <p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-gray-400">Finalize with agents</p>
                {finalizeSingleId && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openFinalizeLauncher(finalizeSingleId); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-gray-700 hover:bg-primary/5 hover:text-primary dark:text-gray-200 dark:hover:bg-primary/10"
                  >
                    <Bot className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">Single{finalizeSingleName ? ` · ${finalizeSingleName}` : ''}</span>
                  </button>
                )}
                {finalizeMultiId && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openFinalizeLauncher(finalizeMultiId); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-gray-700 hover:bg-primary/5 hover:text-primary dark:text-gray-200 dark:hover:bg-primary/10"
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">Multi{finalizeMultiName ? ` · ${finalizeMultiName}` : ''}</span>
                  </button>
                )}
                {otherFinalizeTemplates.length > 0 && (
                  <>
                    <div className="my-1 border-t border-gray-100 dark:border-white/5" />
                    {otherFinalizeTemplates.map((t) => (
                      <button
                        key={t.id}
                        onClick={(e) => { e.stopPropagation(); openFinalizeLauncher(t.id); }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-gray-600 hover:bg-primary/5 hover:text-primary dark:text-gray-300 dark:hover:bg-primary/10"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{t.name}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          {/* Return reason prompt */}
          {returnPromptOpen && (
            <div
              className="absolute bottom-full right-0 z-[90] mb-1.5 w-64 rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-[10px] font-bold text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Return reason</p>
              <textarea
                autoFocus
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendReturn(e as unknown as ReactMouseEvent); }}
                placeholder="What needs fixing?"
                className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-xs outline-none focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-200"
                rows={3}
              />
              <div className="flex justify-end gap-1.5 mt-2">
                <button
                  onClick={(e) => { e.stopPropagation(); setReturnPromptOpen(false); setReturnReason(''); }}
                  className="rounded-md px-2 py-1 text-[10px] font-semibold text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
                >Cancel</button>
                <button
                  disabled={!returnReason.trim() || returnBusy}
                  onClick={(e) => void sendReturn(e)}
                  className="rounded-md bg-amber-500 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50 hover:bg-amber-600"
                >{returnBusy ? 'Returning…' : 'Return to dev'}</button>
              </div>
            </div>
          )}
        </div>
      )}
      {/* Non-Ready action — split button: primary action + agent launch menu */}
      {!isReadyForMerge && (
        <div className="mt-0 max-h-0 overflow-hidden opacity-0 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:mt-2 group-hover:max-h-12 group-hover:overflow-visible group-hover:opacity-100">
          <div className="relative flex items-center justify-end" ref={agentMenuRef}>
            <div className="flex items-stretch overflow-visible rounded-md">
              {statusAction ? (
                <button
                  onClick={(e) => void sendStatusAction(e)}
                  disabled={actionBusy}
                  className="flex items-center gap-1 rounded-l-md bg-primary px-2.5 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  <Play className="w-2.5 h-2.5" />
                  {actionBusy ? '…' : statusAction.label}
                </button>
              ) : (
                <button
                  onClick={(e) => void launchSingleDefault(e)}
                  disabled={reviewBusy}
                  title="Launch the default single agent for this phase"
                  className="flex items-center gap-1 rounded-l-md bg-primary px-2.5 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  <Bot className="w-3 h-3" />
                  {reviewBusy ? '…' : 'Launch'}
                </button>
              )}
              <button
                onClick={toggleAgentMenu}
                disabled={reviewBusy || actionBusy}
                title="Choose an agent or template"
                aria-haspopup="menu"
                aria-expanded={agentMenuOpen}
                className="flex items-center rounded-r-md border-l border-white/20 bg-primary px-1.5 py-1 text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${agentMenuOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {agentMenuOpen && (
              <div
                className="absolute bottom-full right-0 z-[90] mb-1.5 w-60 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]"
                onClick={(e) => e.stopPropagation()}
                role="menu"
              >
                <p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-gray-400">Launch agents</p>
                <button
                  onClick={(e) => { e.stopPropagation(); openLauncherWithTemplate(singleDefaultId); }}
                  disabled={reviewBusy}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-gray-700 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:text-gray-200 dark:hover:bg-primary/10"
                >
                  <Bot className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">Single{singleDefaultName ? ` · ${singleDefaultName}` : ''}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); openLauncherWithTemplate(multiDefaultId); }}
                  disabled={reviewBusy}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-gray-700 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:text-gray-200 dark:hover:bg-primary/10"
                >
                  <Layers className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">Multi{multiDefaultName ? ` · ${multiDefaultName}` : ''}</span>
                </button>
                {otherCardTemplates.length > 0 && (
                  <>
                    <div className="my-1 border-t border-gray-100 dark:border-white/5" />
                    {otherCardTemplates.map((t) => (
                      <button
                        key={t.id}
                        onClick={(e) => { e.stopPropagation(); openLauncherWithTemplate(t.id); }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-gray-600 hover:bg-primary/5 hover:text-primary dark:text-gray-300 dark:hover:bg-primary/10"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{t.name}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
