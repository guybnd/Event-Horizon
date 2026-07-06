// FLUX-959: the generic board-orchestrator core. Everything here takes ZERO framework args —
// prompt assembly, cold/warm resume re-prime, digest prepend, transcript events, the exit-state
// machine, and status transitions are identical regardless of which CLI is spawned underneath.
// Only the per-CLI arg list / spawn / stdout-parse differ — those come from a `BoardSpec`
// (board.ts) passed into `makeBoardAdapter`. Lifted out of claude-board.ts, which is now just
// the Claude `BoardSpec`.
import type { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { configCache } from '../config.js';
import { broadcastEvent } from '../events.js';
import { appendTranscriptEvent } from '../transcript.js';
import { generateOrchestratorReplyNotification } from '../notifications.js';
import { buildBoardDigest } from '../board-digest.js';
import { buildResumePreamble } from '../resume-preamble.js';
import { buildBoardReprime } from '../board-reprime.js';
import { workspaceRoot as canonicalWorkspaceRoot } from '../workspace.js';
import type { CliSessionRecord, SendInputOptions } from './types.js';
import { checkBinaryInstalled, appendSessionOutput, flushSessionOutput, resolveAttachmentAbsPaths, attachmentReadInstruction } from './shared.js';
import { BOARD_CONVERSATION_ID, type BoardAdapter, type BoardSpec } from './board.js';

// FLUX-1175: the default identity block, extracted to a function of the project key so a
// persona-primed board turn (e.g. the Smelter, launched from the Furnace drawer) can swap in
// its own resolved prompt instead (see the `identity` param on buildBoardPrompt below).
function defaultBoardIdentity(key: string): string {
  return [
    'You are the Event Horizon board orchestrator — a persistent chat for the whole board, not tied to any single ticket. You are powerful: you have the full "event-horizon" MCP toolset (list/get/create/update tickets, change_status, branches, comments, …) plus file reading, editing, bash, and subagents. Use whatever the task genuinely calls for.',
    '',
    'Match the weight of your response to the weight of the request. For a greeting or a simple question, just reply in a sentence or two — don\'t go investigate. When a task actually needs depth — reasoning across the board, doing real work on a ticket, parallel research — bring your full toolkit to bear, including subagents. Quick for quick, thorough for thorough: don\'t gather context you don\'t need, and don\'t skimp on work that does.',
    'For board and ticket actions, prefer the event-horizon MCP tools over editing ticket files by hand.',
    'When the user asks to GROOM, IMPLEMENT, REVIEW, or FINALIZE a specific ticket, DISPATCH it rather than doing that ticket\'s work here: call start_session(ticketId, phase) to launch the phase session on that ticket (it runs in the ticket\'s own scope and returns immediately), then tell the user to open that ticket\'s chat to drive it.',
    'Propose and CONFIRM before anything destructive or irreversible (status changes, deletions). Don\'t silently restructure the board.',
    'BOARD-REBASE RITUAL: when asked to triage, "rebase the board", or at the end of a session, do NOT mutate the board directly — call propose_board_rebase with a BATCH of items so the user approves/rejects them in one pass. Each item is { kind, targets, summary, rationale }, kind ∈ promote (extract a chat/turns into a new card) · fold (merge a stream into another) · archive (retire) · dispatch (start a phase session) · status (move a ticket) · leave (keep it in this thread). The restructuring verbs (extract_ticket, merge_tickets, archive) and change_status are GATED — reorganize the board through proposals, not direct calls. When unsure about an item, propose it as "leave" (it stays in this durable thread) — never drop it.',
    'To ask the user a structured question, call the ask_user_question tool — it shows an interactive picker in this chat and returns their choice so you continue the same turn. Never assume when a quick question would resolve ambiguity; ask.',
    `When you reference a ticket in prose, always write its full id (e.g. \`${key}-123\`) — every single time, including repeat mentions, shorthand lists, and x/y comparisons. Never abbreviate to a bare number (a bare \`123\` cannot render as a chip). The full id renders as an interactive chip; on first mention spell out the title too — \`${key}-123 (short title)\` — to keep the message readable before the reader hovers.`,
    'You run at the workspace root, with the whole board in scope.',
  ].join('\n');
}

export function buildBoardPrompt(firstMessage: string, priorContext?: string, identity?: string): string {
  const key = configCache.projects?.[0] || 'PROJECT';
  const digest = buildBoardDigest();
  return [
    identity ?? defaultBoardIdentity(key),
    '',
    // FLUX-838: cold-resume re-prime — recovered prior dialogue (+ working-tree preamble) after an
    // engine restart wiped the in-memory session. Ordered before the live digest, mirroring the
    // warm-resume path in sendBoardInput (preamble first, then digest, then the message).
    ...(priorContext ? [priorContext, ''] : []),
    ...(digest ? [digest, ''] : []),
    firstMessage,
  ].join('\n');
}

// `proc` here is the AWAITED spawn result (a plain ChildProcess), not `ReturnType<typeof spec.spawn>`
// itself — that type is now `ChildProcess | Promise<ChildProcess>` since FLUX-1003 made the
// Claude/Gemini BoardSpec.spawn implementations async (they resolve a cached binary path first).
function wireBoardProc(spec: BoardSpec, proc: ReturnType<typeof spawn>, session: CliSessionRecord, onExitStatus: () => void) {
  session.proc = proc as ChildProcessWithoutNullStreams;
  session.pid = proc.pid;
  const commitPending = spec.attachStdout(proc, session, BOARD_CONVERSATION_ID);
  proc.stderr!.on('data', (chunk) => appendSessionOutput(session, chunk, 'stderr', false));
  proc.on('error', (error) => {
    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    commitPending();
    flushSessionOutput(session, true);
    console.error('[board] spawn error:', error.message);
  });
  proc.on('exit', (code) => {
    commitPending();
    flushSessionOutput(session, true);
    // Only a CLEAN turn becomes the resumable parked state (waiting-input). A turn that the
    // user stopped or that exited non-zero (crashed before ever replying) must end TERMINAL —
    // otherwise it sits at waiting-input forever, "active" enough to 409 every new start,
    // permanently wedging the orchestrator (FLUX-667).
    if (session.requestedStop) {
      session.status = 'cancelled';
      session.endedAt = new Date().toISOString();
    } else if (code !== 0) {
      session.status = 'failed';
      session.endedAt = new Date().toISOString();
    } else {
      // FLUX-987 (B4): code===0 means the CLI replied even if it never emitted a resumeSessionId
      // this turn (gemini-only — copilot has a dual capture site; the transcript write earlier in
      // the turn is unconditional, so chat already shows the reply regardless). Don't classify
      // this 'failed' — that both suppressed the notification below AND left the session
      // unresumable-yet-"active", 409-ing every later /input. Parking it 'waiting-input' exactly
      // like the fully-successful path reuses the /start route's existing FLUX-667 self-heal: the
      // next turn sees no resumeSessionId, so buildArgs cold-starts instead of resuming.
      if (!session.resumeSessionId) {
        console.error(`[board] clean exit (code 0) but no resumeSessionId captured this turn — next turn will cold-start instead of resuming`);
      }
      onExitStatus();
      // FLUX-810: a clean board turn === the orchestrator answered the user. This is the only
      // self-noise-free hook (stopped/non-zero/crashed turns are handled above), so emit the
      // "Orchestrator replied" notification-bar entry here and nowhere else.
      generateOrchestratorReplyNotification();
    }
    broadcastEvent('taskUpdated', { id: BOARD_CONVERSATION_ID });
  });
}

async function startBoardSession(spec: BoardSpec, session: CliSessionRecord, firstMessage: string, workspaceRoot: string, opts?: SendInputOptions) {
  await checkBinaryInstalled(spec.binary);
  session.executionRoot = workspaceRoot;
  // FLUX-579: ensure the workspace-root shared server(s) exist before building the board MCP config
  // (Claude-only today — other frameworks load MCP from workspace .mcp.json, see BoardSpec.ensureMcp).
  if (spec.ensureMcp) await spec.ensureMcp(workspaceRoot);
  // FLUX-838: cold-resume re-prime. The CLI session store is in-memory only, so an engine
  // restart leaves an empty store and this start path runs with no `--resume`. Recover the
  // orchestrator's memory from the durable `__board__.jsonl` transcript: a bounded verbatim
  // tail of the prior dialogue, plus the working-tree situational update. Computed BEFORE this
  // turn's `user` event is appended (below) so the just-sent message can't leak into the
  // "prior" digest. A fresh / post-reset board (FLUX-659) yields null → no re-prime block.
  const reprime = await buildBoardReprime();
  let resumePreamble: string | null = null;
  if (reprime) {
    // sinceIso from the last prior transcript turn's ts — the in-memory lastOutputAt is gone
    // after restart. Board scope has no branch → preamble degrades to ticket-movement only.
    resumePreamble = await buildResumePreamble({
      workspaceRoot: canonicalWorkspaceRoot ?? workspaceRoot,
      sinceIso: reprime.sinceIso,
    });
  }
  const priorContext = [resumePreamble, reprime?.digest].filter(Boolean).join('\n\n---\n\n') || undefined;
  // FLUX-676: pasted-image attachments on the opening orchestrator turn. Reference their
  // absolute sidecar paths in the spawn prompt (the agent Reads them); keep the clean refs
  // for the transcript so the bubble re-renders the thumbnail on reload / cold resume.
  const attachments = opts?.attachments ?? [];
  const attachmentAbsPaths = resolveAttachmentAbsPaths(attachments);
  const prompt = `${buildBoardPrompt(firstMessage, priorContext, opts?.personaPrompt)}${attachmentReadInstruction(attachmentAbsPaths)}`;
  const args = await spec.buildArgs({ session, prompt, workspaceRoot, executionRoot: workspaceRoot, isResume: false });
  session.status = 'running';
  session.args = args;
  // FLUX-838: persist the working-tree preamble as a context-update note (mirrors the warm-resume
  // path in sendBoardInput), ordered ahead of this turn's user event so it renders before the
  // bubble. The re-prime dialogue digest is NOT appended — it is recovered from the transcript,
  // and re-appending it would compound across successive restarts (criterion 6).
  if (resumePreamble) {
    appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'resume-preamble', text: resumePreamble, timestamp: session.startedAt });
  }
  // First turn: record the user message in the transcript (mirrors the per-ticket chat /start).
  appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'user', text: firstMessage, attachments, timestamp: session.startedAt });
  const proc = await spec.spawn(args, workspaceRoot);
  // Persistent conversation: a finished turn stays RESUMABLE (waiting-input), never
  // terminal. If it ended 'completed', the next message would spawn a fresh session
  // with no memory of this one (it wouldn't know about a ticket it just created).
  wireBoardProc(spec, proc, session, () => { session.status = 'waiting-input'; });
}

