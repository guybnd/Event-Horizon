import { memo } from 'react';
import { ArrowRight, Bot, MessageSquare } from 'lucide-react';
import type { Config, HistoryEntry } from '../../types';
import { StatusBadge } from '../StatusBadge';
import { getStatusColorClass } from '../../statusStyles';
import { TaskMarkdown } from '../TaskMarkdown';
import { relativeTime } from '../../workflow';

function unwrapAgentMessage(text: string): string {
  const match = text.match(/^```[^\n]*\n([\s\S]*?)```\s*$/);
  return match ? match[1] : text;
}

export interface HistoryListProps {
  topLevelEntries: HistoryEntry[];
  repliesByParent: Map<string, HistoryEntry[]>;
  collapsedThreads: Record<string, boolean>;
  replyTargetId: string | null;
  replyDraft: string;
  replyAssetError: string;
  isUploadingReplyAsset: boolean;
  saving: boolean;
  readCommentIds: Set<string>;
  currentUser: string;
  isRequireInput: boolean;
  taskId: string | undefined;
  config: Config;
  replyTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onMarkCommentRead: (taskId: string, commentId: string) => void;
  onToggleReply: (entryId: string | undefined) => void;
  onSetReplyDraft: (value: string) => void;
  onClearReplyAssetError: () => void;
  onToggleCollapsed: (entryId: string) => void;
  onSendReply: (parentId: string) => void;
  onCancelReply: () => void;
  onReplyPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onReplyDragOver: (event: React.DragEvent<HTMLTextAreaElement>) => void;
  onReplyDrop: (event: React.DragEvent<HTMLTextAreaElement>) => void;
}

