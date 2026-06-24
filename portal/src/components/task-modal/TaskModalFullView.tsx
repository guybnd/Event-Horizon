import type { ComponentProps, ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  MessageSquare,
  Save,
  Square,
  X,
} from 'lucide-react';
import { StatusBadge } from '../StatusBadge';
import { getStatusColorClass } from '../../statusStyles';
import { TaskDescriptionSurface } from '../TaskDescriptionSurface';
import { TokenBadge } from '../TokenBadge';
import { MetadataPanel } from './MetadataPanel';
import { RetryBanner } from './RetryBanner';
import { PrPanel } from './PrPanel';
import { DiffViewer } from './DiffViewer';
import { CommentBox } from './CommentBox';
import { HistoryList } from './HistoryList';
import { PayloadSizePanel } from './PayloadSizePanel';
import { ChatPane } from './ChatPane';
import { getPriorityIcon } from './taskModalHelpers';
import { TicketActions } from '../ticket-actions/TicketActions';
import type { TaskModalController } from '../../hooks/useTaskModalController';
import type { Task } from '../../types';

interface TaskModalFullViewProps {
  c: TaskModalController;
  Container: typeof motion.div | 'div';
  layoutProps: Record<string, unknown>;
  contentAnimation: Record<string, unknown>;
  metadataPanelProps: ComponentProps<typeof MetadataPanel>;
  historyListProps: ComponentProps<typeof HistoryList>;
  commentBoxProps: ComponentProps<typeof CommentBox>;
  requireInputPrompt: ReactNode;
  readyForMergePrompt: ReactNode;
  subtasksPanel: ReactNode;
  detailsPanel: ReactNode;
  activityFilterTabs: ReactNode;
}

