import type { CliFramework } from './types';

/**
 * Resolves the effective agent framework to use, following the 'auto' -> 'claude' logic.
 */
export function resolveEffectiveAgent(target: string | undefined, defaultAgent: string | undefined): CliFramework {
  const framework = target || defaultAgent || 'auto';
  return (framework === 'auto' ? 'claude' : framework) as CliFramework;
}

export function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 1) return '…';
  const available = maxLen - 1;
  const startLen = Math.ceil(available / 2);
  const endLen = Math.floor(available / 2);
  if (endLen === 0) return str.slice(0, startLen) + '…';
  return str.slice(0, startLen) + '…' + str.slice(-endLen);
}
