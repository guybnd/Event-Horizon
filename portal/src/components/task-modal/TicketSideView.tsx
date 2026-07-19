import type { ReactNode } from 'react';
import { AlignLeft, ClipboardCheck, ListTree, MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SubtasksPanel } from './SubtasksPanel';
import { ArtifactPanel } from './ArtifactPanel';
import { HistoryList } from './HistoryList';
import { CommentBox } from './CommentBox';
import { ActivityFilterTabs } from './ActivityFilterTabs';
import { TaskDescriptionSurface } from '../TaskDescriptionSurface';
import { useDock } from '../DockProvider';
import { isPlanApprovalPending } from '../pendingInteractions';
import { isActiveSession } from '../../orchestration';
import type { useTicketSideView } from '../../hooks/useTicketSideView';

/**
 * FLUX-734: an extensible, chat-aligned ticket sideview. Slides out beside the floating chat
 * window (see ChatDock) so the conversation and the full ticket sit side-by-side — a modern,
 * native-to-the-chat replacement for opening the legacy center-screen TaskModal.
 *
 * FLUX-740: the controller is *lifted* — created once in the chat window and shared with the
 * editable metadata bar (ChatDock's `ChatMetadataBar`) so both surfaces drive the same form state
 * and one dirty/save affordance. The bar owns ALL ticket metadata (status/priority/assignee/effort +
 * tags/link/effortLevel), so the panel opens straight onto the content sections.
 *
 * FLUX-1515: replaces the FLUX-744 stacked-pane layout (three different expand/collapse mechanics,
 * nested scrollbars, magic heights, a hidden comment composer) with a real tab bar — Description ·
 * Plan · Activity · Hierarchy — each tab owning the full panel height with exactly one scrollbar.
 * Availability (unread comments, a live agent session, an unresolved plan review, subtask count)
 * renders as inline badges on the tabs themselves, so a collapsed tab no longer looks identical
 * whether it holds something or nothing. The default tab is computed from ticket state (artifact
 * present → Plan; else Grooming/plan-flagged → Plan; else live/unread → Activity; else Description)
 * and, once the user manually picks a tab, that choice is persisted per ticket (`DockProvider`
 * `selectedTab`) and wins on every later open — the auto-default only applies to a ticket the user
 * has never touched.
 */

type SideViewController = ReturnType<typeof useTicketSideView>;

type TabId = 'description' | 'plan' | 'activity' | 'hierarchy';

/** Small numeric pill for a tab's availability count (unread comments / subtask count). Renders
 *  nothing at zero — an empty tab carries no badge, only its (possibly dimmed) label. */
function CountBadge({ value }: { value: number }) {
  if (value <= 0) return null;
  return (
    <span className="flex h-3.5 min-w-[0.875rem] flex-shrink-0 items-center justify-center rounded-full bg-[var(--eh-text-muted)]/20 px-1 text-[9px] font-bold leading-none text-[var(--eh-text-secondary)]">
      {value > 99 ? '99+' : value}
    </span>
  );
}

/** Small status dot for a tab — emerald+pulse for a live agent session, amber (static) for an
 *  unresolved plan review. Mirrors the emerald/amber convention used elsewhere on the board
 *  (CardSessionRow, ActiveSessionsPopover) so the color language stays consistent. */
