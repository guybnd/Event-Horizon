import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import {
  appendTranscriptEvent,
  appendTranscriptLine,
  flushTranscript,
  getTranscriptFile,
  readTurns,
  sliceTurns,
  readTranscriptMessages,
} from './transcript.js';
import { projectTranscript, type Turn } from './projection.js';

/**
 * FLUX-658 — substrate vs projection split. Locks the invariants that make the future
 * curation verbs safe: turns carry a stable id + monotonic seq, legacy un-enveloped lines
 * still read losslessly, ranges are sliceable by seq, and the transcript view is a pure
 * re-projection of the substrate (no behaviour change).
 */
describe('substrate vs projection (FLUX-658)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-substrate-'));
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // Use a fresh streamId per test so the module-global seq cache never leaks across tests.
  let n = 0;
  const freshStream = () => `STREAM-${Date.now()}-${n++}`;

  it('envelopes appends with stable turnId + monotonic seq, raw intact (round-trip)', async () => {
    const stream = freshStream();
    appendTranscriptEvent(stream, { type: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00.000Z' });
    appendTranscriptLine(stream, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    await flushTranscript(stream);

    const turns = await readTurns(stream);
    expect(turns).toHaveLength(2);
    const [t0, t1] = turns as [Turn, Turn];

    expect(t0.seq).toBe(0);
    expect(t0.turnId).toBe(`${stream}:0`);
    expect(t0.streamId).toBe(stream);
    expect(t0.role).toBe('user');
    expect(t0.ts).toBe('2026-01-01T00:00:00.000Z');
    expect(t0.raw).toEqual({ type: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00.000Z' });

    expect(t1.seq).toBe(1);
    expect(t1.turnId).toBe(`${stream}:1`);
    expect(t1.role).toBe('assistant');
    expect(t1.raw).toEqual({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });

    // On disk each line is a versioned envelope, not a bare raw event.
    const onDisk = (await fs.readFile(getTranscriptFile(stream), 'utf8')).trim().split('\n');
    const first = JSON.parse(onDisk[0]!);
    expect(first.v).toBe(1);
    expect(first.turnId).toBe(`${stream}:0`);
    expect(first.seq).toBe(0);
    expect(first.raw.text).toBe('hello');
  });

  it('reads legacy (pre-envelope) lines losslessly with derived line-index addressing', async () => {
    const stream = freshStream();
    const legacy = [
      { type: 'user', text: 'old turn', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } },
    ];
    await fs.mkdir(path.dirname(getTranscriptFile(stream)), { recursive: true });
    await fs.writeFile(getTranscriptFile(stream), legacy.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const turns = await readTurns(stream);
    expect(turns.map((t) => t.seq)).toEqual([0, 1]);
    expect(turns.map((t) => t.turnId)).toEqual([`${stream}:0`, `${stream}:1`]);
    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.raw).toEqual(legacy[0]);

    // A new append continues the seq past the legacy lines — one gap-free seq space.
    appendTranscriptEvent(stream, { type: 'user', text: 'new turn' });
    await flushTranscript(stream);
    const after = await readTurns(stream);
    expect(after).toHaveLength(3);
    expect(after[2]!.seq).toBe(2);
    expect(after[2]!.turnId).toBe(`${stream}:2`);
  });

  it('sliceTurns addresses a contiguous seq range (inclusive, open-ended bounds)', async () => {
    const stream = freshStream();
    for (let i = 0; i < 5; i++) appendTranscriptEvent(stream, { type: 'user', text: `t${i}` });
    await flushTranscript(stream);

    const mid = await sliceTurns(stream, 1, 3);
    expect(mid.map((t) => t.seq)).toEqual([1, 2, 3]);

    const fromTwo = await sliceTurns(stream, 2);
    expect(fromTwo.map((t) => t.seq)).toEqual([2, 3, 4]);

    const upToOne = await sliceTurns(stream, undefined, 1);
    expect(upToOne.map((t) => t.seq)).toEqual([0, 1]);

    const all = await sliceTurns(stream);
    expect(all.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('projectTranscript re-derives the chat view from turns (pure, ops default empty)', () => {
    const stream = 'FIX';
    const raws = [
      { type: 'user', text: 'hello', timestamp: 'T1' },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'hi there' },
        { type: 'tool_use', name: 'mcp__event-horizon__list_tickets', input: {} },
      ] } },
      { type: 'ask-question', questions: [{ header: 'H', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }], timestamp: 'T3' },
      { type: 'ask-answer', answers: { Q: 'A' }, timestamp: 'T4' },
      { type: 'system' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } },
    ];
    // Every turn carries the same envelope ts ('TENV'); assistant + tool turns now surface it
    // (FLUX-684), while user / ask turns keep their own event timestamp.
    const turns: Turn[] = raws.map((raw, seq) => ({ turnId: `${stream}:${seq}`, streamId: stream, seq, ts: 'TENV', role: 'unknown', raw }));

    expect(projectTranscript(turns)).toEqual([
      { role: 'user', text: 'hello', ts: 'T1' },
      { role: 'assistant', text: 'hi there', ts: 'TENV' },
      { role: 'tool', text: 'list_tickets', ts: 'TENV' },
      { role: 'assistant', text: '❓ **H** — Q?\n- A\n- B', ts: 'T3' },
      { role: 'user', text: '✔ A', ts: 'T4' },
    ]);
  });

  it('projectTranscript renders a resume-preamble as a system context-update note row (FLUX-745)', () => {
    const stream = 'RP';
    const raws = [
      { type: 'user', text: 'continue', timestamp: 'T1' },
      // FLUX-655: the warm-resume situational update is its own durable event. It must NOT be a
      // chat bubble — it projects to a non-bubble `note` row tagged `context-update`.
      { type: 'resume-preamble', text: '```situational-update\nbranch moved\n```', timestamp: 'T2' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } },
      // An empty/whitespace preamble is skipped (defensive — same as empty assistant text).
      { type: 'resume-preamble', text: '   ', timestamp: 'T3' },
    ];
    const turns: Turn[] = raws.map((raw, seq) => ({ turnId: `${stream}:${seq}`, streamId: stream, seq, ts: 'TENV', role: 'unknown', raw }));

    expect(projectTranscript(turns)).toEqual([
      { role: 'user', text: 'continue', ts: 'T1' },
      { role: 'note', kind: 'context-update', text: '```situational-update\nbranch moved\n```', ts: 'T2' },
      { role: 'assistant', text: 'on it', ts: 'TENV' },
    ]);
  });

  it('projectTranscript carries pasted-image attachments onto the user turn (FLUX-674)', () => {
    const stream = 'IMG';
    const raws = [
      {
        type: 'user',
        text: 'look at this',
        timestamp: 'T1',
        attachments: [
          { url: '/api/assets/IMG/a.png', path: 'assets/IMG/a.png', fileName: 'a.png' },
          // Malformed entries (missing url/path) are filtered out defensively.
          { fileName: 'broken.png' },
        ],
      },
      // An image-only turn (empty text) still projects, with its attachment.
      { type: 'user', text: '', timestamp: 'T2', attachments: [{ url: '/api/assets/IMG/b.png', path: 'assets/IMG/b.png' }] },
    ];
    const turns: Turn[] = raws.map((raw, seq) => ({ turnId: `${stream}:${seq}`, streamId: stream, seq, ts: '', role: 'user', raw }));

    expect(projectTranscript(turns)).toEqual([
      { role: 'user', text: 'look at this', ts: 'T1', attachments: [{ url: '/api/assets/IMG/a.png', path: 'assets/IMG/a.png', fileName: 'a.png' }] },
      { role: 'user', text: '', ts: 'T2', attachments: [{ url: '/api/assets/IMG/b.png', path: 'assets/IMG/b.png', fileName: 'image' }] },
    ]);
  });

  it('projectTranscript attaches per-edit line counts to edit-tool rows (FLUX-688)', () => {
    const stream = freshStream();
    // An Edit replacing one line inside a 3-line block → +1 −1 (line-level LCS, not +3 −3).
    const editFile = path.join(root, 'a.ts');
    const writeFile = path.join(root, 'b.ts');
    const multiFile = path.join(root, 'c.ts');
    const raws = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: editFile, old_string: 'a\nb\nc', new_string: 'a\nB\nc' } },
            // Write: + content lines, −0 (no prior content in the tool input).
            { type: 'tool_use', name: 'Write', input: { file_path: writeFile, content: 'x\ny\nz\n' } },
            // MultiEdit: summed across edits[] (here: +1−1 then +1−0 = +2 −1).
            {
              type: 'tool_use',
              name: 'MultiEdit',
              input: {
                file_path: multiFile,
                edits: [
                  { old_string: 'one\ntwo', new_string: 'one\nTWO' },
                  { old_string: 'tail', new_string: 'tail\nextra' },
                ],
              },
            },
          ],
        },
      },
    ];
    const turns: Turn[] = raws.map((raw, seq) => ({ turnId: `${stream}:${seq}`, streamId: stream, seq, ts: '', role: 'assistant', raw }));

    const msgs = projectTranscript(turns);
    // All three are edit rows under the workspace root, so they carry both tool/path and counts.
    expect(msgs).toEqual([
      { role: 'tool', text: 'Edit · ' + editFile.replace(/\s+/g, ' ').slice(0, 48), ts: '', added: 1, removed: 1, tool: 'Edit', path: 'a.ts' },
      { role: 'tool', text: 'Write · ' + writeFile.replace(/\s+/g, ' ').slice(0, 48), ts: '', added: 3, removed: 0, tool: 'Write', path: 'b.ts' },
      { role: 'tool', text: 'MultiEdit · ' + multiFile.replace(/\s+/g, ' ').slice(0, 48), ts: '', added: 2, removed: 1, tool: 'MultiEdit', path: 'c.ts' },
    ]);
  });

  it('unparseable line round-trips as string-raw turn and is skipped by the projector (FLUX-671)', async () => {
    const stream = freshStream();
    // Append a good event, then simulate a corrupt/non-JSON line written directly to disk.
    appendTranscriptEvent(stream, { type: 'user', text: 'before', timestamp: 'T0' });
    await flushTranscript(stream);
    await fs.appendFile(getTranscriptFile(stream), 'not-json-at-all\n', 'utf8');
    appendTranscriptEvent(stream, { type: 'user', text: 'after', timestamp: 'T2' });
    await flushTranscript(stream);

    const turns = await readTurns(stream);
    expect(turns).toHaveLength(3);

    // Middle turn: raw is the original string, role is unknown.
    const corrupt = turns[1]!;
    expect(corrupt.raw).toBe('not-json-at-all');
    expect(corrupt.role).toBe('unknown');
    expect(corrupt.seq).toBe(1);
    expect(corrupt.turnId).toBe(`${stream}:1`);

    // projectTranscript skips it (string raw has no .type).
    const msgs = projectTranscript(turns);
    expect(msgs).toEqual([
      { role: 'user', text: 'before', ts: 'T0' },
      { role: 'user', text: 'after', ts: 'T2' },
    ]);
  });

  it('readTranscriptMessages routes legacy + enveloped turns through the projector identically', async () => {
    const stream = freshStream();
    // One legacy bare line, then one enveloped append — both must render through projection.
    await fs.mkdir(path.dirname(getTranscriptFile(stream)), { recursive: true });
    await fs.writeFile(
      getTranscriptFile(stream),
      JSON.stringify({ type: 'user', text: 'legacy hi', timestamp: 'T0' }) + '\n',
      'utf8',
    );
    appendTranscriptEvent(stream, { type: 'assistant', message: { content: [{ type: 'text', text: 'enveloped reply' }] }, timestamp: 'T1' });
    await flushTranscript(stream);

    expect(await readTranscriptMessages(stream)).toEqual([
      { role: 'user', text: 'legacy hi', ts: 'T0' },
      { role: 'assistant', text: 'enveloped reply', ts: 'T1' },
    ]);
  });
});