async function sendBoardInput(spec: BoardSpec, session: CliSessionRecord, message: string, workspaceRoot: string, opts?: SendInputOptions) {
  await checkBinaryInstalled(spec.binary);
  const inputAt = new Date().toISOString();
  // FLUX-655: capture the "since you last spoke" basis BEFORE overwriting lastInputAt (see the
  // per-ticket path). Board scope has no branch, so the preamble degrades to ticket-movement only.
  const sinceIso = session.lastOutputAt ?? session.lastInputAt;
  session.lastInputAt = inputAt;
  session.status = 'running';
  session.pausedForInput = false;
  // FLUX-915: clear any stale stop flag before resuming (see sendCliSessionInput) — the board
  // session record is reused across turns, so a sticky requestedStop would mis-cancel a clean turn.
  session.requestedStop = false;
  // FLUX-676: pasted-image attachments for this turn. Resolve to absolute sidecar paths the
  // agent can Read; keep the metadata on the transcript turn so the bubble re-renders.
  const attachments = opts?.attachments ?? [];
  const attachmentAbsPaths = resolveAttachmentAbsPaths(attachments);
  // FLUX-655: on a RESUMED board turn, build the situational update (ticket-movement only at board
  // scope). Computed BEFORE the user event is recorded so the `resume-preamble` transcript event is
  // ordered ahead of the `user` event for this turn (FLUX-716 item 3). Best-effort: a null assemble
  // (no delta / git hiccup) is a no-op.
  let resumePreamble: string | null = null;
  if (session.resumeSessionId) {
    resumePreamble = await buildResumePreamble({
      workspaceRoot: canonicalWorkspaceRoot ?? workspaceRoot,
      sinceIso,
    });
    if (resumePreamble) {
      appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'resume-preamble', text: resumePreamble, timestamp: inputAt });
    }
  }
  appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'user', text: message, attachments, timestamp: inputAt });
  // Effective prompt to the CLI = the user's text + a Read-the-image instruction (FLUX-676).
  const safeMessage = `${message.replace(/\0/g, '')}${attachmentReadInstruction(attachmentAbsPaths)}`;
  // Prepend the fresh triage digest to the prompt sent to the CLI — NOT to the transcript above,
  // which keeps the user's verbatim message (FLUX-659 push half).
  const digest = buildBoardDigest();
  let promptForCli = digest ? `${digest}\n\n${safeMessage}` : safeMessage;
  // FLUX-655: prepend the situational update (computed above) — same contract as the per-ticket chat.
  if (resumePreamble) {
    promptForCli = `${resumePreamble}\n\n---\n\n${promptForCli}`;
  }
  // FLUX-579: ensure the workspace-root shared server(s) exist for this board turn.
  if (spec.ensureMcp) await spec.ensureMcp(workspaceRoot);
  const args = await spec.buildArgs({ session, prompt: promptForCli, workspaceRoot, executionRoot: session.executionRoot ?? workspaceRoot, isResume: true });
  session.args = args;
  const proc = await spec.spawn(args, session.executionRoot ?? workspaceRoot);
  wireBoardProc(spec, proc, session, () => { session.status = 'waiting-input'; });
}

export function makeBoardAdapter(spec: BoardSpec): BoardAdapter {
  return {
    startBoardSession: (session, firstMessage, workspaceRoot, opts) => startBoardSession(spec, session, firstMessage, workspaceRoot, opts),
    sendBoardInput: (session, message, workspaceRoot, opts) => sendBoardInput(spec, session, message, workspaceRoot, opts),
  };
}
