import { memo, useDeferredValue } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
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
    handleSave, handleDelete,
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

  const animationsEnabled = config?.animationsEnabled ?? true;
  const speedMap = { fast: 0.2, normal: 0.4, slow: 0.7 };
  const duration = speedMap[config?.animationSpeed || 'normal'];
  const Container = animationsEnabled ? motion.div : 'div';
  const layoutProps = animationsEnabled ? {
    layoutId: `ticket-${modalTask?.id}`,
    transition: { type: 'spring' as const, bounce: 0.15, duration: duration + 0.3 },
    style: { zIndex: 60 }
  } : {};
  const contentAnimation = animationsEnabled ? {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.2, delay: duration * 0.4 } },
    exit: { opacity: 0, transition: { duration: 0.05, delay: 0 } },
  } : {};

  const metadataPanelProps = {
    status, setStatus: c.setStatus,
    assignee, setAssignee: c.setAssignee,
    priority, setPriority: c.setPriority,
    effort, setEffort: c.setEffort,
    effortLevel, setEffortLevel: c.setEffortLevel,
    implementationLink, setImplementationLink: c.setImplementationLink,
    tags, setTags: c.setTags,
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
          className="pointer-events-auto fixed inset-0 z-[55] bg-black/40 backdrop-blur-sm"
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
        onConfirm={() => void handleStartPromptConfirm()}
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
