import { spawn } from 'child_process';
import * as path from 'path';
import { getConfig } from '../config.js';
import { buildActivityEntry } from '../history.js';
import { updateTaskWithHistory, estimateCostUSD } from '../task-store.js';
import { broadcastEvent } from '../events.js';
import { appendTranscriptLine } from '../transcript.js';
import type { CliSessionRecord } from './types.js';
import {
  activityFor,
  appendSessionOutput,
  appendErrorToSession,
  enqueueSessionWrite,
  flushSessionOutput,
  maybeWriteContextCheckpoint,
  attachStdoutProcessing as sharedAttachStdoutProcessing,
} from './shared.js';

/**
 * FLUX-1722: Anthropic Messages wire-format stream parser, shared by Claude Code
 * (`--output-format stream-json`) and Grok Build (`--output-format streaming-messages-json`).
 *
 * Composes over `shared.ts`'s line-buffer / JSON.parse skeleton — this module supplies only
 * the `onEvent` handler. Claude-specific vendor events (api_retry, rate_limit_event,
 * ScheduleWakeup) stay in the Claude dialect, not here.
 */

export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

/** FLUX-1746: the Anthropic Messages `usage` shape — carried both top-level on a `result` event and
 *  nested under `message` on an `assistant` event (the mid-turn gauge reads the latter). Kept
 *  optional-keyed, not exhaustive: the live payload also carries nested `cache_creation` detail
 *  neither call site reads. */
export interface AnthropicUsage {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface AnthropicCliEvent {
  type?: string;
  session_id?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string; name?: string };
  };
  rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number };
  /** FLUX-1744: carried on a `type:'system', subtype:'compact_boundary'` frame. Snake_case wire
   *  keys, verified against the shipped `@anthropic-ai/claude-code` binary's own zod schema and
   *  its internal(camelCase)->wire(snake_case) serializer — the CLI's internal shape is
   *  camelCase but that is never what reaches stdout, so don't "fix" this back to camelCase.
   *  The CLI's own `cumulative_dropped_tokens` is NOT read here; the Claude dialect
   *  (claude-code.ts) recomputes its own running sum from `pre_tokens - post_tokens` per event
   *  instead (see `recordCompaction`, agents/shared.ts) so the session total stays
   *  provider-independent. */
  compact_metadata?: { trigger?: 'auto' | 'manual'; pre_tokens?: number; post_tokens?: number; cumulative_dropped_tokens?: number; duration_ms?: number };
  message?: { content?: AnthropicContentBlock[]; usage?: AnthropicUsage };
  /** FLUX-1746: present (non-null) on an `assistant` frame emitted FOR a subagent (a Task-tool
   *  delegate), never on the main conversation's own frames — NOT currently declared upstream on
   *  this interface. Its `message.usage` reflects the SUBAGENT's own context, not the main
   *  session's, so the live gauge (below) must skip these frames rather than let a subagent's
   *  much-smaller usage overwrite the main session's reading. */
  parent_tool_use_id?: string | null;
  usage?: AnthropicUsage;
  total_cost_usd?: number;
  is_error?: boolean;
  error?: string;
  subtype?: string;
  api_error_status?: number;
  error_status?: number;
  result?: string;
  tool_name?: string;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    contextWindow?: number;
  }>;
}

export type ResultErrorKind = 'auth-expired' | 'rate-limited' | 'context-exhausted';

export interface AnthropicStreamDialect {
  toolActivityMap: Record<string, string>;
  progressLabel: (toolName: string, input: Record<string, unknown> | undefined) => string | undefined;
  earlyToolActivity?: (toolName: string) => string | undefined;
  onVendorEvent?: (
    evt: AnthropicCliEvent,
    trimmed: string,
    ctx: { proc: ReturnType<typeof spawn>; session: CliSessionRecord; taskId: string },
  ) => boolean;
  onToolUse?: (session: CliSessionRecord, block: AnthropicContentBlock) => void;
  classifyResultError?: (combined: string, apiStatus?: number) => ResultErrorKind | undefined;
  onAuthExpired?: (session: CliSessionRecord, taskId: string) => void;
}

