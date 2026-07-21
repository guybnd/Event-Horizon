import type { AuthDiagnosis } from '../types';

/** FLUX-1601: verdict → user-facing headline + remedy, split out of prose (unlike the engine's
 *  `formatAuthDiagnosisMessage`, which the raw chat error line still uses) so the chat card and the
 *  Furnace halt banner can render structure and a copy button gets an exact string, not scraped
 *  prose. `command` is set only for the single unambiguous, safe-to-copy remedy (`claude login`) —
 *  binary-divergence/duplicate-installs/shadowed-credentials name the exact file/path/env var but
 *  stop short of prescribing a destructive shell command (removing an install, editing a settings
 *  file) since that's a per-machine judgment call the user has to make, not paste-and-run.
 */
export interface AuthRemedy {
  headline: string;
  detail: string;
  command?: string;
}

export function describeAuthRemedy(diagnosis?: AuthDiagnosis | null): AuthRemedy {
  if (!diagnosis || diagnosis.verdict === 'unknown') {
    return {
      headline: 'Not authenticated',
      detail: diagnosis
        ? "Self-diagnostics couldn't pin down the cause. Try `claude login`, or check for multiple claude installs or a settings.json override."
        : "Run `claude login`, then come back — we'll retry automatically.",
      command: 'claude login',
    };
  }
  switch (diagnosis.verdict) {
    case 'binary-divergence': {
      const spawned = `${diagnosis.spawnedBinary.path || 'unknown'}${diagnosis.spawnedBinary.version ? ` (v${diagnosis.spawnedBinary.version})` : ''}`;
      const terminal = diagnosis.terminalBinary?.path
        ? `${diagnosis.terminalBinary.path}${diagnosis.terminalBinary.version ? ` (v${diagnosis.terminalBinary.version})` : ''}`
        : (diagnosis.terminalBinary?.resolution || 'a different binary');
      return {
        headline: 'Two different `claude` binaries',
        detail: `Your terminal resolves ${terminal}, but the app spawned ${spawned}. Remove the stale install or fix PATH so both resolve the same binary, then retry.`,
      };
    }
    case 'duplicate-installs':
      return {
        headline: 'Multiple claude installs on PATH',
        detail: `Found ${diagnosis.duplicates.length} installs (${diagnosis.duplicates.join(', ')}). One likely holds a stale credential — remove the duplicate(s) and keep the one you use to log in, then retry.`,
      };
    case 'shadowed-credentials': {
      const causes = [
        diagnosis.shadowing.settingsKey && 'settings.json env.ANTHROPIC_API_KEY',
        diagnosis.shadowing.settingsHelper && 'settings.json apiKeyHelper',
        diagnosis.shadowing.envKey && 'an ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN environment variable',
        diagnosis.shadowing.baseUrl && 'an ANTHROPIC_BASE_URL override',
      ].filter(Boolean).join(', ');
      return {
        headline: 'A credential override is shadowing your login',
        detail: `${causes} is overriding your logged-in credential. Remove or update the override, then retry.`,
      };
    }
    case 'token-rejected':
    default:
      return {
        headline: 'Your credential was rejected',
        detail: "Run `claude login` to refresh your credentials — we'll retry automatically once you're re-authenticated.",
        command: 'claude login',
      };
  }
}
