import { describe, it, expect } from 'vitest';
import {
  accumulateAntigravityUsage,
  antigravityNoOpTurnError,
  antigravityProgressMessage,
  antigravityPromptDeliveryError,
  antigravityUserBinaryPath,
  buildAntigravityArgs,
  clampAntigravityEffort,
  classifyAntigravityTerminalReason,
} from './antigravity.js';
import type { CliSessionRecord } from './types.js';

/** Minimal stand-in — accumulateAntigravityUsage only touches the token/cost fields. */
function fakeSession(model?: string): CliSessionRecord {
  return { model } as CliSessionRecord;
}

describe('buildAntigravityArgs (FLUX-1738)', () => {
  it('always sends stream-json and a print timeout, never -p (FLUX-1751)', () => {
    const args = buildAntigravityArgs({});
    expect(args.slice(0, 2)).toEqual(['--output-format', 'stream-json']);
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--print');
    // The default --print-timeout is 5 MINUTES; without an override every real session dies at
    // exactly 5:00 with a clean exit and a truncated transcript.
    expect(args).toContain('--print-timeout');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('24h');
  });

  it('never emits a Gemini CLI flag — none of them exist on agy', () => {
    const args = buildAntigravityArgs({
      conversationId: 'abc',
      model: 'gemini-3.1-pro-high',
      effort: 'high',
      skipPermissions: true,
    });
    for (const dead of ['--yolo', '--resume', '--screen-reader', '--skip-trust', '--include-directories']) {
      expect(args, `${dead} is a Gemini CLI flag and is rejected by agy`).not.toContain(dead);
    }
  });

  it('resumes with --conversation, not --resume', () => {
    const args = buildAntigravityArgs({ conversationId: 'ab482aad-36e3-4f95-880e-2102207a74ce' });
    expect(args).toContain('--conversation');
    expect(args[args.indexOf('--conversation') + 1]).toBe('ab482aad-36e3-4f95-880e-2102207a74ce');
  });

  it('omits --conversation entirely on a fresh spawn', () => {
    expect(buildAntigravityArgs({})).not.toContain('--conversation');
    expect(buildAntigravityArgs({ conversationId: undefined })).not.toContain('--conversation');
  });

  it('gates permissions behind --dangerously-skip-permissions', () => {
    expect(buildAntigravityArgs({ skipPermissions: true })).toContain('--dangerously-skip-permissions');
    expect(buildAntigravityArgs({ skipPermissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('passes group scope args through verbatim (agy takes --add-dir natively)', () => {
    const args = buildAntigravityArgs({ scopeArgs: ['--add-dir', 'C:\\repos\\other'] });
    expect(args).toContain('--add-dir');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('C:\\repos\\other');
  });

  it('sends effort as a flag and never as a model-slug suffix', () => {
    const args = buildAntigravityArgs({ model: 'gemini-3.8-flash-medium', effort: 'high' });
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash-medium');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });
});

describe('antigravityPromptDeliveryError (FLUX-1751)', () => {
  // The originally shipped adapter passed `-p ''` with the prompt on stdin, which agy rejects with
  // `Error: empty prompt`. No test covered the prompt-delivery contract at all, which is exactly
  // why it reached a real session.
  it('refuses an empty or whitespace-only prompt — agy HANGS on empty stdin', () => {
    // Probed: empty stdin with no `-p` was still alive at 75s under `--print-timeout 20s`, i.e. its
    // own timeout does not interrupt it. Production PRINT_TIMEOUT is 24h.
    for (const empty of ['', '   ', '\n\n', '\t \n']) {
      const err = antigravityPromptDeliveryError(empty);
      expect(err, `${JSON.stringify(empty)} must be refused`).toBeTruthy();
      expect(err).toMatch(/empty prompt/i);
    }
  });

  it('accepts an ordinary prompt, and does NOT impose a guessed size ceiling', () => {
    expect(antigravityPromptDeliveryError('Groom FLUX-1 and report back.')).toBeNull();
    // Deliberate: probing suggested a large-stdin drop but the data was non-monotonic AND the test
    // account hit its quota mid-run, so size vs. throttling is unresolved. A threshold guessed from
    // that would block legitimate turns; antigravityNoOpTurnError guards the symptom instead.
    expect(antigravityPromptDeliveryError('x'.repeat(60_000))).toBeNull();
  });
});

describe('antigravityNoOpTurnError (FLUX-1751)', () => {
  it('flags a SUCCESS that consumed no tokens and said nothing', () => {
    // Observed live: {"status":"SUCCESS","response":"","usage":{"input_tokens":0,…}}. Left alone the
    // exit handler marks the session completed and posts an empty completion comment.
    const err = antigravityNoOpTurnError({ status: 'SUCCESS', response: '', usage: { input_tokens: 0 } });
    expect(err).toBeTruthy();
    expect(err).toMatch(/0 input tokens/);
  });

  it('passes a real turn through', () => {
    expect(antigravityNoOpTurnError({ status: 'SUCCESS', response: 'PONG\n', usage: { input_tokens: 13705 } })).toBeNull();
  });

  it('does not flag a turn that spent tokens but replied only with tool work', () => {
    // A turn can legitimately end with an empty final response (all work done via tools) — tokens
    // spent is the proof a model call happened, so that alone must not be flagged.
    expect(antigravityNoOpTurnError({ status: 'SUCCESS', response: '', usage: { input_tokens: 9000 } })).toBeNull();
  });

  it('leaves non-SUCCESS results to the explicit error path', () => {
    expect(antigravityNoOpTurnError({ status: 'ERROR', response: '', usage: { input_tokens: 0 } })).toBeNull();
    expect(antigravityNoOpTurnError(undefined)).toBeNull();
  });
});

describe('classifyAntigravityTerminalReason (FLUX-1751)', () => {
  it('classifies the real quota string as rate-limited, not auth', () => {
    // Verbatim from a live run: this must make the Furnace cool down and retry at the reset window,
    // NOT park the ticket, and NOT halt the batch the way an auth classification would.
    expect(classifyAntigravityTerminalReason(
      'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 154h27m15s.',
    )).toBe('rate-limited');
  });

  it('classifies auth and context exhaustion', () => {
    expect(classifyAntigravityTerminalReason('Print mode: not authenticated, trying silent auth')).toBe('auth-expired');
    expect(classifyAntigravityTerminalReason('context length exceeded')).toBe('context-exhausted');
  });

  it('leaves an ordinary error unclassified rather than guessing', () => {
    expect(classifyAntigravityTerminalReason('invalid --effort "xhigh" (valid: low, medium, high)')).toBeUndefined();
    expect(classifyAntigravityTerminalReason(undefined)).toBeUndefined();
    expect(classifyAntigravityTerminalReason('')).toBeUndefined();
  });
});

describe('clampAntigravityEffort (FLUX-1738)', () => {
  it('passes through the three levels agy accepts', () => {
    expect(clampAntigravityEffort('low')).toBe('low');
    expect(clampAntigravityEffort('medium')).toBe('medium');
    expect(clampAntigravityEffort('high')).toBe('high');
  });

  it('clamps EH-only levels to high rather than sending a value agy rejects', () => {
    // Probed live: `--effort xhigh` -> `invalid --effort "xhigh" (valid: low, medium, high)`.
    expect(clampAntigravityEffort('xhigh')).toBe('high');
    expect(clampAntigravityEffort('max')).toBe('high');
  });

  it('drops an unknown or empty effort instead of guessing', () => {
    expect(clampAntigravityEffort(undefined)).toBeUndefined();
    expect(clampAntigravityEffort('')).toBeUndefined();
    expect(clampAntigravityEffort('turbo')).toBeUndefined();
  });
});

describe('accumulateAntigravityUsage (FLUX-1738)', () => {
  it('accumulates per-step usage', () => {
    const session = fakeSession('gemini-3.1-pro-high');
    accumulateAntigravityUsage(session, { input_tokens: 13705, output_tokens: 25, thinking_tokens: 23, cache_read_tokens: 0, total_tokens: 13730 });
    expect(session.inputTokens).toBe(13705);
    expect(session.outputTokens).toBe(25);
    // thinking_tokens is a SUBSET of output_tokens (probed: total 13730 = 13705 + 25, thinking not
    // counted separately), so it must never be added on top.
    expect(session.outputTokens).not.toBe(25 + 23);
    expect(session.costIsEstimated).toBe(true);
  });

  it('sums the two turns of the probed conversation to exactly result.usage — no double count', () => {
    // The real trap this guards: `result.usage` is CUMULATIVE across the conversation. Turn 2's
    // result reported input_tokens 27646, which is 13705 + 13941 — i.e. the SUM of both turns' own
    // per-step figures. Accumulating per-step usage must therefore reproduce it exactly; adding
    // result.usage as well would report 41351.
    const session = fakeSession('gemini-3.1-pro-high');
    accumulateAntigravityUsage(session, { input_tokens: 13705, output_tokens: 25 });
    accumulateAntigravityUsage(session, { input_tokens: 13941, output_tokens: 36 });
    expect(session.inputTokens).toBe(27646);
    expect(session.outputTokens).toBe(61);
  });

  it('tracks cache reads and does not bill them at the fresh-input rate', () => {
    const cached = fakeSession('gemini-3.1-pro-high');
    accumulateAntigravityUsage(cached, { input_tokens: 10_000, output_tokens: 100, cache_read_tokens: 9_000 });
    const fresh = fakeSession('gemini-3.1-pro-high');
    accumulateAntigravityUsage(fresh, { input_tokens: 10_000, output_tokens: 100, cache_read_tokens: 0 });
    expect(cached.cacheReadTokens).toBe(9_000);
    expect(cached.inputTokens).toBe(10_000);
    expect(cached.costUSD!).toBeLessThan(fresh.costUSD!);
  });

  it('ignores an absent or all-zero usage block', () => {
    const session = fakeSession();
    accumulateAntigravityUsage(session, undefined);
    // The ERROR result of a rejected --effort reports an all-zero usage block.
    accumulateAntigravityUsage(session, { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 });
    expect(session.inputTokens).toBeUndefined();
    expect(session.costUSD).toBeUndefined();
  });
});

describe('antigravityProgressMessage (FLUX-1738)', () => {
  it('reads agy\'s PascalCase parameter keys', () => {
    // Gemini's parser looks for `file_path`/`command`; agy emits `TargetFile`/`CommandLine`. Using
    // the lowercase keys degrades silently to the bare activity label rather than crashing, which
    // is precisely why this is pinned.
    expect(antigravityProgressMessage('view_file', { TargetFile: 'C:\\repo\\src\\index.ts' }, 'Reading')).toBe('Reading index.ts');
    expect(antigravityProgressMessage('write_to_file', { TargetFile: '/repo/a/b.ts' }, 'Editing')).toBe('Writing b.ts');
    expect(antigravityProgressMessage('replace_file_content', { TargetFile: '/repo/a/b.ts' }, 'Editing')).toBe('Editing b.ts');
    expect(antigravityProgressMessage('run_command', { CommandLine: 'npm run check' }, 'Running command')).toBe('Running: npm run check');
    expect(antigravityProgressMessage('find_by_name', { Pattern: '*probe.txt*' }, 'Searching')).toBe('Searching *probe.txt*');
    expect(antigravityProgressMessage('list_dir', { DirectoryPath: '/repo/src' }, 'Reading')).toBe('Reading src');
  });

  it('truncates a long command', () => {
    const long = 'x'.repeat(80);
    const msg = antigravityProgressMessage('run_command', { CommandLine: long }, 'Running command');
    expect(msg).toBe(`Running: ${'x'.repeat(50)}...`);
  });

  it('falls back to the activity label for unknown tools or missing params', () => {
    expect(antigravityProgressMessage('some_future_tool', { TargetFile: 'a.ts' }, 'Working')).toBe('Working');
    expect(antigravityProgressMessage('view_file', {}, 'Reading')).toBe('Reading');
    expect(antigravityProgressMessage('view_file', undefined, 'Reading')).toBe('Reading');
    expect(antigravityProgressMessage(undefined, { TargetFile: 'a.ts' }, 'Reading')).toBe('Reading');
    // A non-string parameter value must not throw or stringify into the label.
    expect(antigravityProgressMessage('view_file', { TargetFile: 42 }, 'Reading')).toBe('Reading');
  });

  it('names the MCP tool for a call_mcp_tool step', () => {
    expect(antigravityProgressMessage('call_mcp_tool', { ToolName: 'get_ticket' }, 'Working')).toBe('Calling get_ticket');
  });
});

describe('antigravityUserBinaryPath (FLUX-1738)', () => {
  it('points at the real Windows install location, not the documented ~/.local/bin', () => {
    if (process.platform !== 'win32') return;
    const p = antigravityUserBinaryPath();
    // Probed: the installer drops it here, and it is NOT on a non-login shell's PATH — so a
    // `where agy` preflight would false-negative a working install.
    expect(p.endsWith(['agy', 'bin', 'agy.exe'].join('\\'))).toBe(true);
    expect(p).not.toContain('Programs');
  });
});
