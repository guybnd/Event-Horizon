import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { updateTaskWithHistory, computeBodyVersion, StaleBodyError } from './task-store.js';

/**
 * FLUX-1550: updateTaskWithHistoryLocked re-reads the ticket fresh off disk under the per-ticket
 * write lock, but historically applied `options.newBody` unconditionally — no check that the
 * caller's body was computed from the version currently on disk. Two concurrent body edits (e.g.
 * two agents, or an agent and a human editing the same ticket) raced last-writer-wins with no
 * conflict detection, silently erasing whichever write landed first (proven live on FLUX-1548).
 *
 * These tests pin the CAS contract: `options.baseBodyVersion` (opaque, from `computeBodyVersion`)
 * must match the on-disk body's current version at write time, or the write is rejected with a
 * typed `StaleBodyError` instead of clobbering. Omitting it keeps today's ungated behavior
 * (grandfathered), with a warning logged. Metadata-only writes (no `newBody`) are never gated.
 */
describe('body CAS (baseBodyVersion) on updateTaskWithHistory (FLUX-1550)', () => {
  const taskId = 'FLUX-1550-CAS';
  let fluxDir: string;
  let ticketPath: string;

  async function writeTicketDirect(body: string, extra: Record<string, unknown> = {}) {
    await fs.writeFile(
      ticketPath,
      matter.stringify(body, { id: taskId, title: 'CAS test ticket', status: 'In Progress', swimlane: null, history: [], ...extra }),
    );
  }

  async function readBody(): Promise<string> {
    // matter.stringify always appends exactly one trailing newline after the body — strip it so
    // equality assertions compare against the logical body text, not that serialization artifact.
    const raw = await fs.readFile(ticketPath, 'utf-8');
    const content = matter(raw).content;
    return content.endsWith('\n') ? content.slice(0, -1) : content;
  }

  async function readFrontmatter(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(ticketPath, 'utf-8');
    return matter(raw).data;
  }

  beforeEach(async () => {
    fluxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-body-cas-'));
    ticketPath = path.join(fluxDir, `${taskId}.md`);
    await writeTicketDirect('original body');

    getWorkspace().tasks[taskId] = {
      id: taskId,
      title: 'CAS test ticket',
      status: 'In Progress',
      swimlane: null,
      history: [],
      _path: ticketPath,
    };
  });

  afterEach(async () => {
    delete getWorkspace().tasks[taskId];
    vi.restoreAllMocks();
    await fs.rm(fluxDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a stale-baseBodyVersion write after a second writer already landed (lost-update race), and does not clobber the second writer\'s body', async () => {
    // A reads the body and captures its version (v0) before anyone has written.
    const v0 = computeBodyVersion(await readBody());

    // B writes first (using the same v0, since B also read before A's write attempt below),
    // bumping the on-disk version to v1.
    await updateTaskWithHistory(taskId, { newBody: 'second writer body', baseBodyVersion: v0 });

    // A now attempts its write using the stale v0 it captured before B's write landed.
    await expect(
      updateTaskWithHistory(taskId, { newBody: 'first writer body (stale, should be rejected)', baseBodyVersion: v0 }),
    ).rejects.toThrow(StaleBodyError);

    // B's body must survive untouched — the defining assertion of this regression test.
    const onDiskBody = await readBody();
    expect(onDiskBody).toBe('second writer body');
    expect(onDiskBody).not.toBe('first writer body (stale, should be rejected)');
  });

  it('a thrown StaleBodyError carries the current on-disk bodyVersion so the caller can re-read and retry', async () => {
    const v0 = computeBodyVersion(await readBody());
    await updateTaskWithHistory(taskId, { newBody: 'winner body', baseBodyVersion: v0 });
    const currentVersion = computeBodyVersion(await readBody());

    let caught: unknown;
    try {
      await updateTaskWithHistory(taskId, { newBody: 'loser body', baseBodyVersion: v0 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StaleBodyError);
    expect((caught as InstanceType<typeof StaleBodyError>).currentBodyVersion).toBe(currentVersion);
  });

  it('succeeds and persists the new body when baseBodyVersion matches the current on-disk version', async () => {
    const v0 = computeBodyVersion(await readBody());
    await updateTaskWithHistory(taskId, { newBody: 'updated body', baseBodyVersion: v0 });
    expect(await readBody()).toBe('updated body');
  });

  it('succeeds (grandfathered) when baseBodyVersion is omitted entirely, same as pre-CAS behavior, and logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await updateTaskWithHistory(taskId, { newBody: 'grandfathered body write' });

    expect(await readBody()).toBe('grandfathered body write');
    expect(warnSpy).toHaveBeenCalled();
    const warnedAboutBody = warnSpy.mock.calls.some((call) => String(call[0]).toLowerCase().includes('body'));
    expect(warnedAboutBody).toBe(true);
  });

  it('a stale baseBodyVersion does not block a metadata-only update (no newBody in options)', async () => {
    const v0 = computeBodyVersion(await readBody());
    // A second writer changes the body, invalidating v0.
    await updateTaskWithHistory(taskId, { newBody: 'changed body', baseBodyVersion: v0 });

    // Metadata-only update carries the now-stale v0 but no newBody — must succeed unaffected.
    await expect(
      updateTaskWithHistory(taskId, { extraFields: { priority: 'High' }, baseBodyVersion: v0 }),
    ).resolves.not.toThrow();

    const frontmatter = await readFrontmatter();
    expect(frontmatter.priority).toBe('High');
    expect(await readBody()).toBe('changed body');
  });

  it('computeBodyVersion hashes a large multi-KB body correctly and the CAS compare still gates it', async () => {
    const largeBody = 'x'.repeat(20_000) + '\nEND';
    await writeTicketDirect(largeBody);
    const v0 = computeBodyVersion(await readBody());

    await updateTaskWithHistory(taskId, { newBody: largeBody + ' amended', baseBodyVersion: v0 });
    expect(await readBody()).toBe(largeBody + ' amended');

    // A second write reusing the now-stale large-body version must still be rejected.
    await expect(
      updateTaskWithHistory(taskId, { newBody: 'clobber attempt', baseBodyVersion: v0 }),
    ).rejects.toThrow(StaleBodyError);
  });

  it('computeBodyVersion is a stable, deterministic hash and distinguishes bodies that differ only by a trailing newline', () => {
    const withoutNewline = 'same content';
    const withNewline = 'same content\n';

    expect(computeBodyVersion(withoutNewline)).toBe(computeBodyVersion(withoutNewline));
    expect(computeBodyVersion(withNewline)).toBe(computeBodyVersion(withNewline));
    expect(computeBodyVersion(withoutNewline)).not.toBe(computeBodyVersion(withNewline));
  });
});