function StatusDot({ color, pulse }: { color: 'emerald' | 'amber'; pulse?: boolean }) {
  return (
    <span
      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${color === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500'} ${pulse ? 'animate-pulse' : ''}`}
    />
  );
}

/** One tab in the thin strip — icon + label inline on a single compact row. `dimmed` keeps the tab
 *  in its stable position (never hidden) while signalling "nothing here" for Hierarchy on a leaf
 *  ticket with no parent — stable positions over hiding, so the strip never reflows on click. */
function TabButton({
  active, dimmed, onClick, icon: Icon, title, children,
}: {
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
  icon: LucideIcon;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-selected={active}
      className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-1.5 text-[11px] font-semibold transition-colors ${
        active
          ? 'border-primary text-[var(--eh-text-primary)]'
          : 'border-transparent text-[var(--eh-text-muted)] hover:text-[var(--eh-text-secondary)]'
      } ${dimmed ? 'opacity-40' : ''}`}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      {children}
    </button>
  );
}

/** FLUX-1515: the default-tab precedence — artifact present wins outright (Guy: the plan is the
 *  default whenever there's one to show), then a Grooming ticket with a plan review awaiting
 *  confirm (which may have no artifact, e.g. a text-only plan revision), then live/unread activity,
 *  else Description. Only consulted when the ticket has no persisted `selectedTab` entry. */
function computeDefaultTab(c: SideViewController): TabId {
  if ((c.task.artifacts?.revisions?.length ?? 0) > 0) return 'plan';
  if (isPlanApprovalPending(c.task, c.config)) return 'plan';
  const liveSession = !!(c.task.cliSession && isActiveSession(c.task.cliSession));
  if (liveSession || c.unreadCommentCount > 0) return 'activity';
  return 'description';
}

/**
 * FLUX-740: the controller is created once in the chat window (so the metadata bar and this panel
 * share one form state + one dirty/save affordance) and passed in.
 *
 * FLUX-744/1515: the panel has no header bar of its own — the ticket title/id/status are already
 * shown in the chat window chrome + metadata bar above. The tab bar fills the top; the active tab's
 * panel fills the rest with its own single scroll container.
 */
export function TicketSideView({ c, onSendToChat }: { c: SideViewController; onSendToChat?: (text: string) => void }) {
  const { selectedTab, setSelectedTab, openPlanApproval } = useDock();

  const revisions = c.task.artifacts?.revisions ?? [];
  const hasArtifact = revisions.length > 0;
  const latestRevNum = c.task.artifacts?.latest ?? (hasArtifact ? revisions[revisions.length - 1]!.rev : 0);
  const latestRev = revisions.find((r) => r.rev === latestRevNum) ?? revisions[revisions.length - 1];
  const isRecap = latestRev ? /recap/i.test(`${latestRev.title ?? ''} ${latestRev.note ?? ''}`) : false;
  const planLabel = isRecap ? 'Recap' : 'Plan';
  const planPending = isPlanApprovalPending(c.task, c.config);
  const liveSession = !!(c.task.cliSession && isActiveSession(c.task.cliSession));
  const subtaskCount = c.subtasks.length;
  const hierarchyDim = !c.parentId && subtaskCount === 0;

  const persistedTab = selectedTab[c.task.id] as TabId | undefined;
  const activeTab: TabId = persistedTab ?? computeDefaultTab(c);
  const selectTab = (tab: TabId) => setSelectedTab(c.task.id, tab);

  return (
    // FLUX-744: fill the wrapper via `absolute inset-0` (the wrapper is `relative` + stretched to the
    // body-row height) rather than a flex-basis chain. This binds this column's height DIRECTLY to the
    // wrapper's definite box, so the active tab's panel gets a bounded height without relying on
    // `flex-1` propagating through nested levels (the failure mode that left the column unscrollable).
    <div className="absolute inset-0 flex flex-col bg-[var(--eh-surface)]">
      <div className="eh-border flex flex-shrink-0 border-b">
        <TabButton active={activeTab === 'description'} onClick={() => selectTab('description')} icon={AlignLeft}>
          Description
        </TabButton>
        <TabButton
          active={activeTab === 'plan'}
          onClick={() => selectTab('plan')}
          icon={ClipboardCheck}
          title={hasArtifact ? `${planLabel} — rev ${latestRevNum}` : planLabel}
        >
          <span className="flex flex-col items-center leading-tight">
            {hasArtifact && (
              <span className="text-[8px] font-bold uppercase tracking-wide opacity-70">v{latestRevNum}</span>
            )}
            <span className="flex items-center gap-1">
              {planLabel}
              {planPending && <StatusDot color="amber" />}
            </span>
          </span>
        </TabButton>
        <TabButton active={activeTab === 'activity'} onClick={() => selectTab('activity')} icon={MessageSquare}>
          <span className="flex items-center gap-1">
            Activity
            {liveSession && <StatusDot color="emerald" pulse />}
            <CountBadge value={c.unreadCommentCount} />
          </span>
        </TabButton>
        <TabButton
          active={activeTab === 'hierarchy'}
          onClick={() => selectTab('hierarchy')}
          icon={ListTree}
          dimmed={hierarchyDim}
        >
          <span className="flex items-center gap-1">
            Hierarchy
            <CountBadge value={subtaskCount} />
          </span>
        </TabButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === 'description' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
            <TaskDescriptionSurface
              key={`${c.task.id}-sideview`}
              value={c.body}
              onChange={c.setBody}
              taskId={c.task.id}
              mode="popup"
              hidePreviewHeader
              emptyMessage="No description yet."
            />
          </div>
        )}

        {activeTab === 'plan' && (
          <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
            {hasArtifact ? (
              <ArtifactPanel
                task={c.task}
                onSendToChat={onSendToChat}
                visible
                fillHeight
                headerStart={
                  // FLUX-1515 (annotation 3): the pending-review state lives HERE, inside the
                  // artifact panel's own header, instead of the old standalone full-width strip.
                  <span className="flex flex-shrink-0 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
                    <span>{isRecap ? 'Visual Recap' : 'Artifact'}</span>
                    {planPending && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                        Pending review
                      </span>
                    )}
                  </span>
                }
                headerEnd={
                  // FLUX-1273/1515: the plan-approval panel stays reachable long after the flagged
                  // moment resolves — the sole entry to the 4-subtab overlay (Artifact/Plan/AC/Tests).
                  <button
                    type="button"
                    onClick={() => openPlanApproval(c.task.id)}
                    title="Open the full plan-review panel — view, annotate, and (if unresolved) approve or send it back"
                    className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-secondary)] dark:hover:bg-white/5"
                  >
                    <ClipboardCheck className="h-3 w-3 flex-shrink-0" /> View Plan
                  </button>
                }
              />
            ) : (
              // FLUX-1278/1515: a persistent "View Plan" entry point for tickets with no published
              // artifact — the same overlay, reached without a section to render the artifact into.
              <button
                type="button"
                onClick={() => openPlanApproval(c.task.id)}
                title="Open the full plan-review panel — view, annotate, and (if unresolved) approve or send it back"
                className="eh-border flex shrink-0 items-center gap-2 self-start rounded-xl border bg-[var(--eh-input-bg)] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
              >
                <ClipboardCheck className="h-3.5 w-3.5 flex-shrink-0" />
                <span>View Plan</span>
              </button>
            )}
          </div>
        )}

        {activeTab === 'activity' && c.config && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-2 pt-3">
              <ActivityFilterTabs
                activityFilter={c.activityFilter}
                setActivityFilter={c.setActivityFilter}
                unreadCommentCount={c.unreadCommentCount}
                modalTask={c.modalTask}
                ctxMarkAllCommentsRead={c.ctxMarkAllCommentsRead}
              />
              <HistoryList
                initialVisibleCount={3}
                topLevelEntries={c.topLevelEntries}
                repliesByParent={c.repliesByParent}
                collapsedThreads={c.collapsedThreads}
                replyTargetId={c.replyTargetId}
                replyDraft={c.replyDraft}
                replyAssetError={c.replyAssetError}
                isUploadingReplyAsset={c.isUploadingReplyAsset}
                saving={c.saving}
                readCommentIds={c.readCommentIds}
                currentUser={c.currentUser}
                isRequireInput={c.isRequireInput}
                taskId={c.task.id}
                config={c.config}
                replyTextareaRef={c.replyTextareaRef}
                onMarkCommentRead={c.ctxMarkCommentRead}
                onToggleReply={c.handleToggleReply}
                onSetReplyDraft={c.setReplyDraft}
                onClearReplyAssetError={c.handleClearReplyAssetError}
                onToggleCollapsed={c.handleToggleCollapsed}
                onSendReply={c.sendReply}
                onCancelReply={c.handleCancelReply}
                onReplyPaste={c.handleReplyPaste}
                onReplyDragOver={c.handleReplyDragOver}
                onReplyDrop={c.handleReplyDrop}
              />
            </div>
            {/* The chat (sibling window) is for talking to the agent; this composer is a plain
                ticket annotation — always a comment, never routed to a live session. FLUX-1515:
                always visible now (the old `focus === 'activity'` gate hid it in the default
                split, a discoverability regression tabs don't need). */}
            <div className="flex-shrink-0 px-3 pb-3 pt-2">
              <CommentBox
                ref={c.commentBoxRef}
                onPaste={c.handleCommentPaste}
                onDragOver={c.handleCommentDragOver}
                onDrop={c.handleCommentDrop}
                onSend={c.sendComment}
                saving={c.saving}
                isUploading={c.isUploadingCommentAsset}
                assetError={c.commentAssetError}
                isRequireInput={false}
                disabled={!c.task.id}
                textareaRef={c.commentRef}
              />
            </div>
          </div>
        )}

        {activeTab === 'hierarchy' && c.config && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <SubtasksPanel
              config={c.config}
              modalTask={c.modalTask}
              parentId={c.parentId}
              setParentId={c.setParentId}
              subtasks={c.subtasks}
              setSubtasks={c.setSubtasks}
              allTasks={c.allTasks}
              openTaskModal={c.openTaskModal}
              parentTask={c.parentTask}
              linkedSubtasks={c.linkedSubtasks}
              danglingSubtaskIds={c.danglingSubtaskIds}
              inlineSubtaskMap={c.inlineSubtaskMap}
            />
          </div>
        )}
      </div>
    </div>
  );
}
