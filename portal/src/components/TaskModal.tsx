import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMotionTokens } from '../motion/tokens';
import { useAppSelector } from '../store/useAppSelector';
import { OrchestrationLauncher } from './OrchestrationLauncher';
import { ReadyForMergePrompt } from './task-modal/ReadyForMergePrompt';
import { StartTaskPrompt } from './task-modal/StartTaskPrompt';
import { RequireInputPrompt } from './task-modal/RequireInputPrompt';
import { SubtasksPanel } from './task-modal/SubtasksPanel';
import { DetailsPanel } from './task-modal/DetailsPanel';
import { ModalDialogs } from './task-modal/ModalDialogs';
import { ActivityFilterTabs } from './task-modal/ActivityFilterTabs';
import { TaskModalFullView } from './task-modal/TaskModalFullView';
import { TaskModalPopupView } from './task-modal/TaskModalPopupView';
import { useTaskModalController } from '../hooks/useTaskModalController';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { Task } from '../types';

// FLUX-1141: memoized — TaskModal takes no props at all, so this is a guaranteed-safe bail
// whenever AppContent re-renders for reasons unrelated to the modal (terminal/furnace toggles,
// the 5s furnace-status poll); its own isModalOpen/modalTask reads still re-render it normally.
export const TaskModal = memo(function TaskModal() {
  const c = useTaskModalController();

  // FLUX-1022: ESC closes the modal via the same guarded path as a backdrop click (unsaved-changes
  // confirmation still runs). Registered whenever the modal is open (popup or full view) so it
  // participates in the shared Escape stack alongside its own confirm dialogs and StartTaskPrompt.
  useEscapeKey(c.handleCloseAttempt, { enabled: c.isModalOpen });

  const {
    isModalOpen,
    closeModal,
    modalTask,
    setDiffViewFile,
    config,
    saveConfig,
    currentUser,
    ctxMarkCommentRead,
    ctxMarkAllCommentsRead,
    allTasks,
    openTaskModal,
    liveOutputRef,
    commentRef,
    replyTextareaRef,
    returnToWorkReasonRef,
    status, assignee, tags, priority, effort, effortLevel,
    implementationLink, subtasks, setSubtasks, parentId, setParentId,
    saving,
    cliSession, cliSessionBusy, cliSessionError,
    selectedCliFramework, setSelectedCliFramework,
    skipPermissions, setSkipPermissions,
    sessionIsActive, stopSession, stopGroup,
    activeRunGroup,
    requireInputDraft, setRequireInputDraft,
    activityFilter, setActivityFilter,
    replyTargetId, replyDraft, setReplyDraft,
    collapsedThreads,
    responseDestination, setResponseDestination,
    returnToWorkOpen, setReturnToWorkOpen,
    confirmDelete,
    isFullView, setIsFullView,
    setIsPromptModalOpen,
    isUploadingCommentAsset,
    isUploadingReplyAsset,
    commentAssetError,
    replyAssetError,
    finishBusy, finishError,
    reviewBusy, reviewError,
    showStartPrompt, setShowStartPrompt,
    handleCommentPaste, handleCommentDragOver, handleCommentDrop,
    handleReplyPaste, handleReplyDragOver, handleReplyDrop,
    allStatuses, allUsers, allTags, availablePriorities,
    requireInputDestinations,
    isRequireInput, isReadyForMerge,
    createdAt, updatedAt,
    topLevelEntries, repliesByParent,
    inlineSubtaskMap,
    linkedSubtasks, danglingSubtaskIds,
    readCommentIds, unreadCommentCount,
    isSwimlaneOnly, hasActiveSessionForPrompt, cliSessionActive,
    groomingBanner, requireInputBanner, readyForMergeBanner,
    handleSave, saveField, handleDelete,
    sendCommentDirectly, sendReplyDirectly, submitRequireInputResponse,
    handleReturnToWork, openLauncher, handleReviewLaunch,
    sendFinishCommand, handleLaunchWithBranchCheck, handleStartPromptConfirm,
    handleToggleReply, handleCancelReply,
    handleToggleCollapsed, handleClearReplyAssetError,
    reviewModalOpen, setReviewModalOpen, launcherPhase,
  } = c;

  // FLUX-1200: the shell (header/title/status/save button — all built straight from `modalTask`
  // above) commits synchronously so opening/switching tickets feels instant, while the heavy
  // content grid (MetadataPanel, the TipTap description editor, SubtasksPanel, DetailsPanel) reads
  // this deferred value instead — React renders it as a low-priority, interruptible update, so the
  // shell paints a frame before the content commits. Unlike the FullView's existing
  // `isTaskLoading && !modalTask?.body` gate (which only covers the truly-new/fetching-task case),
  // this also helps the common case of reopening an already-loaded task, where `isTaskLoading` is
  // false from the first render and nothing previously deferred the content mount.
  const deferredModalTask = useDeferredValue(modalTask);
  const isContentPending = modalTask !== deferredModalTask;

  const animationsEnabled = config?.animationsEnabled ?? true;
  const tokens = useMotionTokens();
  const Container = animationsEnabled ? motion.div : 'div';

  // FLUX-1507: card→modal morph. `modalOriginRect` (AppContext, set by openTaskModal/
  // openTaskFullView's `from` arg) is the clicked card's rect. `originForOpen` snapshots it
  // ONLY on the closed→open transition — and self-clears a couple of frames later — so later
  // full/popup toggles (a fresh AnimatePresence mount, same modal instance) don't replay the
  // long-distance card morph; they get a plain fade instead. This is the FLIP `layoutId` from
  // FLUX-629 would have needed a live card rect for, minus the per-render measurement cost: the
  // target rect below is the view's known fixed geometry, not something we measure.
  const modalOriginRect = useAppSelector((s) => s.modalOriginRect);
  const [originForOpen, setOriginForOpen] = useState<typeof modalOriginRect>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isModalOpen && !wasOpenRef.current) {
      setOriginForOpen(modalOriginRect);
    } else if (!isModalOpen) {
      setOriginForOpen(null);
    }
    wasOpenRef.current = isModalOpen;
  }, [isModalOpen, modalOriginRect]);
  useEffect(() => {
    if (!originForOpen) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setOriginForOpen(null)));
    return () => cancelAnimationFrame(id);
  }, [originForOpen]);

  const morphTransform = useMemo(() => {
    if (tokens.instant || !originForOpen) return null;
    // Known fixed geometry for each view (TaskModalFullView's `fixed inset-3`; TaskModalPopupView's
    // Rnd `default`) — read once at mount, not measured every render.
    const targetRect = isFullView
      ? { left: 12, top: 12, width: window.innerWidth - 24, height: window.innerHeight - 24 }
      : { left: window.innerWidth / 2 - 400, top: Math.max(30, window.innerHeight * 0.05), width: 800, height: window.innerHeight * 0.9 };
    const dx = originForOpen.left + originForOpen.width / 2 - (targetRect.left + targetRect.width / 2);
    const dy = originForOpen.top + originForOpen.height / 2 - (targetRect.top + targetRect.height / 2);
    const scale = Math.max(0.1, Math.min(1, originForOpen.width / targetRect.width));
    return { x: dx, y: dy, scale };
  }, [originForOpen, isFullView, tokens.instant]);

  const layoutProps = animationsEnabled ? {
    initial: morphTransform ? { ...morphTransform, opacity: 0.4 } : { opacity: 0, scale: 0.98 },
    animate: { x: 0, y: 0, scale: 1, opacity: 1, transition: tokens.spring },
    exit: morphTransform ? { ...morphTransform, opacity: 0, transition: tokens.fade } : { opacity: 0, scale: 0.98, transition: tokens.fade },
    style: { zIndex: 60 },
  } : {};
  const contentAnimation = animationsEnabled ? {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { ...tokens.fade, delay: tokens.springSettleMs / 1000 * 0.4 } },
    exit: { opacity: 0, transition: { duration: 0.05, delay: 0 } },
  } : {};

  const activityFilterTabs = (
    <ActivityFilterTabs
      activityFilter={activityFilter}
      setActivityFilter={setActivityFilter}
      unreadCommentCount={unreadCommentCount}
      modalTask={modalTask}
      ctxMarkAllCommentsRead={ctxMarkAllCommentsRead}
    />
  );

  if (!config || (!isModalOpen && !modalTask)) return null;

  const requireInputPrompt = isRequireInput && modalTask?.id ? (
    <RequireInputPrompt
      hasActiveSessionForPrompt={hasActiveSessionForPrompt}
      isSwimlaneOnly={isSwimlaneOnly}
      requireInputBanner={requireInputBanner}
      groomingBanner={groomingBanner}
      commentRef={commentRef}
      requireInputDraft={requireInputDraft}
      setRequireInputDraft={setRequireInputDraft}
      saving={saving}
      submitRequireInputResponse={submitRequireInputResponse}
      setIsFullView={setIsFullView}
      responseDestination={responseDestination}
      setResponseDestination={setResponseDestination}
      requireInputDestinations={requireInputDestinations}
    />
  ) : null;

  const readyForMergePrompt = isReadyForMerge && modalTask?.id ? (
    <ReadyForMergePrompt
      taskId={modalTask.id}
      readyForMergeBanner={readyForMergeBanner}
      saving={saving}
      finishBusy={finishBusy}
      finishError={finishError}
      returnToWorkOpen={returnToWorkOpen}
      reviewBusy={reviewBusy}
      reviewError={reviewError}
      cliSessionActive={cliSessionActive}
      isFullView={isFullView}
      returnToWorkReasonRef={returnToWorkReasonRef}
      onReturnToWork={() => void handleReturnToWork()}
      onReturnToWorkAndLaunch={() => void handleReturnToWork({ launch: true })}
      onFinish={sendFinishCommand}
      onOpenReviewModal={() => openLauncher('review')}
      onSetReturnToWorkOpen={setReturnToWorkOpen}
      onSetIsFullView={setIsFullView}
      onSetIsPromptModalOpen={setIsPromptModalOpen}
    />
  ) : null;

  // FLUX-979: metadata dropdowns save instantly on change (via `saveField`) instead of joining
  // the title/body dirty-then-Save flow — they never leave the ticket in an unclear "unsaved"
  // state, and an agent's concurrent edit to an untouched field is never held stale or clobbered.
  const metadataPanelProps = {
    status, setStatus: (v: string) => void saveField('status', v),
    assignee, setAssignee: (v: string) => void saveField('assignee', v),
    priority, setPriority: (v: string) => void saveField('priority', v),
    effort, setEffort: (v: string) => void saveField('effort', v),
    effortLevel, setEffortLevel: (v: string) => void saveField('effortLevel', v),
    // Free text: local live-typing update only, committed on blur (not per keystroke).
    implementationLink, setImplementationLink: c.setImplementationLink,
    onImplementationLinkBlur: () => void saveField('implementationLink', implementationLink),
    tags, setTags: (v: string[]) => void saveField('tags', v),
    allStatuses, allUsers, allTags,
    configTags: config?.tags ?? [],
    availablePriorities,
    // FLUX-1200: deferred — see `deferredModalTask` above.
    task: deferredModalTask ?? undefined,
    onDiffFileClick: (file: string) => setDiffViewFile(file),
  };

  const parentTask = parentId ? allTasks.find((t) => t.id === parentId) : null;

  const subtasksPanel = (
    <SubtasksPanel
      config={config}
      modalTask={deferredModalTask}
      parentId={parentId}
      setParentId={setParentId}
      subtasks={subtasks}
      setSubtasks={setSubtasks}
      allTasks={allTasks}
      openTaskModal={openTaskModal}
      parentTask={parentTask ?? null}
      linkedSubtasks={linkedSubtasks}
      danglingSubtaskIds={danglingSubtaskIds}
      inlineSubtaskMap={inlineSubtaskMap}
    />
  );

  const detailsPanel = (
    <DetailsPanel
      modalTask={deferredModalTask}
      currentUser={currentUser}
      createdAt={createdAt}
      updatedAt={updatedAt}
      effort={effort}
      handleSetReviewState={c.handleSetReviewState}
      implementationLink={implementationLink}
      activeRunGroup={activeRunGroup}
      config={config}
      cliSession={cliSession}
      cliSessionBusy={cliSessionBusy}
      cliSessionError={cliSessionError}
      selectedCliFramework={selectedCliFramework}
      setSelectedCliFramework={setSelectedCliFramework}
      skipPermissions={skipPermissions}
      setSkipPermissions={setSkipPermissions}
      sessionIsActive={sessionIsActive}
      liveOutputRef={liveOutputRef}
      saveConfig={saveConfig}
      stopSession={stopSession}
      stopGroup={stopGroup}
      handleLaunchWithBranchCheck={handleLaunchWithBranchCheck}
      setConfirmDelete={c.setConfirmDelete}
    />
  );

  const historyListProps = {
    topLevelEntries,
    repliesByParent,
    collapsedThreads,
    replyTargetId,
    replyDraft,
    replyAssetError,
    isUploadingReplyAsset,
    saving,
    readCommentIds,
    currentUser,
    isRequireInput,
    taskId: modalTask?.id,
    config,
    replyTextareaRef,
    onMarkCommentRead: ctxMarkCommentRead,
    onToggleReply: handleToggleReply,
    onSetReplyDraft: setReplyDraft,
    onClearReplyAssetError: handleClearReplyAssetError,
    onToggleCollapsed: handleToggleCollapsed,
    onSendReply: sendReplyDirectly,
    onCancelReply: handleCancelReply,
    onReplyPaste: handleReplyPaste,
    onReplyDragOver: handleReplyDragOver,
    onReplyDrop: handleReplyDrop,
  };

  const commentBoxProps = {
    onPaste: handleCommentPaste,
    onDragOver: handleCommentDragOver,
    onDrop: handleCommentDrop,
    onSend: sendCommentDirectly,
    saving,
    isUploading: isUploadingCommentAsset,
    assetError: commentAssetError,
    isRequireInput,
    disabled: !modalTask?.id,
    textareaRef: commentRef,
  };

  return (<>
    <AnimatePresence>
      {isModalOpen && config && !isFullView && (
        <motion.div
          key="modal-overlay"
          initial={animationsEnabled ? { opacity: 0 } : undefined}
          animate={animationsEnabled ? { opacity: 1 } : undefined}
          exit={animationsEnabled ? { opacity: 0 } : undefined}
          transition={{ duration: 0.2 }}
          className="pointer-events-auto fixed inset-0 z-[55] bg-black/55"
          onClick={c.handleCloseAttempt}
        />
      )}

      {isModalOpen && config && isFullView && (
        <TaskModalFullView
          key="modal-content-full"
          c={c}
          Container={Container}
          layoutProps={layoutProps}
          contentAnimation={contentAnimation}
          metadataPanelProps={metadataPanelProps}
          historyListProps={historyListProps}
          commentBoxProps={commentBoxProps}
          requireInputPrompt={requireInputPrompt}
          readyForMergePrompt={readyForMergePrompt}
          subtasksPanel={subtasksPanel}
          detailsPanel={detailsPanel}
          activityFilterTabs={activityFilterTabs}
          deferredModalTask={deferredModalTask}
          isContentPending={isContentPending}
        />
      )}

      {isModalOpen && config && !isFullView && (
        <TaskModalPopupView
          key="modal-content-popup"
          c={c}
          Container={Container}
          layoutProps={layoutProps}
          contentAnimation={contentAnimation}
          metadataPanelProps={metadataPanelProps}
          historyListProps={historyListProps}
          commentBoxProps={commentBoxProps}
          deferredModalTask={deferredModalTask}
          isContentPending={isContentPending}
          requireInputPrompt={requireInputPrompt}
          readyForMergePrompt={readyForMergePrompt}
          subtasksPanel={subtasksPanel}
          activityFilterTabs={activityFilterTabs}
        />
      )}
    </AnimatePresence>

    {/* Dialogs/prompts are NOT presence-animated — they manage their own visibility.
        Keeping them inside AnimatePresence made them unkeyed siblings of the keyed
        views, so framer-motion collapsed each to key "" → "two children with the same
        key, ``" → React duplicated the modal (ghost stacked underneath). Render them
        as plain siblings outside AnimatePresence. */}
    <ModalDialogs
      confirmDelete={confirmDelete}
      setConfirmDelete={c.setConfirmDelete}
      handleDelete={handleDelete}
      saving={saving}
      confirmDiscard={c.confirmDiscard}
      setConfirmDiscard={c.setConfirmDiscard}
      closeModal={closeModal}
      handleSave={handleSave}
      isFullView={isFullView}
    />

    {showStartPrompt && modalTask && (
      <StartTaskPrompt
        task={modalTask as Task}
        onConfirm={(selection) => void handleStartPromptConfirm(selection)}
        onCancel={() => setShowStartPrompt(false)}
      />
    )}

    <OrchestrationLauncher
      open={reviewModalOpen}
      ticket={modalTask?.id ? { id: modalTask.id, title: modalTask.title || 'Untitled', status: modalTask.status, branch: modalTask.branch, effort: modalTask.effort } : null}
      framework={selectedCliFramework}
      phase={launcherPhase}
      onClose={() => setReviewModalOpen(false)}
      onLaunch={handleReviewLaunch}
      busy={reviewBusy}
      error={reviewError}
    />
    </>
  );
});