export const HistoryList = memo(function HistoryList({
  topLevelEntries, repliesByParent, collapsedThreads, replyTargetId, replyDraft,
  replyAssetError, isUploadingReplyAsset, saving, readCommentIds, currentUser,
  isRequireInput, taskId, config, replyTextareaRef,
  onMarkCommentRead, onToggleReply, onSetReplyDraft, onClearReplyAssetError,
  onToggleCollapsed, onSendReply, onCancelReply, onReplyPaste, onReplyDragOver, onReplyDrop,
}: HistoryListProps) {
  return (
    <div className="space-y-4">
      {topLevelEntries.length === 0 ? (
        <p className="text-sm italic text-gray-500">No activity yet.</p>
      ) : (
        [...topLevelEntries].reverse().map((entry, index) => {
          const replies = entry.id ? repliesByParent.get(entry.id) || [] : [];
          const isCollapsed = entry.id ? collapsedThreads[entry.id] : false;

          return (
          <div key={`${entry.id || entry.date}-${index}`} className="flex gap-3">
            <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${entry.type === 'agent_message' ? 'bg-gray-100 dark:bg-white/5' : 'bg-primary/10'}`}>
              {entry.type === 'status_change' ? (
                <ArrowRight className="h-3 w-3 text-primary" />
              ) : entry.type === 'agent_message' ? (
                <Bot className="h-3 w-3 text-gray-400 dark:text-gray-500" />
              ) : (
                <MessageSquare className="h-3 w-3 text-primary" />
              )}
            </div>
            <div
              className={`flex-1 min-w-0 rounded-lg border p-3 transition-colors ${
                entry.type === 'agent_message'
                  ? 'border-dashed border-gray-200 bg-gray-50/50 dark:border-white/5 dark:bg-black/10'
                  : entry.type === 'comment' && entry.id && !readCommentIds.has(entry.id) && entry.user !== currentUser
                  ? 'border-amber-200/60 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-500/10'
                  : 'border-gray-100 bg-gray-50 dark:border-white/5 dark:bg-black/20'
              }`}
              onClick={() => {
                if (entry.type === 'comment' && entry.id && !readCommentIds.has(entry.id) && entry.user !== currentUser) {
                  onMarkCommentRead(taskId!, entry.id);
                }
              }}
            >
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${entry.type === 'agent_message' ? 'text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'}`}>{entry.user}</span>
                  {entry.type === 'comment' && entry.id && (
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-300">
                      {entry.id}
                    </span>
                  )}
                  {entry.type === 'comment' && entry.id && !readCommentIds.has(entry.id) && entry.user !== currentUser && (
                    <span className="flex items-center gap-1 text-[10px] text-amber-500 dark:text-amber-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                      unread · click to mark read
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-gray-500" title={new Date(entry.date).toLocaleString()}>{relativeTime(entry.date)}</span>
              </div>
              {entry.type === 'status_change' && (
                <div className="mb-1.5 flex items-center gap-2 text-xs text-gray-500">
                  Moved from <StatusBadge status={entry.from || 'Unknown'} colorClass={getStatusColorClass(config, entry.from || '')} className="text-[10px] font-bold uppercase tracking-[0.16em]" />
                  <ArrowRight className="h-3 w-3" />
                  <StatusBadge status={entry.to || 'Unknown'} colorClass={getStatusColorClass(config, entry.to || '')} className="text-[10px] font-bold uppercase tracking-[0.16em]" />
                </div>
              )}
              {entry.comment && <TaskMarkdown body={entry.type === 'agent_message' ? unwrapAgentMessage(entry.comment) : entry.comment} taskId={taskId} compact imageMode={entry.type === 'comment' ? 'comment' : 'inline'} emptyMessage="" />}

              {entry.type === 'comment' && !entry.replyTo && taskId && !isRequireInput && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onToggleReply(entry.id)}
                    className="rounded-md px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                  >
                    Reply
                  </button>
                  {replies.length > 0 && entry.id && (
                    <button
                      type="button"
                      onClick={() => onToggleCollapsed(entry.id!)}
                      className="rounded-md px-2 py-1 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-200 dark:hover:bg-white/10"
                    >
                      {isCollapsed ? `Show replies (${replies.length})` : `Hide replies (${replies.length})`}
                    </button>
                  )}
                </div>
              )}

              {replyTargetId === entry.id && !isRequireInput && (
                <div className="mt-3 rounded-lg border border-primary/20 bg-white p-3 dark:border-primary/20 dark:bg-[#1f2028]">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">Replying inline</p>
                  <textarea
                    ref={replyTextareaRef}
                    className="h-24 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20"
                    value={replyDraft}
                    onChange={(event) => {
                      onSetReplyDraft(event.target.value);
                      if (replyAssetError) {
                        onClearReplyAssetError();
                      }
                    }}
                    onPaste={onReplyPaste}
                    onDragOver={onReplyDragOver}
                    onDrop={onReplyDrop}
                    placeholder="Write a reply..."
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-gray-500 dark:text-gray-400">
                    <span>Paste or drop PNG, JPG, or SVG images.</span>
                    {isUploadingReplyAsset && <span className="font-semibold text-primary">Uploading image...</span>}
                  </div>
                  {replyAssetError && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                      {replyAssetError}
                    </div>
                  )}
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={onCancelReply}
                      className="rounded-md px-3 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-200 dark:hover:bg-white/10"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={saving || isUploadingReplyAsset || !replyDraft.trim()}
                      onClick={() => entry.id && onSendReply(entry.id)}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {saving ? 'Replying...' : 'Reply'}
                    </button>
                  </div>
                </div>
              )}

              {replies.length > 0 && !isCollapsed && (
                <div className="mt-4 space-y-3 border-l-2 border-primary/20 pl-4">
                  {replies.map((reply) => (
                    <div key={reply.id || reply.date} className="rounded-lg border border-gray-100 bg-white p-3 dark:border-white/5 dark:bg-[#1f2028]">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{reply.user}</span>
                          {reply.id && (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-300">
                              {reply.id}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-500" title={new Date(reply.date).toLocaleString()}>{relativeTime(reply.date)}</span>
                      </div>
                      {reply.comment && <TaskMarkdown body={reply.comment} taskId={taskId} compact imageMode="comment" emptyMessage="" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )})
      )}
    </div>
  );
});
