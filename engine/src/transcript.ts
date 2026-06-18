import { promises as fs } from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';

/**
 * FLUX-602: durable per-ticket conversation transcript — the "raw tier" of the
 * two-tier substrate (see FLUX-601). One JSONL file per ticket, stored alongside
 * assets/ and read-state.json inside the active flux dir (same convention as
 * getTaskAssetsDir / getReadStateFile in workspace.ts).
 *
 * Each line is one JSON object — either a synthetic user turn
 * ({ type: 'user', text, timestamp }) or a raw stream-json event emitted by the
 * `claude` CLI (stored verbatim). This is the local-first, in-repo record that
 * outlives the CLI's own session store and powers cold resume (re-priming a fresh
 * CLI session from the captured turns when --resume is no longer available).
 */

export function getTranscriptDir(): string {
  return path.join(getActiveFluxDir(), 'transcripts');
}

export function getTranscriptFile(taskId: string): string {
  return path.join(getTranscriptDir(), `${taskId}.jsonl`);
}

// Serialize appends per task so concurrent stream-json lines never interleave.
const writeQueues = new Map<string, Promise<void>>();

/** Append a single pre-serialized JSONL line (no trailing newline required). */
export function appendTranscriptLine(taskId: string, line: string): void {
  const file = getTranscriptFile(taskId);
  const prev = writeQueues.get(taskId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await fs.mkdir(getTranscriptDir(), { recursive: true });
      await fs.appendFile(file, line.endsWith('\n') ? line : line + '\n', 'utf8');
    })
    .catch((err) => {
      console.error(`[transcript] failed to append for ${taskId}:`, err);
    });
  writeQueues.set(taskId, next);
}

/** Append a structured event (e.g. a synthetic user turn) as one JSONL line. */
export function appendTranscriptEvent(taskId: string, event: unknown): void {
  try {
    appendTranscriptLine(taskId, JSON.stringify(event));
  } catch (err) {
    console.error(`[transcript] failed to serialize event for ${taskId}:`, err);
  }
}

/** Read the raw transcript lines for a ticket (empty array if none yet). */
export async function readTranscript(taskId: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(getTranscriptFile(taskId), 'utf8');
    return raw.split('\n').filter((l) => l.trim());
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  ts: string;
}

/** Friendly one-line label for a tool_use block ("watch it work"). */
function toolLabel(block: any): string {
  let name = String(block?.name || 'tool');
  const m = name.match(/^mcp__.+?__(.+)$/); // mcp__event-horizon__list_tickets -> list_tickets
  if (m && m[1]) name = m[1];
  const input = block?.input || {};
  const hint = input.ticketId ?? input.id ?? input.newStatus ?? input.file_path ?? input.command ?? input.query;
  const hintStr = hint != null ? String(hint).replace(/\s+/g, ' ').slice(0, 48) : '';
  return hintStr ? `${name} · ${hintStr}` : name;
}

/**
 * Parse the raw JSONL into ordered chat messages for the portal. File order is
 * chronological (append-only), so we preserve it rather than sorting — assistant
 * stream-json events don't carry a reliable timestamp. User turns come from our
 * synthetic { type: 'user' } lines; assistant events yield a 'text' message per
 * text block and a 'tool' message per tool_use block (so the user watches the
 * agent check the board / act). Empty thinking blocks, system, and result lines
 * are skipped.
 */
export async function readTranscriptMessages(taskId: string): Promise<TranscriptMessage[]> {
  const lines = await readTranscript(taskId);
  const out: TranscriptMessage[] = [];
  for (const line of lines) {
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt?.type === 'user' && typeof evt.text === 'string') {
      out.push({ role: 'user', text: evt.text, ts: typeof evt.timestamp === 'string' ? evt.timestamp : '' });
    } else if (evt?.type === 'assistant' && Array.isArray(evt.message?.content)) {
      for (const b of evt.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ role: 'assistant', text: b.text, ts: '' });
        } else if (b?.type === 'tool_use') {
          out.push({ role: 'tool', text: toolLabel(b), ts: '' });
        }
      }
    }
  }
  return out;
}
