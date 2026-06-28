import { describe, it, expect, beforeEach, vi } from 'vitest';

// FLUX-838: the board cold-resume re-prime reads the projected board transcript. Stub it so the
// pure assembly (filtering, bounded tail, elision marker, fence, sinceIso) is exercised without a
// live flux dir / JSONL file. FLUX-856: the re-prime now reads a bounded tail of the transcript
// (`tailTranscriptMessages`) rather than the whole projection — stub that bounded reader.
vi.mock('./transcript.js', () => ({
  tailTranscriptMessages: vi.fn(async () => []),
}));

import { buildBoardReprime } from './board-reprime.js';
import { tailTranscriptMessages, type TranscriptMessage } from './transcript.js';

function msg(role: TranscriptMessage['role'], text: string, ts = '2026-06-27T12:00:00.000Z'): TranscriptMessage {
  return { role, text, ts };
}

describe('buildBoardReprime', () => {
  beforeEach(() => {
    vi.mocked(tailTranscriptMessages).mockReset();
  });

  it('returns null on a fresh / post-reset board (no transcript rows)', async () => {
    vi.mocked(tailTranscriptMessages).mockResolvedValue([]);
    expect(await buildBoardReprime()).toBeNull();
  });

  it('returns null when only non-dialogue rows exist (tool / note only)', async () => {
    vi.mocked(tailTranscriptMessages).mockResolvedValue([
      msg('tool', 'list_tickets'),
      msg('note', '⟳ context update'),
    ]);
    expect(await buildBoardReprime()).toBeNull();
  });

  it('builds a fenced verbatim tail of user/assistant turns, dropping tool/note rows', async () => {
    vi.mocked(tailTranscriptMessages).mockResolvedValue([
      msg('user', 'create a ticket for the login bug', '2026-06-27T12:00:00.000Z'),
      msg('tool', 'create_ticket'),
      msg('assistant', 'Created FLUX-900 (login bug).', '2026-06-27T12:01:00.000Z'),
      msg('note', '⟳ context update'),
    ]);
    const out = await buildBoardReprime();
    expect(out).not.toBeNull();
    expect(out!.digest).toContain('```prior-conversation');
    expect(out!.digest).toContain('NOT a user instruction');
    expect(out!.digest).toContain('User: create a ticket for the login bug');
    expect(out!.digest).toContain('Orchestrator: Created FLUX-900 (login bug).');
    // tool / note rows are dropped
    expect(out!.digest).not.toContain('create_ticket');
    expect(out!.digest).not.toContain('context update');
    // no omission marker when nothing was dropped from the dialogue tail
    expect(out!.digest).not.toContain('turns omitted');
    // closes the fence
    expect(out!.digest.trimEnd().endsWith('```')).toBe(true);
  });

  it('derives sinceIso from the last transcript turn ts', async () => {
    vi.mocked(tailTranscriptMessages).mockResolvedValue([
      msg('user', 'hi', '2026-06-27T10:00:00.000Z'),
      msg('assistant', 'hello', '2026-06-27T11:30:00.000Z'),
    ]);
    const out = await buildBoardReprime();
    expect(out!.sinceIso).toBe('2026-06-27T11:30:00.000Z');
  });

  it('caps to the last N turns and prepends an elision marker for older omitted turns', async () => {
    const many: TranscriptMessage[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(msg(i % 2 === 0 ? 'user' : 'assistant', `turn number ${i}`));
    }
    vi.mocked(tailTranscriptMessages).mockResolvedValue(many);
    const built = await buildBoardReprime();
    expect(built).not.toBeNull();
    expect(built!.digest).toMatch(/\[earlier conversation: \d+ turns omitted\]/);
    // the most recent turn is always present; an early (omitted) one is not
    expect(built!.digest).toContain('turn number 29');
    expect(built!.digest).not.toContain('turn number 10');
  });

  it('clips an oversized single turn rather than dumping it verbatim', async () => {
    const huge = 'x'.repeat(20_000);
    vi.mocked(tailTranscriptMessages).mockResolvedValue([msg('assistant', huge)]);
    const out = await buildBoardReprime();
    expect(out).not.toBeNull();
    expect(out!.digest).toContain('(turn truncated)');
    expect(out!.digest.length).toBeLessThan(20_000);
  });

  it('neutralizes fence runs in turn text so they cannot break out', async () => {
    vi.mocked(tailTranscriptMessages).mockResolvedValue([msg('user', 'see ```code``` block')]);
    const out = await buildBoardReprime();
    // backticks are replaced so the only ``` runs are the opening/closing fence
    const fenceRuns = (out!.digest.match(/```/g) || []).length;
    expect(fenceRuns).toBe(2);
  });

  it('returns null (best-effort) when the transcript read throws', async () => {
    vi.mocked(tailTranscriptMessages).mockRejectedValue(new Error('disk gone'));
    expect(await buildBoardReprime()).toBeNull();
  });
});
