import { useState, type ReactNode } from 'react';
import {
  AlignLeft, ChevronDown, ChevronRight, ClipboardCheck, LayoutTemplate, ListTree, Maximize2, MessageSquare, Minimize2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SubtasksPanel } from './SubtasksPanel';
import { ArtifactPanel } from './ArtifactPanel';
import { HistoryList } from './HistoryList';
import { CommentBox } from './CommentBox';
import { ActivityFilterTabs } from './ActivityFilterTabs';
import { TaskDescriptionSurface } from '../TaskDescriptionSurface';
import { useDock } from '../DockProvider';
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
 * FLUX-744: the panel is a two-pane layout — Description and Activity are both always open and split
 * the available height (Activity content-sized but capped at half; Description fills the rest), each
 * with its own internal scroll so neither buries the other. A per-pane expand/restore toggle "focuses"
 * one pane (it fills the panel; the other collapses to just its header). Hierarchy stays a collapsible
 * section at the bottom.
 */

type SideViewController = ReturnType<typeof useTicketSideView>;

/** FLUX-744: which pane is "focused" (expanded to fill the panel). `null` = the default split. */
type PaneFocus = 'description' | 'activity' | null;

interface SideViewSection {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Collapsed by default? (defaults to open.) */
  collapsed?: boolean;
  render: (c: SideViewController) => ReactNode;
}

/** A collapsible titled section (used for Hierarchy). FLUX-740: open-state persists in DockProvider
 *  (keyed by section id), defaulting to the registry's `collapsed` flag until the user overrides it.
 *  FLUX-744: `shrink-0` is load-bearing — as a flex child of the scroll column, an `overflow-hidden`
 *  section would otherwise get an automatic min-size of 0 and be compressed (clipping its content with
 *  no scrollbar) instead of keeping its natural height and letting the column scroll. */