export function attachAnthropicStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
  dialect: AnthropicStreamDialect,
) {
  return sharedAttachStdoutProcessing<AnthropicCliEvent>(proc, session, {
    onEvent: (evt, trimmed, commitPendingAssistantText) => {
      if (!session.resumeSessionId && evt.session_id) {
        session.resumeSessionId = evt.session_id;
      }
      if (dialect.onVendorEvent?.(evt, trimmed, { proc, session, taskId })) {
        return;
      }
      if (evt.type === 'stream_event') {
        const inner = evt.event;
        if (inner?.type === 'content_block_delta'
          && inner.delta?.type === 'text_delta'
          && typeof inner.delta.text === 'string'
          && inner.delta.text) {
          broadcastEvent('assistantDelta', {
            taskId,
            sessionId: session.sessionHistoryEntry?.sessionId,
            text: inner.delta.text,
          });
        } else if (inner?.type === 'content_block_start'
          && inner.content_block?.type === 'tool_use'
          && typeof inner.content_block.name === 'string') {
          const name = inner.content_block.name;
          const earlyActivity = dialect.earlyToolActivity?.(name)
            ?? activityFor(dialect.toolActivityMap, name);
          if (session.currentActivity !== earlyActivity) {
            session.currentActivity = earlyActivity;
            session.lastProgressLog = undefined;
            broadcastEvent('activity', { taskId, activity: session.currentActivity });
          }
        }
        return;
      }
      appendTranscriptLine(taskId, trimmed);
      // FLUX-1746: mid-turn live context gauge — updates on EVERY assistant frame, unlike
      // lastTurnContextTokens below (once per turn, only on `result`). Skip subagent frames
      // (non-null parent_tool_use_id): they carry the subagent's own usage, not the main
      // conversation's, and would otherwise let a session parked mid-turn by tool_use_blocked
      // (no `result` follows to correct it) read a much-smaller number here.
      if (evt.type === 'assistant' && evt.parent_tool_use_id == null && evt.message?.usage) {
        const u = evt.message.usage;
        session.liveContextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        maybeWriteContextCheckpoint(session, taskId);
      }
      if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block?.type === 'tool_result' && block.is_error) {
            const toolName = (block.tool_use_id && session.toolNamesById?.[block.tool_use_id]) || 'unknown';
            const raw = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ')
                : '';
            const detail = raw.trim().slice(0, 200);
            appendErrorToSession(session, `Tool failed: ${toolName}${detail ? ` — ${detail}` : ''}`);
          }
        }
      }
      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        const toolBlock = evt.message.content.find((b) => b.type === 'tool_use');
        if (toolBlock) {
          session.pendingAssistantText = '';
          const toolName = toolBlock.name ?? '';
          // FLUX-1763: the LABELED text is the activity. Before, the activity was the generic category
          // ("Running command"), so two consecutive Bash calls were "no change": no new progress entry,
          // and the 15s heartbeat re-posted the bare category — a six-minute `npm run check` showed as
          // "Running command" with no command anywhere in the durable record. Distinct commands are
          // distinct activities; the heartbeat now repeats the specific label.
          const labeled = dialect.progressLabel(toolName, toolBlock.input);
          const newActivity = labeled ?? activityFor(dialect.toolActivityMap, toolName);
          const activityChanged = session.currentActivity !== newActivity;
          session.currentActivity = newActivity;
          if (activityChanged) {
            session.lastProgressLog = undefined;
          }
          if (activityChanged && session.sessionHistoryEntry?.sessionId) {
            const progressMsg = session.currentActivity;
            if (session.sessionHistoryEntry) {
              session.sessionHistoryEntry.progress.push({
                timestamp: new Date().toISOString(),
                message: progressMsg,
                type: 'tool',
                data: { toolName, parameters: toolBlock.input },
              });
            }
          }
        } else {
          commitPendingAssistantText();
          session.currentActivity = 'Thinking';
        }
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
        for (const block of evt.message.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            session.liveOutputBuffer += block.text;
            if (!toolBlock) {
              session.pendingAssistantText += block.text;
            }
          } else if (block.type === 'tool_use' && block.id && typeof block.name === 'string') {
            (session.toolNamesById ??= {})[block.id] = block.name;
            dialect.onToolUse?.(session, block);
          }
        }
      } else {
        if (evt.type !== 'tool_use' && evt.type !== 'tool_result') {
          commitPendingAssistantText();
        } else {
          session.pendingAssistantText = '';
        }
        appendSessionOutput(session, trimmed, 'stdout', false);
      }
      if (evt.type === 'result') {
        session.currentActivity = undefined;
        session.toolNamesById = undefined;
        broadcastEvent('activity', { taskId, activity: null });
      }
      if (evt.type === 'result' && evt.usage) {
        const cacheRead = evt.usage?.cache_read_input_tokens ?? 0;
        const cacheCreation = evt.usage?.cache_creation_input_tokens ?? 0;
        const freshInput = evt.usage?.input_tokens ?? 0;
        const inputTok = freshInput + cacheRead + cacheCreation;
        const outputTok = evt.usage?.output_tokens ?? 0;
        session.inputTokens = (session.inputTokens ?? 0) + inputTok;
        session.outputTokens = (session.outputTokens ?? 0) + outputTok;
        session.cacheReadTokens = (session.cacheReadTokens ?? 0) + cacheRead;
        session.cacheCreationTokens = (session.cacheCreationTokens ?? 0) + cacheCreation;
        if (typeof evt.total_cost_usd === 'number') {
          session.costUSD = (session.costUSD ?? 0) + evt.total_cost_usd;
        } else {
          session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.model, {
            freshInputTokens: freshInput,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            outputTokens: outputTok,
          });
          session.costIsEstimated = true;
        }
        session.lastTurnContextTokens = inputTok;
        const modelEntries = evt.modelUsage ? Object.values(evt.modelUsage) : [];
        if (modelEntries.length > 0) {
          const primary = modelEntries.reduce((best, cur) => {
            const curTok = (cur.inputTokens ?? 0) + (cur.cacheReadInputTokens ?? 0) + (cur.cacheCreationInputTokens ?? 0);
            const bestTok = (best.inputTokens ?? 0) + (best.cacheReadInputTokens ?? 0) + (best.cacheCreationInputTokens ?? 0);
            return curTok > bestTok ? cur : best;
          });
          if (typeof primary.contextWindow === 'number') session.contextWindow = primary.contextWindow;
        }
      }
      if (evt.type === 'tool_use_blocked' || (evt.type === 'result' && evt.is_error && /permission|not allowed|denied/i.test(String(evt.error || '')))) {
        const reason = evt.tool_name
          ? `Blocked: ${evt.tool_name}${evt.error ? ` — ${evt.error}` : ''}`
          : String(evt.error || 'Permission denied');
        session.blockedReason = reason;
        session.status = 'waiting-input';
        flushSessionOutput(session, true);
        enqueueSessionWrite(session, async () => {
          await updateTaskWithHistory(taskId, {
            updatedBy: 'Agent',
            nextStatus: getConfig().requireInputStatus || 'Require Input',
            entries: [buildActivityEntry(`${session.label} blocked: ${reason}`, 'Agent', new Date().toISOString())],
          });
        });
      } else if (evt.type === 'result' && evt.is_error) {
        const errText = String(evt.error || evt.subtype || 'unknown');
        const resultText = typeof evt.result === 'string' ? evt.result : '';
        const combined = `${errText} ${resultText}`;
        const kind = dialect.classifyResultError?.(combined, evt.api_error_status);
        if (kind !== 'auth-expired') appendErrorToSession(session, `Agent error: ${errText}`);
        if (kind) session.terminalReason = kind;
        if (kind === 'auth-expired') dialect.onAuthExpired?.(session, taskId);
      }
    },
    onParseError: (trimmed) => {
      appendSessionOutput(session, trimmed, 'stdout', false);
    },
  });
}

