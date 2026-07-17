import path from 'path';
import { getWorkspaceRoot } from './workspace.js';
import { taskWorktreeDir } from './task-worktree.js';

/**
 * FLUX-658: substrate vs projection split.
 *
 * The raw turn substrate (the append-only JSONL transcript, see transcript.ts) is the
 * immutable source of record. A *view* — what a human navigates on the board — is a
 * pure function of that substrate plus an append-only curation op-log:
 *
 *     view = projectTranscript(turns, ops?)
 *
 * This module owns the turn/message TYPES and the pure projector. It performs no IO —
 * `transcript.ts` reads the substrate (`readTurns`) and feeds the turns in here, proving
 * the rendered transcript is a function of the substrate rather than an independent store.
 *
 * The curation verbs (extract / merge / archive / board-rebase) are out of scope for
 * FLUX-658; only the seam they plug into is fixed here — `projectTranscript` already
 * accepts a trailing `ops` parameter (defaulting to empty) so the verbs land as op-log
 * appends without touching this call site. See
 * `.docs/event-horizon/architecture/substrate-vs-projection.md`.
 */

/** Coarse role classification of a turn's raw payload. */
export type TurnRole = 'user' | 'assistant' | 'system' | 'result' | 'tool' | 'unknown';

/**
 * A turn in the substrate, addressed by a stable `turnId` and a monotonic per-stream
 * `seq`. `raw` is the original stream-json / synthetic event, intact — the envelope only
 * adds identity around it. `turnId` is `${streamId}:${seq}`.
 */