function Section({ section, c }: { section: SideViewSection; c: SideViewController }) {
  const { sectionOpen, setSectionOpen } = useDock();
  const open = sectionOpen[section.id] ?? !section.collapsed;
  const Icon = section.icon;
  return (
    <section className="eh-border shrink-0 overflow-hidden rounded-xl border bg-[var(--eh-input-bg)]">
      <button
        type="button"
        onClick={() => setSectionOpen(section.id, !open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        <span>{section.title}</span>
      </button>
      {open && <div className="max-h-[40vh] overflow-y-auto px-3 pb-3">{section.render(c)}</div>}
    </section>
  );
}

/**
 * FLUX-744: a primary sideview pane (Description / Activity). Always open. The two panes split the
 * scroll column — Activity is content-sized but capped at half (`max-h-[50%]`), Description fills the
 * rest. The header's expand/restore toggle "focuses" a pane: the focused pane grows to fill the panel
 * (`flex-1`) and the other collapses to just its header (click again to restore the split). Each pane's
 * `children` own their internal scroll, so the two panes never bury each other.
 */
function SideviewPane({
  id, title, icon: Icon, focus, setFocus, children,
}: {
  id: Exclude<PaneFocus, null>;
  title: string;
  icon: LucideIcon;
  focus: PaneFocus;
  setFocus: (f: PaneFocus) => void;
  children: ReactNode;
}) {
  const isFocused = focus === id;
  const isCollapsed = focus !== null && !isFocused;
  const sizeClass = isCollapsed
    ? 'flex-shrink-0'
    : isFocused || id === 'description'
      ? 'min-h-0 flex-1'
      : 'flex-shrink-0 max-h-[50%]'; // Activity at rest: content-sized, capped at half the panel.
  return (
    // FLUX-744: clicking anywhere in the pane expands it — but only when it isn't already the focused
    // pane (the guard), so once expanded, clicks inside behave normally (edit the description, scroll,
    // "Show more", type a comment). Capture phase so it still fires over children that handle their own
    // clicks (e.g. the description editor). Restoring the split stays on the header's minimize icon.
    <section
      onClickCapture={() => { if (!isFocused) setFocus(id); }}
      className={`eh-border flex flex-col overflow-hidden rounded-xl border bg-[var(--eh-input-bg)] ${sizeClass}`}
    >
      <button
        type="button"
        onClick={() => setFocus(isFocused ? null : id)}
        title={isFocused ? 'Restore split' : 'Expand this section'}
        aria-expanded={!isCollapsed}
        className="flex w-full flex-shrink-0 items-center gap-2 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        <span>{title}</span>
        {isFocused
          ? <Minimize2 className="ml-auto h-3.5 w-3.5 flex-shrink-0" />
          : <Maximize2 className="ml-auto h-3.5 w-3.5 flex-shrink-0" />}
      </button>
      {!isCollapsed && <div className="flex min-h-0 flex-1 flex-col">{children}</div>}
    </section>
  );
}

/**
 * FLUX-873: the rich artifact viewer, surfaced as its own collapsible section at the top of
 * the panel (above Description) — but ONLY when the ticket has a published artifact, so the 99% of
 * tickets without one are unaffected. Open-state persists via DockProvider (keyed `artifact`),
 * defaulting open. Unlike the generic {@link Section} it does NOT height-cap its body — the artifact
 * iframe owns its own (large) height and would otherwise double-scroll inside a 40vh cap.
 *
 * FLUX-976: `publish_artifact` now spans both lifecycle ends — a plan-time grooming mockup AND a
 * Ready-time "visual recap" of the diff. The label is derived from the latest revision (recaps tag
 * their `title`/`note` with "recap") rather than hardcoded to "Grooming Artifact", which would be
 * misleading for a post-implementation recap.
 */
function ArtifactSection({ c, onSendToChat }: { c: SideViewController; onSendToChat?: (text: string) => void }) {
  const { sectionOpen, setSectionOpen, openPlanApproval } = useDock();
  const open = sectionOpen['artifact'] ?? true;
  const arts = c.task.artifacts;
  const latestRev =
    arts?.revisions?.find((r) => r.rev === arts.latest) ?? arts?.revisions?.[(arts?.revisions?.length ?? 0) - 1];
  const isRecap = latestRev ? /recap/i.test(`${latestRev.title ?? ''} ${latestRev.note ?? ''}`) : false;
  const label = isRecap ? 'Visual Recap' : 'Artifact';
  return (
    // FLUX-1474: was a two-strip header (this section's own collapse/identity row stacked above
    // ArtifactPanel's title/rev/warnings/rev-picker/fullscreen row) — now ONE row: the collapse
    // toggle + identity (`headerStart`) and "View Plan" (`headerEnd`) are handed to ArtifactPanel to
    // render inline with its own controls. When open, `h-[62vh]` gives this section a DEFINITE height
    // (not just a cap — `flex-1`/`fillHeight` need a bounded box to fill, not merely a max-height, to
    // actually stretch the iframe) in place of the old open-ended header+58vh+tip+pill stack, so the
    // iframe is the ONLY thing that can scroll inside the pane; the side-view host's own
    // `overflow-y-auto` no longer has to compete with a second, nearly-touching scrollbar right next
    // to it. Collapsed, no height class is set — the section shrinks to its header's natural size.
    <section className={`eh-border flex shrink-0 flex-col overflow-hidden rounded-xl border bg-[var(--eh-input-bg)] ${open ? 'h-[62vh]' : ''}`}>
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-2">
        <ArtifactPanel
          task={c.task}
          onSendToChat={onSendToChat}
          visible={open}
          collapsed={!open}
          fillHeight
          headerStart={
            <button
              type="button"
              onClick={() => setSectionOpen('artifact', !open)}
              aria-expanded={open}
              className="flex flex-shrink-0 items-center gap-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
            >
              {open ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
              <LayoutTemplate className="h-3.5 w-3.5 flex-shrink-0" />
              <span>{label}</span>
            </button>
          }
          headerEnd={
            // FLUX-1273: the plan-approval panel stays reachable long after the flagged moment
            // resolves — mirrors this section's own always-on-when-an-artifact-exists precedent
            // (no status gate).
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
      </div>
    </section>
  );
}

/**
 * FLUX-1278: a persistent "View Plan" entry point for tickets with no published artifact.
 * `ArtifactSection` already carries its own "View Plan" button in its header (FLUX-1273), but that
 * whole section is gated on `artifacts.revisions.length > 0` — so a ticket that never had an
 * artifact published (bug fixes, XS/S tickets, backend plumbing — `publish_artifact`'s own stated
 * skip cases) had no way back into the plan-approval panel once the plan-review flag resolved. This
 * renders in `ArtifactSection`'s place (mutually exclusive, never alongside it) so there's always
 * exactly one entry point.
 */
function PlanAccessRow({ taskId }: { taskId: string }) {
  const { openPlanApproval } = useDock();
  return (
    <button
      type="button"
      onClick={() => openPlanApproval(taskId)}
      title="Open the full plan-review panel — view, annotate, and (if unresolved) approve or send it back"
      className="eh-border flex shrink-0 items-center gap-2 rounded-xl border bg-[var(--eh-input-bg)] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
    >
      <ClipboardCheck className="h-3.5 w-3.5 flex-shrink-0" />
      <span>View Plan</span>
    </button>
  );
}

/** Hierarchy (subtasks / parent) — collapsed by default, sits below the two primary panes. */
const HIERARCHY_SECTION: SideViewSection = {
  id: 'subtasks',
  title: 'Hierarchy',
  icon: ListTree,
  collapsed: true,
  render: (c) =>
    c.config ? (
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
    ) : null,
};

/**
 * FLUX-740: the controller is created once in the chat window (so the metadata bar and this panel
 * share one form state + one dirty/save affordance) and passed in.
 *
 * FLUX-744: the panel has no header bar of its own — the ticket title/id/status are already shown in
 * the chat window chrome + metadata bar above, so repeating them here was pure dead space. The panes
 * fill the whole panel; closing the sideview is the chat header's panel-toggle.
 */
export function TicketSideView({ c, onSendToChat }: { c: SideViewController; onSendToChat?: (text: string) => void }) {
  // FLUX-744: which pane is expanded to fill the panel (null = the default Description/Activity split).
  const [focus, setFocus] = useState<PaneFocus>(null);
  return (
    // FLUX-744: fill the wrapper via `absolute inset-0` (the wrapper is `relative` + stretched to the
    // body-row height) rather than a flex-basis chain. This binds this column's height DIRECTLY to the
    // wrapper's definite box, so the panes below get a bounded height without relying on `flex-1`
    // propagating through nested levels (the failure mode that left the column unscrollable).
    <div className="absolute inset-0 flex flex-col bg-[var(--eh-surface)]">
      {/* Panes: Description → Activity → Hierarchy. Each primary pane scrolls internally; the column
          keeps `overflow-y-auto` as a fallback so an expanded Hierarchy stays reachable. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3">
        {(c.task.artifacts?.revisions?.length ?? 0) > 0
          ? <ArtifactSection c={c} onSendToChat={onSendToChat} />
          : <PlanAccessRow taskId={c.task.id} />}
        <SideviewPane id="description" title="Description" icon={AlignLeft} focus={focus} setFocus={setFocus}>
          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
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
        </SideviewPane>

        <SideviewPane id="activity" title="Activity & Comments" icon={MessageSquare} focus={focus} setFocus={setFocus}>
          {c.config ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-2 pt-1">
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
              {/* The chat (sibling window) is for talking to the agent; this composer is a plain ticket
                  annotation — always a comment, never routed to a live session. FLUX-744: hidden in the
                  default split (Activity is just a compact preview there) and revealed, pinned at the
                  pane bottom, only once Activity is expanded to full view. */}
              {focus === 'activity' && (
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
              )}
            </div>
          ) : null}
        </SideviewPane>

        <Section section={HIERARCHY_SECTION} c={c} />
      </div>
    </div>
  );
}
