import type { ComponentProps, ReactNode } from 'react';
import { Rnd } from 'react-rnd';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  Maximize2,
  MessageSquare,
  PanelRight,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { StatusBadge } from '../StatusBadge';
import { getStatusColorClass } from '../../statusStyles';
import { TaskDescriptionSurface } from '../TaskDescriptionSurface';
import { MetadataPanel } from './MetadataPanel';
import { DiffViewer } from './DiffViewer';
import { CommentBox } from './CommentBox';
import { HistoryList } from './HistoryList';
import { PrPanel } from './PrPanel';
import { RetryBanner } from './RetryBanner';
import { ChatPane } from './ChatPane';
import { hasOpenPr } from '../../workflow';
import type { Task } from '../../types';
import type { TaskModalController } from '../../hooks/useTaskModalController';

interface TaskModalPopupViewProps {
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
  activityFilterTabs: ReactNode;
}

export function TaskModalPopupView({
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
  activityFilterTabs,
}: TaskModalPopupViewProps) {
  const {
    config,
    modalTask,
    saveError,
    isDirty,
    status,
    title,
    setTitle,
    titleRef,
    setConfirmDelete,
    isWideMode,
    setIsWideMode,
    setIsFullView,
    saving,
    handleSave,
    handleCloseAttempt,
    isRequireInput,
    requireInputBanner,
    groomingBanner,
    diffViewFile,
    setDiffViewFile,
    body,
    setBody,
    cliSession,
    liveOutputRef,
    isReadyForMerge,
    commentBoxRef,
    openLauncher,
  } = c;

  return (
    <Rnd
      key="modal-content-popup"
      enableUserSelectHack={false}
      default={{ x: window.innerWidth / 2 - 400, y: Math.max(30, window.innerHeight * 0.05), width: 800, height: window.innerHeight * 0.9 }}
      minWidth={640}
      minHeight={420}
      bounds="window"
      dragHandleClassName="modal-handle"
      className="pointer-events-auto !z-[60]"
    >
      <Container
        {...layoutProps}
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border eh-border shadow-2xl eh-surface-overlay">
        <motion.div {...contentAnimation} className="flex h-full w-full flex-col overflow-hidden">
        {saveError && (
          <div className="bg-red-500/10 text-red-600 dark:text-red-400 px-4 py-2.5 text-sm font-medium border-b border-red-500/20 text-center flex items-center justify-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {saveError}
          </div>
        )}
        <div className="modal-handle flex shrink-0 items-center justify-between cursor-move border-b border-gray-100 bg-gray-50 px-4 py-3 dark:border-white/5 dark:bg-black/20">
          <div className="flex flex-col flex-1 min-w-0 mr-4">
            <div className="mb-0.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
              <span>
                {modalTask?.id ? modalTask.id : 'New Task'}{' '}
                {isDirty && <span className="ml-1 lowercase italic normal-case text-amber-500">(Unsaved changes)</span>}
              </span>
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
          <div className="flex items-center gap-2.5">
            {modalTask?.id && (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete Task"
                className="rounded p-1.5 text-red-400 transition-colors hover:bg-red-500 hover:text-white"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => setIsWideMode((current) => !current)}
              title="Toggle Wide Mode"
              className="rounded bg-gray-200/50 p-1.5 text-gray-400 transition-colors hover:text-primary dark:bg-white/5"
            >
              <PanelRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => setIsFullView(true)}
              title="Full View"
              className="flex items-center gap-1.5 rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/15"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Full View
            </button>
            <button
              disabled={saving || !isDirty}
              onClick={() => handleSave()}
              className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-semibold shadow-sm ${
                isDirty
                  ? 'cursor-pointer bg-primary text-white shadow-primary/20 hover:bg-primary-hover'
                  : 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/10'
              }`}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={handleCloseAttempt} className="cursor-pointer text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-white">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-sm text-gray-800 dark:text-gray-200">
          {isRequireInput ? requireInputPrompt : (
            <>
              {requireInputBanner}
              {groomingBanner}
            </>
          )}

          <div className="space-y-3 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/10">
            <MetadataPanel {...metadataPanelProps} variant="popup" isWideMode={isWideMode} />
          </div>

          <div className="flex min-h-[280px] flex-1 flex-col gap-2">
            {modalTask && <RetryBanner task={modalTask} />}
            {diffViewFile && modalTask?.id ? (
              <DiffViewer taskId={modalTask.id} file={diffViewFile} onBack={() => setDiffViewFile(null)} />
            ) : (
              <>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Description</label>
            <TaskDescriptionSurface
              key={`${modalTask?.id || 'new-task'}-popup`}
              value={body}
              onChange={setBody}
              taskId={modalTask?.id}
              mode="popup"
              emptyMessage="No description yet."
            />
              </>
            )}
          </div>

          {subtasksPanel}

          {modalTask?.id && <ChatPane task={modalTask as Task} />}

          {cliSession?.liveOutput && (
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Live Output</p>
              <pre
                ref={liveOutputRef}
                className="max-h-48 overflow-y-auto rounded-lg bg-gray-900 p-2 text-[10px] leading-relaxed text-gray-200 dark:bg-black/60 whitespace-pre-wrap break-words"
              >
                {cliSession.liveOutput}
              </pre>
            </div>
          )}

          <div className="border-t border-gray-200 pt-4 dark:border-white/10">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-300">
                <MessageSquare className="h-4 w-4" /> Activity & Comments
              </h3>
              {activityFilterTabs}
            </div>
            <div className="mb-4"><HistoryList {...historyListProps} /></div>
            {!isRequireInput && <CommentBox ref={commentBoxRef} {...commentBoxProps} />}
            {/* PR ticket (kind:'pr') always shows its PR surface regardless of status — an
                In-Progress / changes-requested PR would otherwise miss it (FLUX-568). */}
            {modalTask?.id && modalTask.branch && (hasOpenPr(modalTask as Task) || isReadyForMerge || modalTask.kind === 'pr') && (
              <div className="mb-4">
                <PrPanel taskId={modalTask.id} branch={modalTask.branch} onSendForReview={() => openLauncher('review')} />
              </div>
            )}
            {isReadyForMerge && readyForMergePrompt}
          </div>
        </div>
        </motion.div>
      </Container>
    </Rnd>
  );
}
