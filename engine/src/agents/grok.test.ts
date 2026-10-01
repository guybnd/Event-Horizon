import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildGrokArgs,
  grokMcpConfigToml,
  grokSessionUuid,
  projectGrokConfigConflict,
  seedGrokAuth,
  wireGrokChildLifetime,
  grokWorkerPidsFromPs,
  type GrokArgOpts,
} from './grok.js';
import type { CliSessionRecord } from './types.js';

describe('buildGrokArgs (FLUX-1722 decision 6)', () => {
  const base: GrokArgOpts = {
    isResume: false,
    sessionId: '5319e9b0-de5a-41c9-a395-7aba59570cba',
    executionRoot: 'C:\\wt',
    promptFile: 'C:\\tmp\\prompt.txt',
    model: 'grok-4.6',
    effort: 'high',
  };

  it('spawn emits -s <uuid> and never -r', () => {
    const args = buildGrokArgs(base);
    expect(args).toContain('-s');
    expect(args[args.indexOf('-s') + 1]).toBe(base.sessionId);
    expect(args).not.toContain('-r');
    expect(args).toContain('--trust');
    expect(args).toContain('--always-approve');
    expect(args).toContain('--prompt-file');
    expect(args).toContain('--reasoning-effort');
    expect(args).toContain('streaming-messages-json');
  });

  it('resume emits -r <uuid> and never -s', () => {
    const args = buildGrokArgs({ ...base, isResume: true });
    expect(args).toContain('-r');
    expect(args[args.indexOf('-r') + 1]).toBe(base.sessionId);
    expect(args).not.toContain('-s');
  });
});

describe('grokSessionUuid', () => {
  it('reuses a UUID-shaped session.id', () => {
    const session = { id: '5319e9b0-de5a-41c9-a395-7aba59570cba' } as CliSessionRecord;
    expect(grokSessionUuid(session)).toBe(session.id);
  });

  it('prefers resumeSessionId when already set', () => {
    const session = {
      id: '5319e9b0-de5a-41c9-a395-7aba59570cba',
      resumeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    } as CliSessionRecord;
    expect(grokSessionUuid(session)).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});

describe('GROK_HOME helpers (FLUX-1722 decision 3)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-grok-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('emits TOML with ${VAR} header placeholders', () => {
    const toml = grokMcpConfigToml(3067);
    expect(toml).toContain('url = "http://127.0.0.1:3067/mcp"');
    expect(toml).toContain('X-EH-Session-Id = "${EH_SESSION_ID}"');
    expect(toml).toContain('X-EH-Session-Token = "${EH_SESSION_TOKEN}"');
  });

  it('seedGrokAuth copies when dest is absent and refreshes when source is newer', () => {
    const src = path.join(tmp, 'src-auth.json');
    fs.writeFileSync(src, '{"token":"a"}');
    const home = path.join(tmp, 'home');
    expect(seedGrokAuth(home, src)).toBe('copied');
    expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe('{"token":"a"}');

    const older = Date.now() - 60_000;
    fs.utimesSync(path.join(home, 'auth.json'), older / 1000, older / 1000);
    fs.writeFileSync(src, '{"token":"b"}');
    expect(seedGrokAuth(home, src)).toBe('refreshed');
    expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe('{"token":"b"}');
  });

  it('seedGrokAuth keeps dest when it is newer than source', () => {
    const src = path.join(tmp, 'src-auth.json');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(src, '{"token":"old"}');
    const dest = path.join(home, 'auth.json');
    fs.writeFileSync(dest, '{"token":"new"}');
    const newer = Date.now() + 60_000;
    fs.utimesSync(dest, newer / 1000, newer / 1000);
    expect(seedGrokAuth(home, src)).toBe('kept');
    expect(fs.readFileSync(dest, 'utf8')).toBe('{"token":"new"}');
  });

  it('projectGrokConfigConflict warns and does not require rewriting the file', () => {
    const execRoot = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(execRoot, '.grok'), { recursive: true });
    const file = path.join(execRoot, '.grok', 'config.toml');
    const original = '[mcp_servers.event-horizon]\nurl = "http://example.invalid/mcp"\n';
    fs.writeFileSync(file, original);
    const warning = projectGrokConfigConflict(execRoot);
    expect(warning).toMatch(/event-horizon/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('projectGrokConfigConflict is silent for the installer-owned placeholder entry', () => {
    const execRoot = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(execRoot, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(execRoot, '.grok', 'config.toml'), grokMcpConfigToml(3067));
    expect(projectGrokConfigConflict(execRoot)).toBeNull();
  });
});

describe('grokWorkerPidsFromPs', () => {
  const uuid = '5319e9b0-de5a-41c9-a395-7aba59570cba';

  it('selects grok workers with -s/-r and the session uuid, not the leader', () => {
    const ps = [
      `  11 /usr/bin/grok --trust`,
      `  22 /usr/bin/grok --output-format streaming-messages-json -s ${uuid}`,
      `  33 /usr/bin/grok -r ${uuid} --prompt-file /tmp/p`,
      `  44 node /app/grok-helper ${uuid}`,
      `  55 /usr/bin/grok.exe -s ${uuid}`,
    ].join('\n');
    expect(grokWorkerPidsFromPs(ps, uuid)).toEqual([22, 33, 55]);
  });

  it('returns empty for a blank session id', () => {
    expect(grokWorkerPidsFromPs('22 grok -s abc', '')).toEqual([]);
  });
});

describe('wireGrokChildLifetime', () => {
  it('fires once when exit arrives after bind', () => {
    const proc = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null };
    proc.exitCode = null;
    proc.signalCode = null;
    const onEnd = vi.fn();
    wireGrokChildLifetime(proc, onEnd);
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(0, null);
  });

  it('fires on close if exit never arrives', () => {
    const proc = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null };
    proc.exitCode = null;
    proc.signalCode = null;
    const onEnd = vi.fn();
    wireGrokChildLifetime(proc, onEnd);
    proc.emit('close', 1, null);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(1, null);
  });

  it('catches a process that already exited before bind', async () => {
    const proc = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null };
    proc.exitCode = 0;
    proc.signalCode = null;
    const onEnd = vi.fn();
    wireGrokChildLifetime(proc, onEnd);
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledOnce());
    expect(onEnd).toHaveBeenCalledWith(0, null);
  });
});
