import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot, getActiveFluxDir } from './workspace.js';
import { readTranscript, flushTranscript, clearTranscript } from './transcript.js';
import {
  parkPrompt,
  resolvePrompt,
  listOpenPrompts,
  rehydrateOpenPrompts,
  flushOpenPrompts,
  type OpenPromptRecord,
  type PromptResult,
} from './hitl-prompts.js';

/**
 * FLUX-833 (Phase 2) — the unified, restart-durable HITL store. Locks the invariants that make a
 * pending approval/question survive an engine restart: every open prompt is mirrored to
 * open-prompts.json (carrying the resume pointer), the file is exactly the open set (park adds /
 * settle removes), rehydrate reloads it, and settle is idempotent (the terminal-state /
 * phantom-write guard).
 */
describe('hitl-prompts durable store (FLUX-833 Phase 2)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-hitl-'));
    setWorkspaceRoot(root);
    // Drain any prompts a prior test left in the module-global index so each test starts clean.
    for (const r of [...listOpenPrompts('permission'), ...listOpenPrompts('question')]) resolvePrompt(r.id, {});
  });

  afterEach(async () => {
    for (const r of [...listOpenPrompts('permission'), ...listOpenPrompts('question')]) resolvePrompt(r.id, {});
    // Drain the coalesced async write before removing the temp root so it can't write into a
    // just-deleted dir (FLUX-854).
    await flushOpenPrompts();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const readIndex = async (): Promise<OpenPromptRecord[]> => {
    const raw = await fs.readFile(path.join(getActiveFluxDir(), 'open-prompts.json'), 'utf-8').catch(() => '[]');
    return JSON.parse(raw);
  };

  it('persists an open prompt (with resumeSessionId) to open-prompts.json and lists it', async () => {
    // Park (do not await — it only settles on resolve/timeout) and let the microtask queue flush.
    void parkPrompt({
      kind: 'permission',
      payload: { toolName: 'change_status', input: { newStatus: 'Done' } },
      conversationId: 'FLUX-1',
      resumeSessionId: 'sess-abc',
      timeoutMs: 60_000,
    });
    await Promise.resolve();

    const open = listOpenPrompts('permission');
    expect(open).toHaveLength(1);
    expect(open[0]!.resumeSessionId).toBe('sess-abc');

    await flushOpenPrompts();
    const onDisk = await readIndex();
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({
      kind: 'permission',
      conversationId: 'FLUX-1',
      resumeSessionId: 'sess-abc',
      payload: { toolName: 'change_status', input: { newStatus: 'Done' } },
    });
    expect(typeof onDisk[0]!.id).toBe('string');
  });

  it('resolving settles the held promise, removes the record from disk, and is idempotent', async () => {
    let settled: PromptResult | undefined;
    const parked = parkPrompt({
      kind: 'permission',
      payload: { toolName: 'Bash', input: { command: 'ls' } },
      conversationId: 'FLUX-2',
      timeoutMs: 60_000,
    }).then((d) => { settled = d; });
    await Promise.resolve();

    const { id } = listOpenPrompts('permission')[0]!;
    expect(resolvePrompt(id, { behavior: 'allow' })).toBe(true);
    await parked;
    expect(settled).toEqual({ behavior: 'allow' });

    // Removed from the in-memory index and from disk.
    expect(listOpenPrompts('permission')).toHaveLength(0);
    await flushOpenPrompts();
    expect(await readIndex()).toHaveLength(0);

    // Terminal-state guard: a second (e.g. late cross-restart) answer is a no-op, no phantom write.
    expect(resolvePrompt(id, { behavior: 'deny' })).toBe(false);
  });

  it('rehydrates open prompts from disk on boot, keyed by their original id', async () => {
    // Two kinds parked durably.
    void parkPrompt({ kind: 'permission', payload: { toolName: 'Write', input: {} }, conversationId: 'FLUX-3', timeoutMs: 60_000 });
    void parkPrompt({ kind: 'question', payload: { questions: [{ header: 'H', question: 'Q?', options: [{ label: 'A' }] }] }, conversationId: 'FLUX-3', resumeSessionId: 'sess-q', timeoutMs: 60_000 });
    await Promise.resolve();
    const before = [...listOpenPrompts('permission'), ...listOpenPrompts('question')].map((r) => r.id).sort();
    expect(before).toHaveLength(2);

    // Simulate an engine restart: the on-disk index is the only surviving state. Flush the
    // coalesced async write first so it has actually landed on disk (FLUX-854), then re-load it —
    // both records must restore under the SAME ids (cards re-bind rather than orphan).
    await flushOpenPrompts();
    const reSurfaced = rehydrateOpenPrompts();
    expect(reSurfaced).toBeGreaterThanOrEqual(2);

    const perm = listOpenPrompts('permission');
    const ques = listOpenPrompts('question');
    expect(perm).toHaveLength(1);
    expect(ques).toHaveLength(1);
    expect(ques[0]!.resumeSessionId).toBe('sess-q');
    expect([...perm, ...ques].map((r) => r.id).sort()).toEqual(before);
  });

  it('ignores a missing or malformed index without throwing', async () => {
    // No file yet.
    expect(rehydrateOpenPrompts()).toBe(0);
    // Garbage / wrong-shape entries are skipped, not loaded.
    await fs.mkdir(getActiveFluxDir(), { recursive: true });
    await fs.writeFile(
      path.join(getActiveFluxDir(), 'open-prompts.json'),
      JSON.stringify([{ id: 'x', kind: 'bogus' }, null, { kind: 'permission' }]),
      'utf-8',
    );
    expect(rehydrateOpenPrompts()).toBe(0);
    expect(listOpenPrompts('permission')).toHaveLength(0);
  });

  // Review M1: a record with a valid id+kind but a missing/wrong payload must be skipped, not
  // crash rehydrate — the per-record body is guarded and one bad record can't drop the good ones.
  it('skips a record with a missing payload and still loads the valid records (M1)', async () => {
    await fs.mkdir(getActiveFluxDir(), { recursive: true });
    await fs.writeFile(
      path.join(getActiveFluxDir(), 'open-prompts.json'),
      JSON.stringify([
        { id: 'bad', kind: 'permission' },                                   // no payload → would throw pre-fix
        { id: 'good', kind: 'permission', payload: { toolName: 'Bash', input: {} }, conversationId: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
      ]),
      'utf-8',
    );
    expect(() => rehydrateOpenPrompts()).not.toThrow();
    const open = listOpenPrompts('permission');
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe('good');
  });

  // Review M2: persist is atomic (tmp + rename) and leaves no .tmp sibling behind.
  it('writes the index atomically with no leftover .tmp file (M2)', async () => {
    void parkPrompt({ kind: 'permission', payload: { toolName: 'Write', input: {} }, conversationId: 'FLUX-9', timeoutMs: 60_000 });
    await flushOpenPrompts();
    const dir = getActiveFluxDir();
    await expect(fs.access(path.join(dir, 'open-prompts.json'))).resolves.toBeUndefined();
    const tmpExists = await fs.access(path.join(dir, 'open-prompts.json.tmp')).then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);
  });

  // Review M3: a re-surfaced prompt already past its deadline is swept (settled as a timeout),
  // not re-surfaced as a prompt that would never expire. conversationId:null keeps the sweep
  // isolated (no needsAction / transcript side effects).
  it('sweeps an already-expired prompt on rehydrate instead of re-surfacing it (M3)', async () => {
    await fs.mkdir(getActiveFluxDir(), { recursive: true });
    await fs.writeFile(
      path.join(getActiveFluxDir(), 'open-prompts.json'),
      JSON.stringify([
        { id: 'stale', kind: 'permission', payload: { toolName: 'Bash', input: {} }, conversationId: null, createdAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() - 300_000).toISOString() },
      ]),
      'utf-8',
    );
    expect(rehydrateOpenPrompts()).toBe(0); // swept, not counted as re-surfaced
    expect(listOpenPrompts('permission')).toHaveLength(0);
    await flushOpenPrompts();
    expect(await readIndex()).toHaveLength(0); // removed from disk too
  });

  // FLUX-866: an UNROUTED prompt (conversationId === null) — answered only via the pending board —
  // must still echo its round-trip somewhere, or the chat shows the question with no reply. The
  // fallback is the board orchestrator thread `__board__`: both the request (ask-question) and the
  // answer (ask-answer) land there, matching the inline-picker echo for routed prompts.
  it('echoes an unrouted question + its answer to the __board__ transcript stream (FLUX-866)', async () => {
    await clearTranscript('__board__'); // isolate from any seq carried over by the module-global

    const parked = parkPrompt({
      kind: 'question',
      payload: { questions: [{ header: 'H', question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }] },
      conversationId: null, // unrouted — no EH_CONVERSATION_ID / dropped token
      timeoutMs: 60_000,
    });
    await Promise.resolve();

    const { id } = listOpenPrompts('question')[0]!;
    expect(resolvePrompt(id, { answers: { 'Pick one?': 'A' } })).toBe(true);
    await parked;

    await flushTranscript('__board__');
    const events = (await readTranscript('__board__')).map((l) => JSON.parse(l).raw);

    const request = events.find((e) => e?.type === 'ask-question' && e.id === id);
    expect(request).toBeTruthy();
    const answer = events.find((e) => e?.type === 'ask-answer' && e.id === id);
    expect(answer).toBeTruthy();
    expect(answer.answers).toEqual({ 'Pick one?': 'A' });
  });

  // Review M4: a path-unsafe conversationId persisted in the index is neutralized to null on
  // rehydrate before it can re-enter the transcript path.
  it('neutralizes a path-unsafe conversationId on rehydrate (M4)', async () => {
    await fs.mkdir(getActiveFluxDir(), { recursive: true });
    await fs.writeFile(
      path.join(getActiveFluxDir(), 'open-prompts.json'),
      JSON.stringify([
        { id: 'evil', kind: 'permission', payload: { toolName: 'Bash', input: {} }, conversationId: '../../escape', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
      ]),
      'utf-8',
    );
    expect(rehydrateOpenPrompts()).toBe(1);
    expect(listOpenPrompts('permission')[0]!.conversationId).toBeNull();
  });
});