export function TaskModalFullView({
  c,
  Container,
  layoutProps,
  contentAnimation,
  metadataPanelProps,
  historyListProps,
  commentBoxProps,
  requireInputPrompt,
  readyForMergePrompt,
  subtasksPanel,
  detailsPanel,
  activityFilterTabs,
}: TaskModalFullViewProps) {
  const {
    config,
    modalTask,
    saveError,
    status,
    title,
    setTitle,
    titleRef,
    saving,
    isDirty,
    handleSave,
    saveConfig,
    sessionIsActive,
    cliSession,
    cliSessionBusy,
    stopSession,
    openLauncher,
    handleCloseAttempt,
    isTaskLoading,
    sidebarWidth,
    isFullView,
    isPromptStatus,
    promptModalRef,
    isPromptModalOpen,
    setIsPromptModalOpen,
    isRequireInput,
    requireInputBanner,
    groomingBanner,
    diffViewFile,
    setDiffViewFile,
    body,
    setBody,
    commentSectionRef,
    isCommentBoxVisible,
    setIsCommentBoxVisible,
    commentBoxRef,
    setIsDraggingSidebar,
    priority,
  } = c;

  return (
    <Container
      key="modal-content-full"
      {...layoutProps}
      className="pointer-events-auto fixed inset-3 z-[60] flex flex-col overflow-hidden rounded-2xl border eh-border shadow-2xl eh-surface-overlay"
    >
      <motion.div {...contentAnimation} className="flex h-full w-full flex-col overflow-hidden">
      {saveError && (
        <div className="bg-red-500/10 text-red-600 dark:text-red-400 px-5 py-3 text-sm font-medium border-b border-red-500/20 text-center flex items-center justify-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {saveError}
        </div>
      )}
      <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-5 py-4 dark:border-white/5 dark:bg-black/20">
        <div className="flex min-w-0 flex-1 items-center gap-4 mr-4">
          <button
            onClick={handleCloseAttempt}
            className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Board
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{modalTask?.id || 'New Task'}</p>
              <StatusBadge
                status={status}
                colorClass={getStatusColorClass(config, status)}
                className="text-[10px] font-bold uppercase tracking-[0.16em]"
              />
            </div>
            <textarea
              ref={titleRef}
              rows={1}
              className="mt-1 w-full resize-none overflow-hidden bg-transparent text-lg font-semibold text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                event.target.style.height = 'auto';
                event.target.style.height = event.target.scrollHeight + 'px';
              }}
              placeholder="Task title..."
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            disabled={saving || !isDirty}
            onClick={() => handleSave(undefined, true)}
            className={`flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold shadow-sm ${
              isDirty
                ? 'cursor-pointer bg-primary text-white shadow-primary/20 hover:bg-primary-hover'
                : 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/10'
            }`}
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save'}
          </button>
          {modalTask && (
            <TokenBadge
              data={modalTask.tokenMetadata}
              config={config}
              variant="modal"
              onToggle={config ? () => void saveConfig({ ...config, tokenDisplayMode: config.tokenDisplayMode === 'tokens' ? 'cost' : 'tokens' }) : undefined}
            />
          )}
          {modalTask?.id && (() => {
            if (sessionIsActive && cliSession) {
              const statusColor = cliSession.status === 'running' ? 'bg-green-500' : cliSession.status === 'waiting-input' ? 'bg-amber-500' : 'bg-gray-400';
              return (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200">
                    <span className={`h-2 w-2 rounded-full ${statusColor} animate-pulse`} />
                    Agent {cliSession.status}
                  </span>
                  <button
                    type="button"
                    disabled={cliSessionBusy}
                    onClick={() => void stopSession()}
                    className="flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                  >
                    <Square className="h-3 w-3" />
                    Stop
                  </button>
                </div>
              );
            }
            // FLUX-717: the full-view modal launch surface renders the unified registry controls,
            // so it offers the same status-aware actions (launch + transitions + PR link) as the
            // board card and chat — instead of a single "Launch Agent" button.
            return <TicketActions task={modalTask as Task} variant="compact" />;
          })()}
          <button onClick={handleCloseAttempt} className="rounded p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {isTaskLoading && !modalTask?.body && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 animate-pulse">
          <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-white/10" />
          <div className="h-4 w-2/3 rounded bg-gray-200 dark:bg-white/10" />
          <div className="h-4 w-1/2 rounded bg-gray-200 dark:bg-white/10" />
          <div className="h-4 w-3/4 rounded bg-gray-200 dark:bg-white/10" />
        </div>
      )}

      <div className="grid min-h-0 flex-1 relative" style={{ gridTemplateColumns: `minmax(0,1fr) ${sidebarWidth}px`, display: isTaskLoading && !modalTask?.body ? 'none' : undefined }}>
        {isFullView && isPromptStatus && (
          <>
            <div
              ref={promptModalRef}
              className={`absolute top-6 left-6 z-50 rounded-2xl bg-white/95 backdrop-blur-md shadow-2xl dark:bg-[#1a1b23]/95 border border-amber-200 dark:border-amber-500/30 transition-all duration-300 origin-top-right ${isPromptModalOpen ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto' : 'opacity-0 scale-50 -translate-y-4 pointer-events-none'}`}
              style={{ right: `${sidebarWidth + 24}px` }}
            >
              <div className="flex justify-between items-center border-b border-gray-100 px-4 py-2 dark:border-white/5">
                <span className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">Prompt Active</span>
                <button onClick={() => setIsPromptModalOpen(false)} className="p-1 hover:bg-gray-100 rounded dark:hover:bg-white/10 text-gray-500 transition-colors">
                  <X className="w-4 h-4"/>
                </button>
              </div>
              <div className="p-2 max-h-[80vh] overflow-y-auto">
                {isRequireInput ? requireInputPrompt : readyForMergePrompt}
              </div>
            </div>
            <div
              className={`absolute top-6 z-40 transition-all duration-300 pointer-events-auto ${!isPromptModalOpen ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none'}`}
              style={{ right: `${sidebarWidth + 24}px` }}
            >
              <button
                onClick={() => setIsPromptModalOpen(true)}
                className="relative flex items-center justify-center p-[2px] overflow-hidden rounded-full shadow-lg hover:scale-105 transition-transform"
              >
                <span className="absolute top-1/2 left-1/2 block aspect-square w-[300px] -translate-x-1/2 -translate-y-1/2 animate-[spin_2s_linear_infinite] bg-[conic-gradient(from_0deg,transparent_0_340deg,rgba(255,255,255,0.8)_360deg)]" style={{ willChange: 'transform' }}></span>
                <div className="relative flex items-center gap-2 bg-amber-500 text-white px-4 py-2 rounded-full font-bold hover:bg-amber-600 transition-colors w-full h-full">
                  <MessageSquare className="w-4 h-4" />
                  Prompt Pending
                </div>
              </button>
            </div>
          </>
        )}

        <div className="min-h-0 border-r border-gray-200 dark:border-white/10 overflow-y-auto relative">
          <div className="flex flex-col min-h-full">
            {(requireInputBanner || groomingBanner) && (
              <div className="border-b border-gray-200 p-6 dark:border-white/10">
                {requireInputBanner}
                {groomingBanner}
              </div>
            )}
            {modalTask && <RetryBanner task={modalTask} className="mx-6 mt-4" />}
            {/* PR ticket surface (FLUX-593): the full view is the default modal, so a PR ticket
                opened here needs its PR panel (diff/status/merge/update-branch) — not the normal
                ticket finish prompt (suppressed via isReadyForMerge excluding kind:'pr'). */}
            {modalTask?.id && modalTask.branch && modalTask.kind === 'pr' && (
              <div className="border-b border-gray-200 p-6 dark:border-white/10">
                <PrPanel taskId={modalTask.id} branch={modalTask.branch} onSendForReview={() => openLauncher('review')} />
              </div>
            )}
            <div className="flex-1 flex flex-col border-b border-gray-200 dark:border-white/10">
              {diffViewFile && modalTask?.id ? (
                <DiffViewer taskId={modalTask.id} file={diffViewFile} onBack={() => setDiffViewFile(null)} />
              ) : (
                <>
              <div className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Description</p>
                  <p className="text-sm text-gray-500">Rendered markdown by default, editable in place.</p>
                </div>
              </div>
              <div className="flex-1 px-6 pb-6 min-h-[200px]">
                <TaskDescriptionSurface
                  key={`${modalTask?.id || 'new-task'}-full`}
                  value={body}
                  onChange={setBody}
                  taskId={modalTask?.id}
                  mode="full"
                  emptyMessage="No description yet."
                />
              </div>
                </>
              )}
            </div>

            {modalTask?.id && (
              <div className="px-6 py-4">
                <ChatPane task={modalTask as Task} />
              </div>
            )}

            <div ref={commentSectionRef} className="px-6 py-4 flex flex-col relative pb-8">
              <div className="flex items-center justify-between gap-4 mb-4">
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Activity & Comments</p>
                {activityFilterTabs}
              </div>
              <div className="flex-1 mb-8"><HistoryList {...historyListProps} /></div>
              {(!isRequireInput) && (
                <div className="sticky bottom-0 mt-8 pt-4 pb-2 z-10 w-full bg-gradient-to-t from-gray-50/95 via-gray-50/95 to-transparent dark:from-[#1a1b23]/95 dark:via-[#1a1b23]/95 dark:to-transparent pointer-events-none">
                  <div className="pointer-events-auto">
                    {!isCommentBoxVisible ? (
                      <div className="flex justify-end">
                        <button
                          onClick={() => setIsCommentBoxVisible(true)}
                          className="bg-primary text-white px-4 py-2 rounded-full font-bold shadow-md hover:bg-primary-hover text-sm"
                        >
                          Reply
                        </button>
                      </div>
                    ) : (
                      <div className="rounded-xl shadow-lg border border-gray-200 bg-white dark:bg-[#1f2028] dark:border-white/10 backdrop-blur-md w-full">
                        <CommentBox ref={commentBoxRef} {...commentBoxProps} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          className="absolute top-0 bottom-0 z-40 w-2 cursor-col-resize hover:bg-primary/20 hover:backdrop-blur-sm transition-colors"
          style={{ right: `${sidebarWidth - 4}px` }}
          onMouseDown={(e) => { e.preventDefault(); setIsDraggingSidebar(true); }}
        />

        <aside className="min-h-0 min-w-0 overflow-y-auto bg-gray-50/80 p-6 dark:bg-black/10" style={{ width: `${sidebarWidth}px`, overflowX: 'hidden' }}>
          <div className="space-y-6 w-full">
            <MetadataPanel {...metadataPanelProps} />
            {subtasksPanel}
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/10">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                {getPriorityIcon(priority, config)}
                {priority}
              </div>
            </div>
            {detailsPanel}
            {modalTask?.id && <PayloadSizePanel taskId={modalTask.id} />}
          </div>
        </aside>
      </div>
      </motion.div>
    </Container>
  );
}