export function claudeProgressLabel(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (toolName === 'Read' && typeof input.file_path === 'string') {
    return `Reading ${path.basename(input.file_path)}`;
  }
  if (toolName === 'Edit' && typeof input.file_path === 'string') {
    return `Editing ${path.basename(input.file_path)}`;
  }
  if (toolName === 'Write' && typeof input.file_path === 'string') {
    return `Writing ${path.basename(input.file_path)}`;
  }
  if (toolName === 'Bash' && input.command) {
    // One line, 80 chars: enough to tell `npm run check` from `git status` at a glance.
    const cmd = String(input.command).replace(/\s+/g, ' ').trim().slice(0, 80);
    return `Running: ${cmd}${cmd.length >= 80 ? '...' : ''}`;
  }
  return undefined;
}

export function grokProgressLabel(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const file = typeof input.target_file === 'string' ? input.target_file
    : typeof input.file_path === 'string' ? input.file_path
    : typeof input.path === 'string' ? input.path
    : undefined;
  if ((toolName === 'read_file' || toolName === 'list_dir') && file) {
    return `Reading ${path.basename(file)}`;
  }
  if ((toolName === 'write' || toolName === 'search_replace') && file) {
    return `${toolName === 'write' ? 'Writing' : 'Editing'} ${path.basename(file)}`;
  }
  if (toolName === 'run_terminal_command' && input.command) {
    const cmd = String(input.command).slice(0, 50);
    return `Running: ${cmd}${cmd.length >= 50 ? '...' : ''}`;
  }
  return undefined;
}
