import { memo, useMemo, useState } from 'react';
import { 
  ArrowRight, Bot, MessageSquare, ChevronDown, ChevronRight, 
  Search, FileText, Terminal, PenTool, Zap, Info 
} from 'lucide-react';
import type { Config, HistoryEntry, AgentSessionEntry, AgentSessionProgress } from '../../types';
import { StatusBadge } from '../StatusBadge';
import { getStatusColorClass } from '../../statusStyles';
import { TaskMarkdown } from '../TaskMarkdown';
import { relativeTime } from '../../workflow';
import { patternLabel, normalizeRoleLabel } from '../../orchestration';
import { useLiveSession } from '../../store/useAppSelector';
import type { ExecutionPattern, GroupVariant } from '../../types';

function unwrapAgentMessage(text: string): string {
  const match = text.match(/^```[^\n]*\n([\s\S]*?)```\s*$/);
  return match ? match[1] : text;
}

function formatSessionDuration(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const durationMs = end - start;
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function ProgressItem({ prog }: { prog: AgentSessionProgress }) {
  const [showDetails, setShowDetails] = useState(false);
  
  const icon = (() => {
    switch (prog.type) {
      case 'topic': return <Zap className="h-3 w-3 text-amber-500" />;
      case 'tool':
        if (prog.message.toLowerCase().includes('reading')) return <Search className="h-3 w-3 text-blue-500" />;
        if (prog.message.toLowerCase().includes('editing') || prog.message.toLowerCase().includes('writing')) return <PenTool className="h-3 w-3 text-emerald-500" />;
        if (prog.message.toLowerCase().includes('running')) return <Terminal className="h-3 w-3 text-purple-500" />;
        return <FileText className="h-3 w-3 text-gray-500" />;
      case 'text': return <Bot className="h-3 w-3 text-emerald-500" />;
      default: return <Info className="h-3 w-3 text-gray-400" />;
    }
  })();

  if (prog.type === 'topic') {
    return (
      <div className="mt-4 mb-2 first:mt-0">
        <div className="flex items-center gap-2 mb-1">
          {icon}
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            {prog.message}
          </span>
          <span className="text-[10px] text-gray-400 font-normal ml-auto">
            {relativeTime(prog.timestamp)}
          </span>
        </div>
        {prog.data?.summary && (
          <div className="text-xs text-gray-600 dark:text-gray-400 italic bg-amber-50/50 dark:bg-amber-500/5 p-2 rounded border border-amber-100 dark:border-amber-500/10">
            {prog.data.summary}
          </div>
        )}
      </div>
    );
  }

  if (prog.type === 'text') {
    return (
      <div className="my-3 first:mt-0">
        <div className="flex items-center gap-2 mb-1.5 opacity-50">
          {icon}
          <span className="text-[10px] font-semibold text-gray-500">Narration</span>
          <span className="text-[10px] text-gray-400 ml-auto">{relativeTime(prog.timestamp)}</span>
        </div>
        <div className="text-sm">
          <TaskMarkdown body={prog.message} compact imageMode="inline" emptyMessage="" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 py-0.5 group">
      <div className="mt-1 opacity-60 group-hover:opacity-100 transition-opacity">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-200 transition-colors">
            {prog.message}
          </span>
          {prog.type === 'tool' && prog.data?.parameters != null && (
            <button 
              onClick={() => setShowDetails(!showDetails)}
              className="text-[9px] font-bold text-gray-400 hover:text-primary uppercase tracking-tighter"
            >
              {showDetails ? 'hide details' : 'view params'}
            </button>
          )}
          <span className="text-[9px] text-gray-400 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
            {relativeTime(prog.timestamp)}
          </span>
        </div>
        {showDetails && prog.data?.parameters != null && (
          <pre className="mt-1 overflow-x-auto rounded bg-gray-100 p-1.5 text-[10px] text-gray-700 dark:bg-black/40 dark:text-gray-400 border border-gray-200 dark:border-white/5">
            {JSON.stringify(prog.data.parameters, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function SessionHistoryEntry({ session, taskId }: { session: AgentSessionEntry; taskId?: string }) {
  const [isExpanded, setIsExpanded] = useState(session.status === 'active');
  const duration = formatSessionDuration(session.startedAt, session.endedAt);
  // FLUX-626: while a session is active, its streaming progress lives in the liveSessions slice
  // (keyed by sessionId), not in the polled history (the engine only flushes progress to the
  // ticket file when the session ends). Prefer the live slice while active; once finished, fall
  // back to the persisted session.progress so we never double-render.
  const live = useLiveSession(taskId);
  const liveProgress = session.status === 'active' && session.sessionId
    ? live?.progressBySession?.[session.sessionId]
    : undefined;
  const progressEntries: AgentSessionProgress[] | undefined =
    (liveProgress && liveProgress.length > 0) ? liveProgress : session.progress;
  const statusLabel = session.status === 'completed' ? 'Completed' :
                      session.status === 'failed' ? 'Failed' :
                      session.status === 'cancelled' ? 'Cancelled' : 'Active';
  // FLUX-1156: a failed/cancelled session (incl. one that never even spawned) must read as an
  // error at a glance, not blend into the same emerald "all is well" styling as a healthy run.
  const failed = session.status === 'failed' || session.status === 'cancelled';

  return (
    <div className="flex gap-3">
      <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
        failed
          ? 'bg-red-100 border-red-200 dark:bg-red-500/15 dark:border-red-500/20'
          : 'bg-emerald-100 border-emerald-200 dark:bg-emerald-500/15 dark:border-emerald-500/20'
      }`}>
        <Bot className={`h-4 w-4 ${failed ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
      </div>
      <div className={`flex-1 min-w-0 rounded-xl border p-4 shadow-sm ${
        failed
          ? 'border-red-200 bg-red-50/30 dark:border-red-500/10 dark:bg-red-500/5'
          : 'border-emerald-200 bg-emerald-50/30 dark:border-emerald-500/10 dark:bg-emerald-500/5'
      }`}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full text-left"
        >
          <div className="flex items-center justify-between group">
            <div className="flex items-center gap-2.5">
              <div className="flex h-5 w-5 items-center justify-center rounded bg-white dark:bg-emerald-500/20 shadow-sm border border-emerald-100 dark:border-emerald-500/30">
                {isExpanded ? <ChevronDown className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> : <ChevronRight className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
              </div>
              <div>
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  Agent Session
                  {session.status === 'active' && (
                    <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  )}
                </div>
                <div className="text-[10px] text-gray-500 font-medium">
                  {duration} • {statusLabel}
                </div>
              </div>
            </div>
            <span className="text-[10px] text-gray-500 font-medium opacity-60 group-hover:opacity-100 transition-opacity" title={new Date(session.startedAt).toLocaleString()}>
              {relativeTime(session.startedAt)}
            </span>
          </div>
        </button>

        {session.outcome && (
          <div className={`mt-3 text-xs font-medium text-gray-700 dark:text-gray-300 bg-white/50 dark:bg-black/20 p-2.5 rounded-lg border ${failed ? 'border-red-100 dark:border-red-500/10' : 'border-emerald-100 dark:border-emerald-500/10'}`}>
            {session.outcome}
          </div>
        )}

        {isExpanded && session.finalMessage && (
          <div className={`mt-3 text-xs text-gray-700 dark:text-gray-300 bg-white/50 dark:bg-black/20 p-2.5 rounded-lg border whitespace-pre-wrap ${failed ? 'border-red-100 dark:border-red-500/10' : 'border-emerald-100 dark:border-emerald-500/10'}`}>
            {session.finalMessage}
          </div>
        )}

        {isExpanded && (progressEntries?.length ?? 0) > 0 && (
          <div className="mt-4 space-y-1 pl-1 border-l-2 border-emerald-200/50 dark:border-emerald-500/20 ml-2.5">
            {progressEntries!.map((prog, idx) => (
              <ProgressItem key={idx} prog={prog} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible block grouping all agent_session entries from one orchestration run. */
function GroupedSessionHistory({ sessions, taskId }: { sessions: AgentSessionEntry[]; taskId?: string }) {
  const anyActive = sessions.some(s => s.status === 'active');
  const [isExpanded, setIsExpanded] = useState(anyActive);
  const pattern = sessions.find(s => s.pattern)?.pattern as ExecutionPattern | undefined;
  // Combiner / orchestrator synthesis becomes the conclusion row.
  const combiner = sessions.find(s => normalizeRoleLabel(s.role) === 'orchestrator' || s.role === 'orchestrator');
  const workers = sessions.filter(s => s !== combiner);
  const doneCount = sessions.filter(s => s.status !== 'active').length;
  const label = patternLabel(pattern, undefined as GroupVariant | undefined);

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-500/15 border border-violet-200 dark:border-violet-500/20">
        <Bot className="h-4 w-4 text-violet-600 dark:text-violet-400" />
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-violet-200 bg-violet-50/30 dark:border-violet-500/10 dark:bg-violet-500/5 p-4 shadow-sm">
        <button onClick={() => setIsExpanded(!isExpanded)} className="w-full text-left">
          <div className="flex items-center justify-between group">
            <div className="flex items-center gap-2.5">
              <div className="flex h-5 w-5 items-center justify-center rounded bg-white dark:bg-violet-500/20 shadow-sm border border-violet-100 dark:border-violet-500/30">
                {isExpanded ? <ChevronDown className="h-3 w-3 text-violet-600 dark:text-violet-400" /> : <ChevronRight className="h-3 w-3 text-violet-600 dark:text-violet-400" />}
              </div>
              <div>
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  {label} Run · {sessions.length} agents
                  {anyActive && <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                </div>
                <div className="text-[10px] text-gray-500 font-medium">
                  {doneCount} of {sessions.length} finished
                </div>
              </div>
            </div>
          </div>
        </button>

        {isExpanded && (
          <div className="mt-3 space-y-2">
            {workers.map((s, idx) => (
              <SessionHistoryEntry key={`grp-${s.sessionId}-${idx}`} session={s} taskId={taskId} />
            ))}
            {combiner && (
              <div className="mt-1">
                <p className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wider text-violet-500">Synthesis</p>
                <SessionHistoryEntry session={combiner} taskId={taskId} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
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
  /** FLUX-744: how many (newest-first) entries to show before the "Show more" cutoff. Defaults to 30;
   *  the ticket sideview's Activity pane passes 3 so it opens as a compact preview. */
  initialVisibleCount?: number;
}

const INITIAL_VISIBLE_COUNT = 30;

export const HistoryList = memo(function HistoryList({
  topLevelEntries, repliesByParent, collapsedThreads, replyTargetId, replyDraft,
  replyAssetError, isUploadingReplyAsset, saving, readCommentIds, currentUser,
  isRequireInput, taskId, config, replyTextareaRef,
  onMarkCommentRead, onToggleReply, onSetReplyDraft, onClearReplyAssetError,
  onToggleCollapsed, onSendReply, onCancelReply, onReplyPaste, onReplyDragOver, onReplyDrop,
  initialVisibleCount = INITIAL_VISIBLE_COUNT,
}: HistoryListProps) {
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const reversedEntries = useMemo(() => [...topLevelEntries].reverse(), [topLevelEntries]);
  const visibleEntries = reversedEntries.length > visibleCount ? reversedEntries.slice(0, visibleCount) : reversedEntries;
  const hiddenCount = reversedEntries.length - visibleEntries.length;

  // Bucket agent_session entries that share a groupId (orchestration runs) so the
  // history shows one collapsible block per run instead of N separate sessions.
  const groupBuckets = useMemo(() => {
    const map = new Map<string, AgentSessionEntry[]>();
    for (const e of visibleEntries) {
      const g = e.type === 'agent_session' ? (e as AgentSessionEntry).groupId : undefined;
      if (g) {
        const arr = map.get(g) ?? [];
        arr.push(e as AgentSessionEntry);
        map.set(g, arr);
      }
    }
    for (const [k, v] of map) if (v.length < 2) map.delete(k);
    return map;
  }, [visibleEntries]);
  const renderedGroups = new Set<string>();

  return (
    <div className="space-y-4">
      {topLevelEntries.length === 0 ? (
        <p className="text-sm italic text-gray-500">No activity yet.</p>
      ) : (<>
        {visibleEntries.map((entry, index) => {
          // Handle agent_session entries separately
          if (entry.type === 'agent_session') {
            const gid = (entry as AgentSessionEntry).groupId;
            if (gid && groupBuckets.has(gid)) {
              if (renderedGroups.has(gid)) return null;
              renderedGroups.add(gid);
              return <GroupedSessionHistory key={`grp-${gid}-${index}`} sessions={groupBuckets.get(gid)!} taskId={taskId} />;
            }
            return <SessionHistoryEntry key={`session-${(entry as AgentSessionEntry).sessionId}-${index}`} session={entry as AgentSessionEntry} taskId={taskId} />;
          }

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
                  {entry.pin && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" title="Pinned — never collapsed in the agent digest">
                      pinned
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
              {entry.type === 'swimlane_change' && (
                <div className="mb-1.5 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                  {entry.action === 'set' ? 'Swimlane set:' : 'Swimlane cleared:'} <span className="font-semibold">{entry.swimlane}</span>
                </div>
              )}
              {entry.summary && (
                <div className="mb-1.5 border-l-2 border-primary/40 pl-2 text-xs italic text-gray-500 dark:text-gray-400" title="Agent summary — shown in place of the full text in the agent digest">
                  {entry.summary}
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
        )})}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setVisibleCount(prev => prev + INITIAL_VISIBLE_COUNT)}
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:bg-black/20 dark:text-gray-400 dark:hover:bg-white/5"
          >
            Show {Math.min(hiddenCount, INITIAL_VISIBLE_COUNT)} more ({hiddenCount} remaining)
          </button>
        )}
      </>)}
    </div>
  );
});
