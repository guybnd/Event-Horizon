import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { CORE_INVARIANTS, CORE_SKILL_VERSION, buildCoreInstructionsBlock, buildCoreSkillDocument } from './skill-core.js';
import { resolveSkillSourceRoot } from './workspace.js';
import { SKILL_MODULES } from './workflow-installer.js';

// FLUX-1377: the MCP `instructions` block (mcp-server.ts) and the installed Claude core
// (workflow-installer.ts) must render the SAME invariant bullets — this is the AC3 "unit
// drift-guard": if someone edits one without the other, this test catches it because both are
// asserted straight from the single CORE_INVARIANTS source.
describe('CORE_INVARIANTS single-source (AC3 drift guard)', () => {
  it('every invariant bullet appears verbatim in both the MCP instructions block and the installed core doc', () => {
    const instructions = buildCoreInstructionsBlock();
    const coreDoc = buildCoreSkillDocument();
    for (const rule of CORE_INVARIANTS) {
      expect(instructions).toContain(rule);
      expect(coreDoc).toContain(rule);
    }
  });

  it('the installed core doc embeds a version line matching CORE_SKILL_VERSION', () => {
    expect(buildCoreSkillDocument()).toContain(`Version: ${CORE_SKILL_VERSION}`);
  });
});

describe('buildCoreSkillDocument size (AC1: installed core stays ~2-4k tokens)', () => {
  it('stays under the ~4k-token ceiling', () => {
    const doc = buildCoreSkillDocument();
    const tokensEst = Math.ceil(doc.length / 4);
    expect(tokensEst).toBeLessThan(4000);
  });

  it('carries the phase-routing table pointing at read_skill() pulls, not module file paths (FLUX-1466)', () => {
    const doc = buildCoreSkillDocument();
    expect(doc).toContain("read_skill('grooming')");
    expect(doc).toContain("read_skill('implementation')");
    expect(doc).toContain("read_skill('review')");
    // A user-repo session can't Read `.docs/skills/*.md` — those files only exist in the engine
    // install — so the routing table must never point at a bare file path again (FLUX-1466).
    expect(doc).not.toContain('.docs/skills/');
    // Sanity: the core is meaningfully smaller than the old ~17.4k-tok 6-module concatenation —
    // it should not accidentally inline a full module body.
    expect(doc.length).toBeLessThan(20_000);
  });
});

// FLUX-1466: locks shut the dangling-pointer class behind PR #580. A skill module (or the
// installed core) telling an agent to "see the <module> skill's <Section>" or "read it there"
// assumes the reader can open another module's file directly — true in THIS repo, false in
// every installed user repo (those files only exist in the engine's own install). The fix is
// `read_skill(module, section?)`; every load-bearing cross-module pointer must call it (or be
// deleted) instead of naming a module/file by prose. New prose danglers should fail this test.
describe('no dangling cross-module prose pointers (FLUX-1466)', () => {
  // Deliberately the same two shapes the ticket's plan named as the load-bearing dangler class —
  // narrow enough to avoid flagging legitimate descriptive mentions of another module's name
  // (e.g. "the grooming skill's convention", "distinct from the implementation skill") that
  // don't instruct the reader to go fetch content from it.
  const DANGLER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: 'see the <module> skill', pattern: /see the \S+ skill/i },
    { name: 'refer to the <module> skill', pattern: /refer to the \S+ skill/i },
    { name: '"read it there"', pattern: /read it there/i },
    { name: 'bare .docs/skills/ file path', pattern: /\.docs\/skills\//i },
  ];

  async function loadModuleBodies(): Promise<Array<{ name: string; text: string }>> {
    const root = resolveSkillSourceRoot();
    const bodies = await Promise.all(
      SKILL_MODULES.map(async (module) => {
        const file = path.join(root, '.docs', 'skills', `event-horizon-${module}.md`);
        const raw = await fs.readFile(file, 'utf8');
        return { name: `event-horizon-${module}.md`, text: matter(raw).content };
      }),
    );
    return [...bodies, { name: 'buildCoreSkillDocument()', text: buildCoreSkillDocument() }];
  }

  it('none of the six skill modules or the installed core reference another module by prose/file-path', async () => {
    const documents = await loadModuleBodies();
    const offenders: string[] = [];
    for (const { name, text } of documents) {
      for (const { name: patternName, pattern } of DANGLER_PATTERNS) {
        const match = pattern.exec(text);
        if (match) offenders.push(`${name}: matched "${patternName}" (${JSON.stringify(match[0])})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
