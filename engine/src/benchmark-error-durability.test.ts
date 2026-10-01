// FLUX-1739: EventHorizon's own normalized failure lines must survive into DURABLE ticket history.
//
// This is a standalone correctness bug as much as a benchmark precondition: every adapter funnels
// failures through `appendErrorToSession`, and until now those lines reached history only as untyped
// text that `compactSessionProgress` discarded — so `get_session_log`, the Smelter's troubleshooting
// flow, and the friction layer were all reading from a record the engine had already thrown away.
//
// The fixture below is built the way `flushSessionOutput` ACTUALLY builds one — assistant prose and
// the ⚠️ line concatenated into a SINGLE progress entry, then clipped at 2000 chars — because a
// naive one-entry-per-marker fixture passes while the real case silently drops the signal.
import { describe, it, expect, vi } from 'vitest';
import { compactSessionProgress } from './history.js';
import { appendErrorToSession, SESSION_ERROR_KEEP_CAP } from './agents/shared.js';
import type { CliSessionRecord } from './agents/types.js';

vi.mock('./events.js', () => ({ broadcastEvent: vi.fn() }));

function makeSession(): CliSessionRecord {
  return {
    id: 's1',
    taskId: 'T-1',
    outputBuffer: '',
    cumulativeOutput: '',
    writeQueue: Promise.resolve(),
    sessionHistoryEntry: { sessionId: 's1', progress: [] },
  } as unknown as CliSessionRecord;
}

async function drain(session: CliSessionRecord) {
  await session.writeQueue;
  await session.writeQueue;
}

describe('appendErrorToSession — durable typed entry', () => {
  it('pushes a typed entry carrying data.error alongside the live text line', async () => {
    const s = makeSession();
    appendErrorToSession(s, 'Tool failed: mcp__event-horizon__get_ticket — timeout');
    await drain(s);

    const progress = s.sessionHistoryEntry!.progress;
    const typed = progress.filter((p) => (p.data as { error?: string } | undefined)?.error);
    expect(typed).toHaveLength(1);
    expect(typed[0]!.type).toBe('info');
    expect((typed[0]!.data as { error: string }).error).toContain('mcp__event-horizon__get_ticket');
  });

  it('SURVIVES compaction even when the ⚠️ line was clipped away behind >2000 chars of prose', async () => {
    const s = makeSession();
    // Exactly the routine case: a long assistant block already pending in outputBuffer when the
    // failure lands. flushSessionOutput clips at 2000, so the marker never reaches the text entry.
    s.outputBuffer = 'x'.repeat(3000);
    appendErrorToSession(s, 'Agent error: rate limited');
    await drain(s);

    // Add enough later narration to push any text entry well past COMPACT_TEXT_TAIL.
    for (let i = 0; i < 5; i++) {
      s.sessionHistoryEntry!.progress.push({ timestamp: new Date().toISOString(), message: `narration ${i}` });
    }

    const entry = { sessionId: 's1', progress: s.sessionHistoryEntry!.progress };
    compactSessionProgress(entry as never);

    const kept = entry.progress.filter((p) => (p.data as { error?: string } | undefined)?.error);
    expect(kept).toHaveLength(1);
    expect((kept[0]!.data as { error: string }).error).toBe('Agent error: rate limited');

    // And confirm the premise: the clipped text entry really did lose the marker, so a substring
    // predicate over the text would have had nothing to match.
    const textEntries = entry.progress.filter((p) => typeof p.message === 'string' && p.message.startsWith('xxx'));
    expect(textEntries.some((p) => p.message!.includes('⚠️'))).toBe(false);
  });

  it('keeps the payload — compaction only strips data from `tool` entries, and exempts error entries anyway', async () => {
    const s = makeSession();
    appendErrorToSession(s, 'Agent error: boom');
    await drain(s);
    for (let i = 0; i < 40; i++) {
      s.sessionHistoryEntry!.progress.push({ timestamp: new Date().toISOString(), type: 'tool', message: `tool ${i}`, data: { x: i } });
    }
    const entry = { sessionId: 's1', progress: s.sessionHistoryEntry!.progress };
    compactSessionProgress(entry as never);
    const kept = entry.progress.filter((p) => (p.data as { error?: string } | undefined)?.error);
    expect(kept).toHaveLength(1);
  });

  it('bounds the kept set with a keep-cap, collapsing overflow to a count', async () => {
    const s = makeSession();
    for (let i = 0; i < SESSION_ERROR_KEEP_CAP + 5; i++) {
      appendErrorToSession(s, `Tool failed: t${i}`);
    }
    await drain(s);
    const typed = s.sessionHistoryEntry!.progress.filter((p) => (p.data as { error?: string } | undefined)?.error);
    expect(typed).toHaveLength(SESSION_ERROR_KEEP_CAP);
    const last = typed[typed.length - 1]!.data as { overflow?: number };
    expect(last.overflow).toBe(5);
  });

  it('leaves the live ⚠️ chat surface untouched (FLUX-981)', async () => {
    const s = makeSession();
    appendErrorToSession(s, 'Agent error: boom');
    await drain(s);
    const text = s.sessionHistoryEntry!.progress.find((p) => typeof p.message === 'string' && p.message.includes('⚠️'));
    expect(text).toBeDefined();
  });

  it('does not consume a COMPACT_TEXT_TAIL slot needed by real narration', async () => {
    const s = makeSession();
    s.sessionHistoryEntry!.progress.push({ timestamp: new Date().toISOString(), message: 'narration A' });
    s.sessionHistoryEntry!.progress.push({ timestamp: new Date().toISOString(), message: 'narration B' });
    appendErrorToSession(s, 'Agent error: boom');
    await drain(s);
    const entry = { sessionId: 's1', progress: s.sessionHistoryEntry!.progress };
    compactSessionProgress(entry as never);
    // The typed entry is not `text`, so both narration lines still fit the tail.
    const messages = entry.progress.map((p) => p.message);
    expect(messages).toContain('narration A');
    expect(messages).toContain('narration B');
  });
});
