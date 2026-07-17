// FLUX-1480: skill modules declare their delivery surface (auto-injected into a phase's session
// prelude vs. concatenated into Option-A installs vs. pull-only via `read_skill`) via a `delivery:`
// frontmatter array. This test is the "reality-agreement" half — the label alone is just a claim; it
// only prevents drift (the PR #584 defect class, where FLUX-1469's plan moved content into the review
// module not knowing review-phase spawns get it INJECTED) if it's asserted against the engine's own
// wiring, not hand-copied prose. `isInjectablePhaseModule` (skill-modules.ts) and `PULL_ONLY_MODULES`
// (workflow-installer.ts) ARE that wiring — this test derives each module's expected tag set from
// them directly, so a future change to either source (without a matching frontmatter update) fails
// here instead of silently drifting.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { SKILL_MODULES, PULL_ONLY_MODULES, type SkillModule } from './workflow-installer.js';
import { isInjectablePhaseModule } from './skill-modules.js';
import { resolveSkillSourceRoot } from './workspace.js';

const KNOWN_TAGS = new Set([
  'injected:grooming',
  'injected:implementation',
  'injected:review',
  'pull-only',
  'concatenated',
  'modular',
]);

async function loadFrontmatter(module: SkillModule): Promise<Record<string, unknown>> {
  const file = path.join(resolveSkillSourceRoot(), '.docs', 'skills', `event-horizon-${module}.md`);
  const raw = await fs.readFile(file, 'utf8');
  return matter(raw).data;
}

/** The tag set each module MUST carry, derived from the engine's actual injection/concatenation
 *  wiring — not a hand-maintained duplicate list. */
function expectedTags(module: SkillModule): string[] {
  const tags: string[] = [];
  if (isInjectablePhaseModule(module)) {
    tags.push(`injected:${module}`);
  } else {
    tags.push('pull-only');
  }
  if (!PULL_ONLY_MODULES.includes(module)) tags.push('concatenated');
  tags.push('modular'); // every SKILL_MODULES entry is installed per-file for modular frameworks
  return tags;
}

describe('skill module delivery frontmatter (FLUX-1480)', () => {
  it('every module has a delivery: array drawn from the known vocabulary', async () => {
    for (const module of SKILL_MODULES) {
      const data = await loadFrontmatter(module);
      expect(Array.isArray(data.delivery), `event-horizon-${module}.md: delivery must be an array`).toBe(true);
      const delivery = data.delivery as unknown[];
      expect(delivery.length, `event-horizon-${module}.md: delivery must not be empty`).toBeGreaterThan(0);
      for (const tag of delivery) {
        expect(KNOWN_TAGS.has(tag as string), `event-horizon-${module}.md: unknown delivery tag ${JSON.stringify(tag)}`).toBe(true);
      }
    }
  });

  it('delivery labels agree with the engine\'s actual injection/concatenation wiring', async () => {
    for (const module of SKILL_MODULES) {
      const data = await loadFrontmatter(module);
      const delivery = [...(data.delivery as string[])].sort();
      const expected = expectedTags(module).sort();
      expect(delivery, `event-horizon-${module}.md: delivery frontmatter drifted from engine reality`).toEqual(expected);
    }
  });

  it('injectable phase modules (grooming/implementation/review) are the ONLY modules tagged injected:*', async () => {
    for (const module of SKILL_MODULES) {
      const data = await loadFrontmatter(module);
      const delivery = data.delivery as string[];
      const hasInjectedTag = delivery.some((tag) => tag.startsWith('injected:'));
      expect(hasInjectedTag, `event-horizon-${module}.md`).toBe(isInjectablePhaseModule(module));
    }
  });

  it('pull-only modules (tools) are excluded from concatenation', async () => {
    for (const module of PULL_ONLY_MODULES) {
      const data = await loadFrontmatter(module);
      const delivery = data.delivery as string[];
      expect(delivery, `event-horizon-${module}.md`).not.toContain('concatenated');
      expect(delivery, `event-horizon-${module}.md`).toContain('pull-only');
    }
  });

  // FLUX-1480 review follow-up: the human-readable warning lives in FRONTMATTER (`deliveryNote:`),
  // not the body — gray-matter strips frontmatter from injection and concatenation, so editors see
  // the warning at the top of the file while no session prelude pays for it. This assertion keeps
  // the AC's "visible one-line delivery warning" enforced in its zero-cost home.
  it('every module carries a non-empty deliveryNote warning in frontmatter (never the body)', async () => {
    for (const module of SKILL_MODULES) {
      const data = await loadFrontmatter(module);
      expect(typeof data.deliveryNote, `event-horizon-${module}.md: deliveryNote missing`).toBe('string');
      expect((data.deliveryNote as string).length, `event-horizon-${module}.md: deliveryNote empty`).toBeGreaterThan(40);
    }
  });
});
