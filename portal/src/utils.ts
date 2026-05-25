import type { CliFramework } from './types';

/**
 * Resolves the effective agent framework to use, following the 'auto' -> 'claude' logic.
 */
export function resolveEffectiveAgent(target: string | undefined, defaultAgent: string | undefined): CliFramework {
  const framework = target || defaultAgent || 'auto';
  return (framework === 'auto' ? 'claude' : framework) as CliFramework;
}
