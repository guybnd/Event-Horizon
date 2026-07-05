import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Maximize2 } from 'lucide-react';
import type { Task } from '../../types';
import { relativeTime } from '../../workflow';
import type { TaskCardController } from '../../hooks/useTaskCardController';

export function CardCommentPopover({ task, isOverlay, c }: { task: Task; isOverlay?: boolean; c: TaskCardController }) {
  const {
    commentPopoverOpen,
    commentPopupRef,
    commentPopoverPos,
    commentCloseTimeout,
    commentOpenedByHover,
    setCommentPopoverOpen,
    isMouseOverCard,
    startDescriptionTimer,
    comments,
    totalCommentCount,
    unreadCommentIds,
    ctxMarkAllCommentsRead,
    openTaskFullView,
    topLevelComments,
    readCommentIds,
    currentUser,
    repliesByParentId,
    popoverReplyTarget,
    markCommentRead,
    setPopoverReplyTarget,
    setPopoverReplyDraft,
    popoverReplyDraft,
    submitPopoverReply,
    popoverReplySaving,
  } = c;

  return createPortal(
    <AnimatePresence>
      {commentPopoverOpen && !isOverlay && (
        <motion.div
          ref={commentPopupRef}
          key={`comments-popup-${task.id}`}
          initial={{ opacity: 0, y: 4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.12 }}
          style={{
            position: 'fixed',
            top: Math.min(commentPopoverPos.top, window.innerHeight - 520),
            left: Math.min(commentPopoverPos.left, window.innerWidth - 480),
            zIndex: 999999,
          }}
          className="w-[480px] max-h-[520px] overflow-y-auto rounded-xl border border-gray-200/80 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-600 [&::-webkit-scrollbar-track]:bg-transparent"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            if (commentCloseTimeout.current !== null) {
              window.clearTimeout(commentCloseTimeout.current);
              commentCloseTimeout.current = null;
            }
          }}
          onMouseLeave={() => {
            if (commentOpenedByHover.current && commentCloseTimeout.current === null) {
              commentCloseTimeout.current = window.setTimeout(() => {
                commentCloseTimeout.current = null;
                setCommentPopoverOpen(false);
                commentOpenedByHover.current = false;
                if (isMouseOverCard.current) startDescriptionTimer();
              }, 200);
            }
          }}
        >
          <div className="sticky top-0 bg-white/95 dark:bg-[#1a1b23]/95 px-3 py-2 border-b border-gray-100 dark:border-white/5 backdrop-blur-xl flex items-center justify-between">
            <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
              Comments ({totalCommentCount}){unreadCommentIds.length > 0 ? ` · ${unreadCommentIds.length} unread` : ''}
              {/* FLUX-1144: the list payload only ships the most recent few comments inline — flag
                  it here so a heavily-commented ticket doesn't look like comments went missing. */}
              {comments.length < totalCommentCount ? ` · showing ${comments.length} most recent` : ''}
            </span>
            <div className="flex items-center gap-2">
              {unreadCommentIds.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    ctxMarkAllCommentsRead(task.id, unreadCommentIds);
                  }}
                  className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCommentPopoverOpen(false);
                  openTaskFullView(task, { scrollToComments: true });
                }}
                title="Open in full view"
                className="flex items-center gap-1 text-[10px] font-semibold text-gray-400 hover:text-primary dark:text-gray-500 dark:hover:text-primary transition-colors"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-white/5">
            {topLevelComments.map((c, i) => {
              const isUnreadItem = !!(c.id && !readCommentIds.has(c.id) && c.user !== currentUser);
              const replies = c.id ? (repliesByParentId.get(c.id) ?? []) : [];
              const isReplying = popoverReplyTarget === (c.id ?? null);
              return (
                <div key={c.id || i} className="p-3">
                  {/* top-level comment */}
                  <div
                    onClick={isUnreadItem && c.id ? (e) => markCommentRead(c.id!, e) : undefined}
                    className={`rounded-lg p-2.5 transition-colors ${isUnreadItem ? 'bg-amber-50/60 dark:bg-amber-500/5 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-500/10' : 'bg-gray-50/60 dark:bg-white/3'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-semibold text-gray-700 dark:text-gray-300">{c.user}</span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">{relativeTime(c.date)}</span>
                      {isUnreadItem && (
                        <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-500 dark:text-amber-400">
                          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400" />
                          click to mark read
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">{c.comment}</p>
                    {c.id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setPopoverReplyTarget(isReplying ? null : c.id!); setPopoverReplyDraft(''); }}
                        className="mt-1.5 text-[10px] font-semibold text-primary hover:text-primary/80 transition-colors"
                      >
                        {isReplying ? 'Cancel' : 'Reply'}
                      </button>
                    )}
                  </div>
                  {/* inline reply box */}
                  {isReplying && (
                    <div className="mt-2 ml-4 border-l-2 border-primary/20 pl-3">
                      <textarea
                        autoFocus
                        value={popoverReplyDraft}
                        onChange={(e) => setPopoverReplyDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitPopoverReply(c.id!);
                          if (e.key === 'Escape') { setPopoverReplyTarget(null); setPopoverReplyDraft(''); }
                        }}
                        placeholder="Write a reply… (Ctrl+Enter to send)"
                        className="w-full resize-none rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-200"
                        rows={3}
                      />
                      <div className="mt-1.5 flex justify-end gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); setPopoverReplyTarget(null); setPopoverReplyDraft(''); }}
                          className="rounded-md px-2 py-1 text-[10px] font-semibold text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
                        >Cancel</button>
                        <button
                          disabled={!popoverReplyDraft.trim() || popoverReplySaving}
                          onClick={(e) => { e.stopPropagation(); void submitPopoverReply(c.id!); }}
                          className="rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50"
                        >{popoverReplySaving ? 'Sending…' : 'Send'}</button>
                      </div>
                    </div>
                  )}
                  {/* threaded replies */}
                  {replies.length > 0 && (
                    <div className="mt-2 ml-4 space-y-1.5 border-l-2 border-gray-200/70 dark:border-white/10 pl-3">
                      {replies.map((r, ri) => {
                        const isUnreadReply = !!(r.id && !readCommentIds.has(r.id) && r.user !== currentUser);
                        return (
                          <div
                            key={r.id || ri}
                            onClick={isUnreadReply && r.id ? (e) => markCommentRead(r.id!, e) : undefined}
                            className={`rounded-md p-2 transition-colors ${isUnreadReply ? 'bg-amber-50/60 dark:bg-amber-500/5 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-500/10' : ''}`}
                          >
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-[10px] font-semibold text-gray-700 dark:text-gray-300">{r.user}</span>
                              <span className="text-[10px] text-gray-400 dark:text-gray-500">{relativeTime(r.date)}</span>
                              {isUnreadReply && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400" />}
                            </div>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">{r.comment}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
