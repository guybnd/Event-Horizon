import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';
import { SKILL_MODULES } from './workflow-installer.js';
import { resolveSkillSourceRoot } from './workspace.js';

/**
 * FLUX-1466: `read_skill(module, section?)` — the agent-callable pull that fixes the
 * dangling-cross-module-pointer class behind PR #580 (a phase module's "see the orchestrator
 * skill's X section" pointer assumes a file only the engine install carries, which doesn't
 * exist in a plain user repo). Covers the tool handler directly, over a real in-memory
 * MCP round-trip — same harness as mcp-prompts.test.ts / mcp-structured-output.test.ts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

describe('read_skill (FLUX-1466)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-read-skill-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  async function callReadSkill(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name: 'read_skill', arguments: input });
    if (!isCallToolResult(result)) throw new Error('expected a CallToolResult');
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent;
    if (!isRecord(structured)) throw new Error('expected structuredContent');
    return structured;
  }

  it('the allowlist is exactly the canonical SKILL_MODULES set', () => {
    expect(SKILL_MODULES).toEqual(['orchestrator', 'grooming', 'implementation', 'review', 'release', 'mapping', 'tools']);
  });

  it.each(SKILL_MODULES)('full read: %s returns its real body (not a fallback string)', async (module) => {
    const out = await callReadSkill({ module });
    expect(out.module).toBe(module);
    expect(out.section).toBeFalsy();
    expect(typeof out.body).toBe('string');
    expect((out.body as string).length).toBeGreaterThan(200);
    expect(out.body).not.toContain('could not be read on this install');
  });

  it('section: a matching `##` heading returns just that block', async () => {
    const out = await callReadSkill({ module: 'orchestrator', section: 'Rich Artifacts' });
    expect(out.section).toContain('Rich Artifacts');
    expect(out.body).toContain('publish_artifact');
    // Should NOT bleed into the next top-level section.
    expect(out.body).not.toContain('Ceremony by effort — scale mandated writing');
  });

  it('section: substring containment resolves a heading with a trailing qualifier', async () => {
    const out = await callReadSkill({ module: 'review', section: 'reviewState Contract' });
    expect(out.section).toContain('reviewState Contract');
    expect(out.body).toContain('Furnace and the board only ever read the structured');
  });

  // FLUX-1469: the plan-review gate's launch focus names this exact call
  // (`read_skill('orchestrator', 'Plan-review methodology')`) for its full check methodology —
  // assert it actually resolves, since a dangling pointer here would silently degrade every gate
  // review. (Orchestrator, not review: the review module is injected into review-phase preludes,
  // so parking pull-target content there would re-push it into every code review.)
  it("resolves the plan-review gate's exact pull call ('orchestrator', 'Plan-review methodology')", async () => {
    const out = await callReadSkill({ module: 'orchestrator', section: 'Plan-review methodology' });
    expect(out.section).toContain('Plan-review methodology');
    expect(out.body).toContain('Anchor check.');
    expect(out.body).toContain('Adversarial self-review');
  });

  it('section: no match returns the full body plus the available `##` heading list', async () => {
    const out = await callReadSkill({ module: 'grooming', section: 'Does Not Exist Anywhere' });
    expect(out.section).toBeFalsy();
    expect(out.body).toContain('No section titled "Does Not Exist Anywhere"');
    expect(Array.isArray(out.availableSections)).toBe(true);
    expect(out.availableSections as string[]).toContain('Grooming Workflow');
  });

  it('unknown module → graceful fallback string, never an error result', async () => {
    const result = await client.callTool({ name: 'read_skill', arguments: { module: 'not-a-real-module' } });
    if (!isCallToolResult(result)) throw new Error('expected a CallToolResult');
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.body).toContain('could not be read on this install');
    expect(out.module).toBe('not-a-real-module');
  });

  // PR #584 review m4: every `read_skill('X', 'Y')` literal shipped to agents — in a skill module
  // or a prompt-carrying engine source — must resolve: module in the allowlist, section matching a
  // real `##` heading. Closes the FLUX-1466 dangler class generically instead of pinning pointers
  // one by one; a heading rename or a typo'd pointer fails here, not silently in the field (the
  // tools module's own header calls its headings a wire contract).
  describe('every shipped read_skill(...) pointer resolves (generic dangler guard)', () => {
    const READ_SKILL_LITERAL_RE = /read_skill\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?\s*\)/g;
    /** Prompt-carrying sources outside .docs/skills/ that ship pointer literals to agents. */
    const ENGINE_POINTER_SOURCES = ['orchestration-personas.ts', 'gate-runner.ts', 'skill-core.ts', 'mcp-server.ts'];

    async function collectPointers(): Promise<Array<{ file: string; module: string; section: string | undefined }>> {
      const root = resolveSkillSourceRoot();
      const files = [
        ...SKILL_MODULES.map((m) => path.join(root, '.docs', 'skills', `event-horizon-${m}.md`)),
        ...ENGINE_POINTER_SOURCES.map((f) => path.join(root, 'engine', 'src', f)),
      ];
      const pointers: Array<{ file: string; module: string; section: string | undefined }> = [];
      for (const file of files) {
        const text = await fs.readFile(file, 'utf8');
        for (const match of text.matchAll(READ_SKILL_LITERAL_RE)) {
          const module = match[1]!;
          const section = match[2];
          // Skip documentation placeholders like read_skill('tools', '<tool-name>').
          if (module.includes('<') || section?.includes('<')) continue;
          pointers.push({ file: path.basename(file), module, section });
        }
      }
      return pointers;
    }

    it('the scan finds the known pointers at all (not silently empty)', async () => {
      const pointers = await collectPointers();
      expect(pointers.length).toBeGreaterThanOrEqual(5);
    });

    it('each pointer names an allowlisted module and a section that resolves to a real heading', async () => {
      const pointers = await collectPointers();
      const seen = new Set<string>();
      for (const { file, module, section } of pointers) {
        const key = `${module}::${section ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        expect(SKILL_MODULES, `${file}: read_skill('${module}') names an unknown module`).toContain(module);
        if (section) {
          const out = await callReadSkill({ module, section });
          expect(
            out.section,
            `${file}: read_skill('${module}', '${section}') does not resolve to a real \`##\` heading`,
          ).toBeTruthy();
        }
      }
    });
  });
});
