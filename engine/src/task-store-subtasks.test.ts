import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { normalizeInlineSubtasks } from './task-store.js';

/**
 * FLUX-286 regression guard. Inline subtask objects WITHOUT an `id` field used
 * to be silently dropped by normalizeInlineSubtasks (it only normalized objects
 * that already carried an id). They must now be materialized into real ticket
 * files with freshly-allocated sequential IDs, while existing behavior for
 * id-bearing objects and plain string IDs stays unchanged.
 */
describe('normalizeInlineSubtasks handles id-less inline objects (FLUX-286)', () => {
  let fluxDir: string;

  beforeEach(async () => {
    fluxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-subtasks-'));
  });

  afterEach(async () => {
    await fs.rm(fluxDir, { recursive: true, force: true }).catch(() => {});
  });

  const parentPath = () => path.join(fluxDir, 'FLUX-100.md');

  async function readChild(id: string) {
    const raw = await fs.readFile(path.join(fluxDir, `${id}.md`), 'utf8');
    return matter(raw);
  }

  it('allocates sequential IDs and writes files for id-less inline objects', async () => {
    // Seed an existing ticket so allocation starts above it.
    await fs.writeFile(path.join(fluxDir, 'FLUX-100.md'), matter.stringify('parent', { id: 'FLUX-100' }));

    const frontmatter: any = {
      id: 'FLUX-100',
      subtasks: [
        { title: 'first child', status: 'Todo' },
        { title: 'second child' },
      ],
    };

    const result = await normalizeInlineSubtasks(frontmatter, parentPath());

    expect(result).toEqual(['FLUX-101', 'FLUX-102']);
    const c1 = await readChild('FLUX-101');
    expect(c1.data.title).toBe('first child');
    expect(c1.data.id).toBe('FLUX-101');
    const c2 = await readChild('FLUX-102');
    expect(c2.data.title).toBe('second child');
  });

  it('preserves id-bearing objects and string entries unchanged', async () => {
    const frontmatter: any = {
      id: 'FLUX-100',
      subtasks: [
        'FLUX-7',
        { id: 'FLUX-8', title: 'explicit id' },
        { title: 'no id here' },
      ],
    };

    const result = await normalizeInlineSubtasks(frontmatter, parentPath());

    // string passes through, explicit id kept, id-less gets a fresh allocation.
    expect(result).toEqual(['FLUX-7', 'FLUX-8', 'FLUX-9']);
    const explicit = await readChild('FLUX-8');
    expect(explicit.data.title).toBe('explicit id');
    const allocated = await readChild('FLUX-9');
    expect(allocated.data.title).toBe('no id here');
  });

  it('returns null when there are no inline objects to normalize', async () => {
    const frontmatter: any = { id: 'FLUX-100', subtasks: ['FLUX-1', 'FLUX-2'] };
    expect(await normalizeInlineSubtasks(frontmatter, parentPath())).toBeNull();
  });
});