export interface Turn {
  turnId: string;
  streamId: string;
  seq: number;
  ts: string;
  role: TurnRole;
  // Untyped stream-json/synthetic event payload, duck-typed via loose property access
  // throughout this file and transcript.ts; narrowing to `unknown` would require threading
  // discriminated-union types through both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

/**
 * FLUX-674: an image attached to a user chat turn (paste / drop / file picker). The bytes
 * live in the per-ticket asset sidecar (`<fluxDir>/assets/<id>/`); this is the durable
 * reference recorded on the user turn so the transcript re-renders the thumbnail after a
 * reload and the path stays resolvable for cold resume.
 */
export interface ChatAttachment {
  /** API URL to display the image (e.g. `/api/assets/FLUX-1/foo.png`). */
  url: string;
  /** Flux-dir-relative stored path (`assets/FLUX-1/foo.png`) — the engine resolves the
   *  absolute on-disk path from this to reference the file in the agent prompt. */
  path: string;
  fileName: string;
}

/** FLUX-849/FLUX-862: a dispatched session's lifecycle-marker stages, teed to the board as a
 *  `dispatch-activity` raw event (`teeDispatchActivityToBoard` in agents/claude-code.ts) and read
 *  back here at the projection boundary. Canonical here — this module owns the turn/message TYPES —
 *  and imported by claude-code.ts so the two sides can't drift apart into two hand-duplicated unions. */
export type DispatchLifecycle = 'started' | 'working' | 'completed' | 'failed' | 'cancelled' | 'waiting-input';

const DISPATCH_LIFECYCLES = new Set<string>([
  'started', 'working', 'completed', 'failed', 'cancelled', 'waiting-input',
] satisfies DispatchLifecycle[]);

/** Runtime guard for a raw (`unknown`/`any`) event's `lifecycle` field — the JSON round-trip through
 *  the transcript substrate erases its compile-time type, so `typeof === 'string'` alone would let
 *  any string widen into `TranscriptMessage['lifecycle']` unchecked. */
function isDispatchLifecycle(value: unknown): value is DispatchLifecycle {
  return typeof value === 'string' && DISPATCH_LIFECYCLES.has(value);
}

export interface TranscriptMessage {
  /** FLUX-745: `note` is a non-bubble system/automated row (rendered as a quiet chip, not a
   *  user/assistant bubble) — used for the resume-preamble "context update". */
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  ts: string;
  /** FLUX-745: subkind of a `note` row so the portal can pick the right chip.
   *  `'context-update'` = the warm-resume situational update (FLUX-655/FLUX-745);
   *  `'action'` = the pressed phase-launch action (FLUX-794, e.g. "▶ Implementation session started");
   *  `'permission'` = a gated-tool approval request/decision round-trip (FLUX-833);
   *  `'dispatch'` = a dispatched session's live activity teed to the board thread (FLUX-849). */
  kind?: 'context-update' | 'action' | 'permission' | 'dispatch';
  /** FLUX-849: on a `dispatch` note, the source ticket the dispatched session is working
   *  (e.g. `FLUX-849`) — the board chip labels/links the row to that ticket. */
  sourceTask?: string;
  /** FLUX-849: on a `dispatch` note, the session-lifecycle stage this row narrates. */
  lifecycle?: DispatchLifecycle;
  /** FLUX-865: on a `dispatch` note, the work phase the dispatched session is running. Mirrors the
   *  engine's `AgentSession.phase` union (models/agent.ts) so a drift surfaces as a compile error.
   *  Lets the board chip say *what kind* of session a row narrates (groom / impl / review / final),
   *  the biggest gap in the bare `<id> <stage>` row. */
  phase?: 'grooming' | 'implementation' | 'review' | 'finalize';
  /** FLUX-869: on a `dispatch` note, the dispatched session's start time (ISO). Lets the board chip
   *  derive run duration client-side — live-ticking `running Xm` while `working`, final `ran Xm` on
   *  terminal rows — without correlating start/end events. Absent on older rows (degrades to no
   *  duration token). */
  startedAt?: string;
  /** FLUX-661: normalized tool name for a tool row (e.g. `Edit`, `list_tickets`). */
  tool?: string;
  /** FLUX-661: repo-relative path of the file an edit-ish tool touched, when resolvable.
   *  Present only for `EDIT_TOOLS`; powers the expandable inline diff in the chat stream. */
  path?: string;
  /** FLUX-674: images attached to a user turn — rendered inline in the user bubble. */
  attachments?: ChatAttachment[];
  /** FLUX-688: per-edit line counts for an edit-ish tool row — how many lines *this* tool
   *  call added/removed (from a line-level diff of its own input, NOT the file's cumulative
   *  diff). Rendered as colored `+N −M` on the inline edit-diff row. */
  added?: number;
  removed?: number;
  /** FLUX-656: when this message's turn was carved from another stream (extract op), the
   *  source stream id (e.g. `__board__`). Present only on FOREIGN turns gathered into a
   *  card's view — set when `projectTranscript` is given a `homeStreamId` to compare against.
   *  Powers an "from the orchestrator" attribution badge; absent for native turns. */
  sourceStream?: string;
}

/** FLUX-661: file-mutating Claude Code tools whose rows get an expandable inline diff. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** FLUX-803: orchestration tools that spawn a subagent group. Their projected tool rows carry the
 *  normalized `tool` name so the chat can find the *spawn point* in the transcript and anchor the
 *  inline orchestration block there (the row itself is suppressed by the block). Only the
 *  group-forming delegate tools belong here: they auto-inherit the chat lead's `groupId` so the run
 *  resolves to a 2+ group. `start_session` is deliberately excluded — it spawns a standalone,
 *  ungrouped phase session (no `groupId`), so it never forms a group and tagging it would only
 *  suppress its transcript row with no block to stand in for it. */
// FLUX-882: `delegate` is the merged delegation tool. The old `delegate_to_agent` /
// `delegate_parallel` names are kept here for read-side projection of transcripts recorded
// before the merge — historical tool-call rows still anchor their orchestration block correctly.
const DELEGATION_TOOLS = new Set(['delegate', 'delegate_parallel', 'delegate_to_agent']);

/** FLUX-794: phase → chip label for the synthetic `action` turn recorded when a non-chat
 *  phase session is launched (the pressed Groom / Implement / Review / Finalize button). */
const PHASE_LABELS: Record<string, string> = {
  grooming: 'Grooming session started',
  implementation: 'Implementation session started',
  review: 'Review session started',
  finalize: 'Finalize session started',
};

/** FLUX-798: derive a clean one-line chip suffix from a launch `focus`. A plain phase-button
 *  press carries an empty focus, but a delegated/supervisor launch passes the `rosterContext`
 *  boilerplate (markdown headings, code-fenced `list_available_agents`, etc.). Take the first
 *  non-empty line and strip leading markdown markers so the chip reads as a clean single line
 *  instead of dumping raw, truncated markdown into the chat stream. */
function sanitizeActionFocus(focus: string): string {
  const firstLine = focus.split('\n').find((line) => line.trim()) ?? '';
  return firstLine
    .trim()
    .replace(/^#{1,6}\s+/, '') // ATX heading markers
    .replace(/^[-*+]\s+/, '') // list bullets
    .replace(/`/g, '') // inline code backticks
    .replace(/^\*\*|\*\*$/g, '') // wrapping bold
    .trim();
}

/** Minimal shape of a Claude Code SDK `tool_use` content block, as read by the projector.
 *  `raw` payloads are untyped JSON off the wire, so every field is optional/unknown until
 *  narrowed at the point of use. */
interface ToolUseBlock {
  name?: unknown;
  input?: Record<string, unknown>;
}

/** Normalize a tool_use block's name, unwrapping the `mcp__server__tool` prefix. */
function normalizeToolName(block: ToolUseBlock | undefined): string {
  let name = String(block?.name || 'tool');
  const m = name.match(/^mcp__.+?__(.+)$/); // mcp__event-horizon__list_tickets -> list_tickets
  if (m && m[1]) name = m[1];
  return name;
}

/**
 * FLUX-661/1473: resolve an absolute path a tool_use block carries (edit-tool `file_path`, but
 * also the `file_path`/`path`/`notebook_path` any other tool reports) into a repo-relative POSIX
 * path (the shape `fetchDiffFile` / git expect, and what the portal renders instead of the raw
 * absolute worktree prefix). Edits land in either the main worktree or the ticket's task
 * worktree; both mirror the same tree, so the relative path is identical regardless of which root
 * the session ran in. We match the absolute path against both candidate roots (longest prefix
 * wins) and relativize. Returns undefined when the path is empty or sits under neither root (then
 * the caller falls back to the raw string).
 */
function relativizePath(filePath: unknown, taskId: string): string | undefined {
  if (typeof filePath !== 'string' || !filePath.trim()) return undefined;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return undefined;
  const abs = path.resolve(filePath);
  const roots = [taskWorktreeDir(workspaceRoot, taskId), workspaceRoot];
  const onWin = process.platform === 'win32';
  const norm = (p: string) => (onWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  const absKey = norm(abs);
  let best: string | undefined;
  let bestLen = -1;
  for (const root of roots) {
    const rootKey = norm(root);
    const under = absKey === rootKey || absKey.startsWith(rootKey + path.sep);
    if (under && rootKey.length > bestLen) {
      bestLen = rootKey.length;
      best = path.relative(path.resolve(root), abs);
    }
  }
  if (best === undefined || best === '' || best.startsWith('..')) return undefined;
  return best.split(path.sep).join('/');
}

/**
 * FLUX-688: split a string into content lines for line-counting. Empty string → 0 lines; a
 * single trailing newline is ignored (so `"a\nb\n"` is two lines, not three) — otherwise every
 * newline-terminated block would over-count by one.
 */
function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** FLUX-688: length of the longest common subsequence of two line arrays (classic O(m·n) DP).
 *  Edit blocks are small, so the quadratic table is fine. */
function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/** FLUX-688: line-level added/removed between two strings via LCS — editing one line inside a
 *  5-line block reports `+1 −1`, not `+5 −5`. Non-string inputs count as empty. */
function diffStat(oldStr: unknown, newStr: unknown): { added: number; removed: number } {
  const a = splitLines(typeof oldStr === 'string' ? oldStr : '');
  const b = splitLines(typeof newStr === 'string' ? newStr : '');
  const lcs = lcsLength(a, b);
  return { added: b.length - lcs, removed: a.length - lcs };
}

/**
 * FLUX-688: per-edit line counts for an edit-ish tool_use block, derived from the tool's own
 * input (not the file's cumulative diff). `Edit` = line diff of `old_string`→`new_string`;
 * `MultiEdit` = summed over `edits[]`; `Write`/`NotebookEdit` = `+<content lines> −0` (no prior
 * content available in the tool input). Note: `Edit` with `replace_all` matching multiple sites
 * is counted once (single old→new block) → under-counts; acceptable for v1.
 */
function editLineStat(block: ToolUseBlock | undefined): { added: number; removed: number } {
  const name = normalizeToolName(block);
  const input = block?.input || {};
  if (name === 'Edit') return diffStat(input.old_string, input.new_string);
  if (name === 'MultiEdit') {
    let added = 0;
    let removed = 0;
    if (Array.isArray(input.edits)) {
      for (const e of input.edits) {
        // Each edit entry is itself an untyped JSON object — narrow before reading its fields.
        const edit = e && typeof e === 'object' ? (e as Record<string, unknown>) : undefined;
        const s = diffStat(edit?.old_string, edit?.new_string);
        added += s.added;
        removed += s.removed;
      }
    }
    return { added, removed };
  }
  if (name === 'Write') return { added: splitLines(String(input.content ?? '')).length, removed: 0 };
  if (name === 'NotebookEdit') return { added: splitLines(String(input.new_source ?? '')).length, removed: 0 };
  return { added: 0, removed: 0 };
}

/**
 * A curation op — an append-only structuring operation over the substrate (turn→ticket
 * membership, extract, merge, archive). FLUX-658 fixes only the SEAM: the verbs that
 * produce/consume these land in separate tickets. The shape is intentionally open here.
 */
export interface CurationOp {
  op: string;
  ts?: string;
  [key: string]: unknown;
}

/** Classify a raw event into a coarse turn role (envelope metadata; ordering is by seq).
 *  `raw` is the untyped substrate payload (JSON off the wire, or a synthetic event) — narrow
 *  it defensively before reading `.type` rather than assuming it's an object. */
export function classifyRole(raw: unknown): TurnRole {
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).type : undefined;
  if (t === 'user' || t === 'ask-answer' || t === 'permission-resolved') return 'user';
  if (t === 'assistant' || t === 'ask-question' || t === 'permission-request') return 'assistant';
  if (t === 'system') return 'system';
  if (t === 'result') return 'result';
  if (t === 'tool' || t === 'tool_use' || t === 'tool_result') return 'tool';
  return 'unknown';
}

/** Friendly one-line label for a tool_use block ("watch it work"). */
function toolLabel(block: ToolUseBlock | undefined, taskId: string): string {
  const name = normalizeToolName(block);
  const input = block?.input || {};
  const pathHint = input.file_path ?? input.notebook_path ?? input.path;
  const hint = input.ticketId ?? input.id ?? input.newStatus ?? pathHint ?? input.command ?? input.query;
  let hintStr = '';
  if (hint != null) {
    // FLUX-1473: when the hint IS one of the path fields, render it repo-relative instead of
    // the raw absolute worktree path — the portal renders this text directly (`ToolRow`), so an
    // absolute `C:\GitHub\.eh-worktrees\...` prefix otherwise eats the whole truncated row.
    // Uncapped (unlike the generic 48-char slice below): the portal elides long paths itself
    // while keeping the basename intact, so a hard server-side cut would defeat that.
    const rel = hint === pathHint && typeof hint === 'string' ? relativizePath(hint, taskId) : undefined;
    hintStr = rel ?? String(hint).replace(/\s+/g, ' ').slice(0, 48);
  }
  return hintStr ? `${name} · ${hintStr}` : name;
}

/** FLUX-674: runtime guard for a raw attachment entry off a user turn's `attachments[]` —
 *  narrows to the fields `ChatAttachment` actually needs before they're read. */
function isRawImageAttachment(a: unknown): a is { url: string; path: string; fileName?: unknown } {
  if (!a || typeof a !== 'object') return false;
  const rec = a as Record<string, unknown>;
  return typeof rec.url === 'string' && typeof rec.path === 'string';
}

/** Minimal shape of one entry in an `ask-question` event's `questions[]` (structured HITL prompt). */
interface RawQuestion {
  header?: unknown;
  question?: unknown;
  options?: unknown;
}

/** Minimal shape of one `options[]` entry within a `RawQuestion`. */
interface RawQuestionOption {
  label?: unknown;
}

/**
 * Re-derive the ordered chat messages for the portal from turns alone. Turn order is
 * `seq` (the substrate is append-only and chronological), so we preserve it rather than
 * sorting — assistant stream-json events don't carry a reliable timestamp. User turns
 * come from synthetic `{ type: 'user' }` events; assistant events yield a 'text' message
 * per text block and a 'tool' message per tool_use block (so the user watches the agent
 * check the board / act). Empty thinking blocks, system, and result events are skipped.
 *
 * `ops` is the append-only curation op-log (FLUX-656 extract / FLUX-657 merge). The reader
 * (`readTranscriptMessages`) resolves the cross-stream gather BEFORE calling here — it reads
 * the op-log and prepends any extracted slice turns (which keep their own `streamId`) — so
 * this projector stays PURE over the turn list it is handed. `ops` is still passed through
 * for op kinds that affect rendering directly; today none do, so it is reserved.
 *
 * `homeStreamId` (FLUX-656): when set, any turn whose `streamId` differs from it is a FOREIGN
 * turn gathered from another stream by an extract op; its projected messages carry
 * `sourceStream` for an attribution badge. Omit it (the default) for a single-stream view and
 * no message is tagged — fully backward compatible.
 */
export function projectTranscript(
  turns: Turn[],
  _ops: CurationOp[] = [],
  homeStreamId?: string,
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const tag = (msg: TranscriptMessage, turn: Turn): TranscriptMessage => {
    if (homeStreamId !== undefined && turn.streamId !== homeStreamId) msg.sourceStream = turn.streamId;
    return msg;
  };
  for (const turn of turns) {
    const evt = turn.raw;
    if (evt?.type === 'user' && typeof evt.text === 'string') {
      const msg: TranscriptMessage = { role: 'user', text: evt.text, ts: typeof evt.timestamp === 'string' ? evt.timestamp : '' };
      // FLUX-674: carry pasted-image refs onto the user turn so the bubble renders them
      // inline on reload / cold resume. Defensively filter to well-formed entries.
      if (Array.isArray(evt.attachments)) {
        const atts: ChatAttachment[] = (evt.attachments as unknown[])
          .filter(isRawImageAttachment)
          .map((a) => ({ url: a.url, path: a.path, fileName: typeof a.fileName === 'string' ? a.fileName : 'image' }));
        if (atts.length) msg.attachments = atts;
      }
      out.push(tag(msg, turn));
    } else if (evt?.type === 'resume-preamble' && typeof evt.text === 'string' && evt.text.trim()) {
      // FLUX-745: the warm-resume situational update (FLUX-655). It is NOT a chat bubble — emit a
      // non-bubble `note` row so the portal can render it as a subtle "⟳ context update" chip. The
      // event already carries its own `text` + `timestamp` (pure projection, no schema change).
      const ts = typeof evt.timestamp === 'string' ? evt.timestamp : turn.ts;
      out.push(tag({ role: 'note', kind: 'context-update', text: evt.text, ts }, turn));
    } else if (evt?.type === 'action' && typeof evt.phase === 'string') {
      // FLUX-794: the user pressed a non-chat phase action (Groom / Implement / Review / Finalize)
      // and the chat popped in. Emit a non-bubble `note` row so the portal renders it as a quiet
      // "▶ <phase> session started" chip, in chronological order before the agent's first response.
      // Like the resume-preamble note, it is display-only (no token/turn accounting, no "user replied").
      const label = PHASE_LABELS[evt.phase] ?? 'Session started';
      // FLUX-798: sanitize the focus to a clean single line — a delegated launch carries the
      // multi-line `rosterContext` markdown blob, which would otherwise dump into the chip.
      const focus = typeof evt.focus === 'string' ? sanitizeActionFocus(evt.focus) : '';
      const text = focus ? `${label} — ${focus}` : label;
      const ts = typeof evt.timestamp === 'string' ? evt.timestamp : turn.ts;
      out.push(tag({ role: 'note', kind: 'action', text, ts }, turn));
    } else if (evt?.type === 'ask-question' && Array.isArray(evt.questions)) {
      // FLUX-662: an agent asked the user a structured question. Render it as an assistant
      // turn so a cold resume shows the question that was posed.
      const ts = typeof evt.timestamp === 'string' ? evt.timestamp : '';
      const md = evt.questions
        .map((q: RawQuestion) => {
          const opts = Array.isArray(q.options)
            ? q.options.map((o: RawQuestionOption) => `- ${o?.label ?? ''}`).join('\n')
            : '';
          return `**${q?.header || 'Question'}** — ${q?.question ?? ''}\n${opts}`;
        })
        .join('\n\n');
      out.push(tag({ role: 'assistant', text: `❓ ${md}`, ts }, turn));
    } else if (evt?.type === 'ask-answer') {
      // FLUX-662: the user's answer to a structured question. Render as a user turn so the
      // resolved selection is visible in history alongside the question above.
      const ts = typeof evt.timestamp === 'string' ? evt.timestamp : '';
      if (evt.unanswered) {
        out.push(tag({ role: 'user', text: '_(no answer — the question timed out)_', ts }, turn));
      } else {
        const picks = Object.values(evt.answers || {})
          .map((a: unknown) => (Array.isArray(a) ? a.join(', ') : String(a)))
          .filter((s) => s.trim());
        const note = typeof evt.notes === 'string' && evt.notes.trim() ? ` — ${evt.notes.trim()}` : '';
        out.push(tag({ role: 'user', text: `✔ ${picks.join(' · ')}${note}`.trim(), ts }, turn));
      }
    } else if (evt?.type === 'permission-request' && typeof evt.toolName === 'string') {
      // FLUX-833: an agent's gated tool call parked for human approval. It's an operational
      // round-trip, not a conversational turn, so render a quiet non-bubble `note` chip (like
      // the resume-preamble / action notes) rather than an assistant bubble — enough for a cold
      // resume to see that approval was requested for which tool.
      const ts = typeof evt.timestamp === 'string' ? evt.timestamp : turn.ts;
      out.push(tag({ role: 'note', kind: 'permission', text: `🔒 Approval requested · ${evt.toolName}`, ts }, turn));
    } else if (evt?.type === 'permission-resolved') {
      // FLUX-833: the decision (or timeout) that settled a parked approval. `behavior` is
      // 'allow' | 'deny'; a `reason: 'timeout'` deny is the auto-deny that also raised needsAction.
      const ts = typeof evt.timestamp === 'string' ? evt.timestamp : turn.ts;
      const allowed = evt.behavior === 'allow';
      const timedOut = evt.reason === 'timeout';
      const text = allowed
        ? '✅ Approval granted'
        : timedOut
          ? '⛔ Approval timed out — denied'
          : '⛔ Approval denied';
      out.push(tag({ role: 'note', kind: 'permission', text, ts }, turn));
    } else if (evt?.type === 'dispatch-activity' && typeof evt.text === 'string' && evt.text.trim()) {
      // FLUX-849: a dispatched (unattended, work-phase) session's live activity teed to the board
      // orchestrator thread. Render as a quiet non-bubble `note` chip so a user watching the board
      // sees the in-flight narration + lifecycle (started / working / needs-input / completed /
      // failed) without opening the ticket — and so board cold-resume drops it as a note row,
      // keeping the orchestrator's own dialogue context clean.
      const ts = typeof evt.timestamp === 'string' ? evt.timestamp : turn.ts;
      const msg: TranscriptMessage = { role: 'note', kind: 'dispatch', text: evt.text, ts };
      if (typeof evt.sourceTask === 'string') msg.sourceTask = evt.sourceTask;
      // FLUX-862: validate against the actual DispatchLifecycle members, not just "is a string" —
      // a malformed/unexpected value now degrades to "no lifecycle" instead of silently widening in.
      if (isDispatchLifecycle(evt.lifecycle)) msg.lifecycle = evt.lifecycle;
      // FLUX-865: the tee already emits `phase` (claude-code.ts teeDispatchActivityToBoard); copy it
      // through so the chip can label the row's phase. Degrades to no phase label when absent.
      if (typeof evt.phase === 'string') msg.phase = evt.phase;
      // FLUX-869: pass the session start through so the chip can derive run duration. Degrades to
      // no duration token when absent (older rows / paths that left startedAt undefined).
      if (typeof evt.startedAt === 'string') msg.startedAt = evt.startedAt;
      out.push(tag(msg, turn));
    } else if (evt?.type === 'assistant.message') {
      // FLUX-969: Copilot CLI's message event (its streaming deltas are excluded from the tee in
      // copilot.ts, so this is the only place its assistant text ever appears). Distinct from
      // Claude's `assistant` + `message.content[]` schema below and Gemini's native `message`/`role`
      // schema below that — each CLI's stdout parser (attachStdoutProcessing) already knows its own
      // schema for live activity; this is the equivalent knowledge for the durable, schema-agnostic
      // transcript render. Tool calls (`assistant.tool_call*`) are not yet rendered here.
      //
      // Copilot narration lands in TWO fields, and the original FLUX-969 render read only the first,
      // so on a tool-heavy turn most narration silently vanished from the chat while still showing in
      // the history/progress video (the live delta stream feeds both):
      //   - `data.reasoningText` — the model's inter-tool narration ("Let me look at …"). This is the
      //     ONLY text on a tool-call turn (where `data.content` is ''), which is the common case.
      //   - `data.content` — the final reply text (present on terminal / non-tool messages).
      // Render reasoning first (it precedes the action), then content, so the chat matches the
      // activity feed. Both may be present on one message (a lead-in + its reasoning); emit each.
      const reasoning = typeof evt.data?.reasoningText === 'string' ? evt.data.reasoningText.trim() : '';
      const content = typeof evt.data?.content === 'string' ? evt.data.content.trim() : '';
      if (reasoning) out.push(tag({ role: 'assistant', text: reasoning, ts: turn.ts }, turn));
      if (content) out.push(tag({ role: 'assistant', text: content, ts: turn.ts }, turn));
    } else if (evt?.type === 'message' && evt.role === 'assistant' && typeof evt.content === 'string' && evt.content.trim()) {
      // FLUX-969: Gemini CLI's native assistant-message schema (its "Claude Code schema" fallback
      // path already renders via the branch below, since it's the same shape as Claude's). Tool
      // calls (`tool_use`) are not yet rendered here — same scoping note as Copilot above.
      out.push(tag({ role: 'assistant', text: evt.content, ts: turn.ts }, turn));
    } else if (evt?.type === 'assistant' && Array.isArray(evt.message?.content)) {
      for (const b of evt.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push(tag({ role: 'assistant', text: b.text, ts: turn.ts }, turn));
        } else if (b?.type === 'tool_use') {
          const msg: TranscriptMessage = { role: 'tool', text: toolLabel(b, turn.streamId), ts: turn.ts };
          // FLUX-661: for edit-ish tools, attach the normalized name + repo-relative path so
          // the portal can render an expandable inline diff for that file. Other tools stay
          // label-only. The turn's streamId is the taskId the session ran under.
          const name = normalizeToolName(b);
          if (EDIT_TOOLS.has(name)) {
            // FLUX-688: per-edit counts come from the tool input, so compute them regardless of
            // path resolution; they only render on the diff row (which also needs `path`).
            const { added, removed } = editLineStat(b);
            msg.added = added;
            msg.removed = removed;
            const rel = relativizePath(b?.input?.file_path ?? b?.input?.notebook_path, turn.streamId);
            if (rel) {
              msg.tool = name;
              msg.path = rel;
            }
          } else if (DELEGATION_TOOLS.has(name)) {
            // FLUX-803: tag the spawn-point row (no `path`, so it stays a plain row — the chat
            // suppresses it and renders the inline orchestration block in its place).
            msg.tool = name;
          }
          out.push(tag(msg, turn));
        }
      }
    }
  }
  return out;
}
