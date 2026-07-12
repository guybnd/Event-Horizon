import { describe, it, expect } from 'vitest';
import { CORE_INVARIANTS, CORE_SKILL_VERSION, buildCoreInstructionsBlock, buildCoreSkillDocument } from './skill-core.js';

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

  it('carries the phase-routing table pointing at the module files, not the module bodies themselves', () => {
    const doc = buildCoreSkillDocument();
    expect(doc).toContain('.docs/skills/event-horizon-grooming.md');
    expect(doc).toContain('.docs/skills/event-horizon-implementation.md');
    expect(doc).toContain('.docs/skills/event-horizon-review.md');
    // Sanity: the core is meaningfully smaller than the old ~17.4k-tok 6-module concatenation —
    // it should not accidentally inline a full module body.
    expect(doc.length).toBeLessThan(20_000);
  });
});
