import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import {
  antigravityUserBinaryPath,
  buildAntigravityArgs,
  resolveAntigravityBinary,
} from './antigravity.js';

/**
 * FLUX-1751: the test that SHOULD have existed for FLUX-1738.
 *
 * That ticket shipped `buildAntigravityArgs` returning `['-p', '', …]` with the prompt written to
 * stdin — the shape `gemini.ts` uses, where it genuinely works. `agy` rejects it outright:
 *
 *   {"status":"ERROR","error":"Error: empty prompt. Usage: agy --print \"your prompt here\""}
 *
 * Every unit test still passed, because they all asserted on the ARGV ARRAY and never once handed
 * that argv to the real binary. The adapter was probed extensively — but always with the prompt in
 * argv (`agy -p "text"`), never with the `-p '' `+ stdin combination the adapter actually shipped.
 * An argv-shape assertion cannot catch "this argv is invalid"; only a spawn can.
 *
 * So this file spawns the REAL `agy` with the REAL builder output and asserts a real answer comes
 * back. It is the only test here that can fail when the delivery contract breaks.
 *
 * skip-with-reason when the binary is absent (CI has no CLIs installed), so a skip always means
 * "binary absent" and never a silent pass. Note this deliberately does NOT use `where agy`: on
 * Windows `agy` is genuinely off-PATH on a working install (see antigravityUserBinaryPath), so a
 * PATH probe would skip on the very machine that can run it.
 */
function agyPresent(): boolean {
  if (existsSync(antigravityUserBinaryPath())) return true;
  return resolveAntigravityBinary() !== 'agy';
}

interface AgyResult {
  status?: string;
  response?: string;
  error?: string;
  usage?: { input_tokens?: number };
}

/** Spawn agy exactly the way the adapter does: builder argv + prompt over stdin. */
function runAgy(prompt: string, extraArgs: string[] = []): Promise<{ code: number | null; result: AgyResult | null; raw: string }> {
  const args = [...buildAntigravityArgs({ skipPermissions: true }), ...extraArgs];
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveAntigravityBinary(), args, { stdio: 'pipe', windowsHide: true });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.stderr.on('data', (c) => { out += c.toString(); });
    proc.on('error', reject);
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
    proc.on('close', (code) => {
      let result: AgyResult | null = null;
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const evt = JSON.parse(t) as { event?: string; result?: AgyResult };
          if (evt.event === 'result' && evt.result) result = evt.result;
        } catch { /* not a JSON event line */ }
      }
      resolve({ code, result, raw: out });
    });
  });
}

describe('antigravity live spawn — the builder argv actually drives agy (FLUX-1751)', () => {
  it.skipIf(!agyPresent())('a real turn returns a real answer over stdin', async () => {
    const { code, result, raw } = await runAgy('Reply with exactly the word PONG and nothing else.');

    // The regression guard, checked BEFORE the quota bail-out: `empty prompt` is an argv defect and
    // must fail the suite even on a throttled account. This is the exact string the shipped
    // `-p ''` shape produced.
    expect(raw, 'agy rejected the prompt as empty — argv is passing an empty --print value').not.toMatch(/empty prompt/i);

    // A quota-exhausted account is an environment condition, not an adapter regression — the real
    // string is `Individual quota reached. … Resets in 154h27m15s.` Skip rather than red-fail, so a
    // throttled machine never looks like broken code.
    if (/quota reached|rate limit/i.test(result?.error ?? raw)) {
      console.warn('[antigravity-live-spawn] skipped: agy account is quota-limited');
      return;
    }

    expect(result, `no result event in output:\n${raw.slice(0, 800)}`).toBeTruthy();
    expect(result!.status).toBe('SUCCESS');
    expect(result!.response ?? '').toMatch(/PONG/);
    // Silent-no-op guard: a dropped prompt reports SUCCESS with zero tokens and an empty response.
    expect(result!.usage?.input_tokens ?? 0).toBeGreaterThan(0);
    expect(code).toBe(0);
  }, 180_000);

  // A large-prompt ceiling test deliberately does NOT live here. Probing suggested large stdin
  // prompts could be dropped while still reporting SUCCESS, but the numbers were non-monotonic
  // (23KB dropped, 24KB delivered, 25/26KB dropped) and the account hit its usage quota during that
  // run — indistinguishable from throttling. Asserting a ceiling from that data would bake a wrong
  // number into the suite and burn quota on every run. The unresolved question is tracked as a
  // follow-up; `antigravityNoOpTurnError` guards the symptom in the meantime.
});
