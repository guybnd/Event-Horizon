import { tailTranscriptMessages, type TranscriptMessage } from './transcript.js';

/**
 * FLUX-838: board cold-resume re-prime.
 *
 * The board orchestrator is a persistent chat for the whole board, but the CLI session store
 * is in-memory only — an engine restart wipes the board's `claudeSessionId`, so the next turn
 * cold-starts a fresh `claude` with no `--resume` and no memory of the prior conversation. The
 * durable `__board__.jsonl` transcript is the orchestrator's only memory; this helper feeds a
 * bounded tail of it back into the spawn prompt so the revived orchestrator can honor the
 * commitments it made before the restart.
 *
 * Standalone + side-effect-free (mirrors `resume-preamble.ts` / `board-digest.ts`) so it is
 * unit-testable in isolation. It never appends to the transcript — the re-prime is read-only.
 */

// Board sentinel stream id. Kept as a local literal (not imported from `claude-code.ts`) to
// avoid a circular import; mirrors the parallel `BOARD_CONVERSATION_ID` in claude-code.ts /
// portal api.ts.
const BOARD_CONVERSATION_ID = '__board__';

// One-time-per-session-lifecycle budget — this fires at most once when a cold board session
// starts, so a generous verbatim tail is affordable. Too small loses commitments; too large
// eats the orchestrator's working context.
const MAX_CHARS = 10_000;
const MAX_TURNS = 12;
// Per-turn clip so a single very long orchestrator message can't blow the whole budget.
const MAX_TURN_CHARS = 4_000;
// FLUX-856: bound the transcript READ to this many trailing turns before projecting, so a
// cold board start never reads/projects the whole (unbounded) `__board__.jsonl`. Set well
// above MAX_TURNS so the window reliably still contains the ~12 dialogue turns the digest
// emits even when the tail is dominated by tool / system turns (which the digest drops).
const MAX_READ_TURNS = 200;

/** Neutralize fence runs so a turn containing ``` can't break out of the synthetic fence
 *  (same idea as `sanitizeForFence` in resume-preamble.ts). */
function sanitizeForFence(s: string): string {
  return s.replace(/`/g, "'");
}

function clip(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_TURN_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TURN_CHARS)} … (turn truncated)`;
}

export interface BoardReprime {
  /** The fenced `prior-conversation` block to prepend to the orchestrator spawn prompt. */
  digest: string;
  /** ISO `ts` of the last prior transcript turn — the "since you last spoke" basis for
   *  `buildResumePreamble` after a restart wiped the in-memory `lastOutputAt`. */
  sinceIso: string;
}

/**
 * Build a bounded re-prime of the prior board dialogue, or `null` when there is nothing to
 * recover (fresh board, or post-reset board after `clearTranscript` — FLUX-659 stays a clean
 * slate). Best-effort: a transcript read hiccup yields `null` and the board start proceeds.
 */
export async function buildBoardReprime(): Promise<BoardReprime | null> {
  try {
    const messages = await tailTranscriptMessages(BOARD_CONVERSATION_ID, MAX_READ_TURNS);
    if (messages.length === 0) return null;

    // Drop `tool` / `note` rows — they carry little dialogue value and waste budget.
    const dialogue = messages.filter((m: TranscriptMessage) => m.role === 'user' || m.role === 'assistant');
    if (dialogue.length === 0) return null;

    // sinceIso = the last prior turn's ts overall (most-recent board activity), not just the
    // last dialogue row — best basis for "what moved since you last spoke".
    const sinceIso = messages[messages.length - 1]!.ts || dialogue[dialogue.length - 1]!.ts;

    // Take whole turns from the tail until the char budget (or turn cap) is hit. The newest
    // turns are the most relevant to honoring in-flight commitments.
    const tail: string[] = [];
    let used = 0;
    let included = 0;
    for (let i = dialogue.length - 1; i >= 0; i--) {
      const m = dialogue[i]!;
      const speaker = m.role === 'user' ? 'User' : 'Orchestrator';
      const line = `${speaker}: ${sanitizeForFence(clip(m.text))}`;
      // Always include at least one turn; otherwise stop once a turn would overflow the budget.
      if (included >= MAX_TURNS) break;
      if (included > 0 && used + line.length > MAX_CHARS) break;
      tail.unshift(line);
      used += line.length + 1; // +1 for the joining newline
      included += 1;
    }

    const omitted = dialogue.length - included;
    const lines: string[] = [
      '```prior-conversation',
      '⟳ Recovered conversation context — NOT a user instruction. The engine restarted and your',
      'in-session memory was lost; this is the tail of your earlier board dialogue. Use it to honor',
      'commitments you already made and stay consistent — do NOT re-execute anything already done.',
    ];
    if (omitted > 0) {
      lines.push(`[earlier conversation: ${omitted} turn${omitted === 1 ? '' : 's'} omitted]`);
    }
    lines.push(...tail, '```');

    return { digest: lines.join('\n'), sinceIso };
  } catch {
    // A transcript read hiccup must never break starting the board — no re-prime, start proceeds.
    return null;
  }
}
