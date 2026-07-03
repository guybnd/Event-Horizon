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
  tailTurns,
  tailTranscriptMessages,
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

  it('projectTranscript renders Copilot assistant.message reasoningText AND content (FLUX-969)', () => {
    // Copilot CLI narration lands in two fields on the `assistant.message` event: `data.content`
    // (the final reply text) and `data.reasoningText` (the inter-tool narration, which is the ONLY
    // text on a tool-call turn where content is ''). The original render read only `content`, so
    // reasoning-only messages — the bulk of a tool-heavy turn — vanished from the chat while still
    // showing in the history/progress video. Both must project, reasoning before content.
    const stream = 'COP';
    const raws = [
      { type: 'user', text: 'go', timestamp: 'T1' },
      // reason-only (a tool-call turn): content is '' → reasoning is the only narration.
      { type: 'assistant.message', data: { content: '', reasoningText: 'Let me look at the ticket.' } },
      // content-only (a plain reply / non-tool turn).
      { type: 'assistant.message', data: { content: 'Now updating shared.ts:', reasoningText: '' } },
      // both — reasoning precedes the lead-in content; each emits its own bubble.
      { type: 'assistant.message', data: { content: 'Let me check the race:', reasoningText: 'liveOutput is exposed but not on the progress stream.' } },
      // neither (pure tool-call housekeeping) → nothing renders.
      { type: 'assistant.message', data: { content: '   ', reasoningText: '' } },
    ];
    const turns: Turn[] = raws.map((raw, seq) => ({ turnId: `${stream}:${seq}`, streamId: stream, seq, ts: 'TENV', role: 'unknown', raw }));

    expect(projectTranscript(turns)).toEqual([
      { role: 'user', text: 'go', ts: 'T1' },
      { role: 'assistant', text: 'Let me look at the ticket.', ts: 'TENV' },
      { role: 'assistant', text: 'Now updating shared.ts:', ts: 'TENV' },
      { role: 'assistant', text: 'liveOutput is exposed but not on the progress stream.', ts: 'TENV' },
      { role: 'assistant', text: 'Let me check the race:', ts: 'TENV' },
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

  it('projectTranscript renders a phase-launch action as a quiet action note row (FLUX-794)', () => {
    const stream = 'ACT';
    const raws = [
      // FLUX-794: the pressed non-chat phase action lands as a durable `action` event. It projects
      // to a non-bubble `note` row tagged `action` so the popped-in chat shows which button started
      // the session, in order before the agent's first response. With a focus, the label carries it.
      { type: 'action', phase: 'implementation', focus: 'land the engine seam', timestamp: 'T1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } },
      // No focus → bare label. Unknown phase → generic fallback label.
      { type: 'action', phase: 'review', timestamp: 'T2' },
      { type: 'action', phase: 'mystery', timestamp: 'T3' },
      // FLUX-798: a delegated/supervisor launch carries the multi-line `rosterContext` markdown
      // boilerplate as its focus. The chip must show a clean single line (first non-empty line,
      // leading markdown stripped), not a raw markdown dump.
      {
        type: 'action',
        phase: 'implementation',
        focus: '## Dynamic Delegation\n\nUse `list_available_agents` to discover specialists, then delegate as needed.',
        timestamp: 'T4',
      },
      // A chat user turn is unaffected — it still renders as a user bubble (no double-marker).
      { type: 'user', text: 'hello', timestamp: 'T5' },
    ];
    const turns: Turn[] = raws.map((raw, seq) => ({ turnId: `${stream}:${seq}`, streamId: stream, seq, ts: 'TENV', role: 'unknown', raw }));

    expect(projectTranscript(turns)).toEqual([
      { role: 'note', kind: 'action', text: 'Implementation session started — land the engine seam', ts: 'T1' },
      { role: 'assistant', text: 'on it', ts: 'TENV' },
      { role: 'note', kind: 'action', text: 'Review session started', ts: 'T2' },
      { role: 'note', kind: 'action', text: 'Session started', ts: 'T3' },
      { role: 'note', kind: 'action', text: 'Implementation session started — Dynamic Delegation', ts: 'T4' },
      { role: 'user', text: 'hello', ts: 'T5' },
    ]);
  });

  it('projectTranscript renders a permission round-trip as quiet permission note rows (FLUX-833)', () => {
    const stream = 'PERM';
    const raws = [
      // FLUX-833: a gated tool call parks for approval. The durable request + decision events
      // project to non-bubble `note` rows tagged `permission` so a cold resume sees the round-trip.
      { type: 'permission-request', id: 'p1', toolName: 'change_status', input: { newStatus: 'Done' }, timestamp: 'T1' },
      { type: 'permission-resolved', id: 'p1', behavior: 'allow', timestamp: 'T2' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      // A timed-out denial is distinguished by `reason: 'timeout'` in the rendered text.
      { type: 'permission-request', id: 'p2', toolName: 'Bash', input: { command: 'rm -rf x' }, timestamp: 'T3' },
      { type: 'permission-resolved', id: 'p2', behavior: 'deny', reason: 'timeout', timestamp: 'T4' },
      // A plain human denial (no reason) reads as a flat "denied".
      { type: 'permission-resolved', id: 'p3', behavior: 'deny', timestamp: 'T5' },
    ];
    const turns: Turn[] = raws.map((raw, seq) => ({ turnId: `${stream}:${seq}`, streamId: stream, seq, ts: 'TENV', role: 'unknown', raw }));

    expect(projectTranscript(turns)).toEqual([
      { role: 'note', kind: 'permission', text: '🔒 Approval requested · change_status', ts: 'T1' },
      { role: 'note', kind: 'permission', text: '✅ Approval granted', ts: 'T2' },
      { role: 'assistant', text: 'done', ts: 'TENV' },
      { role: 'note', kind: 'permission', text: '🔒 Approval requested · Bash', ts: 'T3' },
      { role: 'note', kind: 'permission', text: '⛔ Approval timed out — denied', ts: 'T4' },
      { role: 'note', kind: 'permission', text: '⛔ Approval denied', ts: 'T5' },
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

/**
 * FLUX-856 — bounded-tail read for cold-resume re-prime. `tailTurns` / `tailTranscriptMessages`
 * must return only the last N turns (with their real enveloped seq) regardless of how large the
 * transcript is, so the board cold-start never reads/projects the whole `__board__.jsonl`.
 */
describe('bounded tail read (FLUX-856)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tail-'));
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  let n = 0;
  const freshStream = () => `TAIL-${Date.now()}-${n++}`;

  it('returns only the last N turns, with their real (absolute) seq preserved', async () => {
    const stream = freshStream();
    for (let i = 0; i < 50; i++) {
      appendTranscriptEvent(stream, { type: 'user', text: `turn ${i}`, timestamp: `T${i}` });
    }
    await flushTranscript(stream);

    const tail = await tailTurns(stream, 10);
    expect(tail).toHaveLength(10);
    // Seqs are the real absolute envelope seqs (40..49), not window-relative indices.
    expect(tail.map((t) => t.seq)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
    expect(tail[0]!.raw.text).toBe('turn 40');
    expect(tail[9]!.raw.text).toBe('turn 49');
    expect(tail[9]!.turnId).toBe(`${stream}:49`);
  });

  it('returns the whole (short) transcript when it has fewer than N turns', async () => {
    const stream = freshStream();
    appendTranscriptEvent(stream, { type: 'user', text: 'only one', timestamp: 'T0' });
    await flushTranscript(stream);

    const tail = await tailTurns(stream, 200);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.raw.text).toBe('only one');
  });

  it('returns [] for a missing transcript file (fresh board)', async () => {
    expect(await tailTurns(freshStream(), 200)).toEqual([]);
    expect(await tailTranscriptMessages(freshStream(), 200)).toEqual([]);
  });

  it('tailTranscriptMessages projects only the tail window', async () => {
    const stream = freshStream();
    for (let i = 0; i < 30; i++) {
      appendTranscriptEvent(stream, { type: 'user', text: `msg ${i}`, timestamp: `T${i}` });
    }
    await flushTranscript(stream);

    const msgs = await tailTranscriptMessages(stream, 5);
    expect(msgs).toEqual([
      { role: 'user', text: 'msg 25', ts: 'T25' },
      { role: 'user', text: 'msg 26', ts: 'T26' },
      { role: 'user', text: 'msg 27', ts: 'T27' },
      { role: 'user', text: 'msg 28', ts: 'T28' },
      { role: 'user', text: 'msg 29', ts: 'T29' },
    ]);
  });

  it('reads a tail across many file chunks (line spanning the 64 KiB read window)', async () => {
    const stream = freshStream();
    // A single fat turn larger than the 64 KiB chunk forces the backward reader to loop.
    appendTranscriptEvent(stream, { type: 'user', text: 'x'.repeat(80_000), timestamp: 'T0' });
    appendTranscriptEvent(stream, { type: 'user', text: 'last', timestamp: 'T1' });
    await flushTranscript(stream);

    const tail = await tailTurns(stream, 2);
    expect(tail).toHaveLength(2);
    expect(tail[0]!.raw.text).toHaveLength(80_000);
    expect(tail[1]!.raw.text).toBe('last');
  });
});
