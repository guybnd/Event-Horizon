// FLUX-1377: synchronous phase-skill-module loader for `buildInitialPrompt` (agents/shared.ts),
// which is called synchronously from every CLI adapter's spawn path — an async file read there
// would ripple into every caller. Mirrors mcp-server.ts's `loadSkillModuleBody` (FLUX-951, async,
// serves the `/groom`/`/implement`/`/release` MCP prompts) but reads sync and covers 'review' too,
// which FLUX-951 doesn't expose as a prompt. Kept separate rather than unified: the two call sites
// have different sync/async constraints and failure just degrades to a fallback string either way.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { log } from './log.js';
import { resolveSkillSourceRoot } from './workspace.js';

export type InjectablePhaseModule = 'grooming' | 'implementation' | 'review';

const INJECTABLE_PHASE_MODULES: readonly InjectablePhaseModule[] = ['grooming', 'implementation', 'review'];

export function isInjectablePhaseModule(phase: string | undefined): phase is InjectablePhaseModule {
  return !!phase && (INJECTABLE_PHASE_MODULES as readonly string[]).includes(phase);
}

/** Module-scope memo — read once per engine process; a repaired file is picked up on restart
 * (matches mcp-server.ts's loadSkillModuleBody memoization policy). */
const bodyMemo = new Map<InjectablePhaseModule, string>();

/** Read a phase skill module body (frontmatter stripped), or null when unreadable — never
 * throws, so a missing module degrades to a fallback prompt instead of breaking a spawn. */
export function loadSkillModuleBodySync(module: InjectablePhaseModule): string | null {
  const memoized = bodyMemo.get(module);
  if (memoized !== undefined) return memoized;
  const file = path.join(resolveSkillSourceRoot(), '.docs', 'skills', `event-horizon-${module}.md`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const body = matter(raw).content.trim();
    if (!body) throw new Error('module body is empty');
    bodyMemo.set(module, body);
    return body;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Phase skill module '${module}' unreadable at ${file}: ${message}`);
    return null;
  }
}

export function skillModuleFallback(module: InjectablePhaseModule): string {
  return `(The Event Horizon ${module} skill module could not be read on this install. Proceed with the core rules and tool descriptions — they carry the invariants: get_ticket before acting, change_status for column moves, end the turn on a board action.)`;
}
