// FLUX-1662 (Phase A steps 2-3) — the auto doc-recap builder. On a ticket's branch touching a
// docsRoot .md file, `buildDocRecapHtml` renders a self-contained HTML fragment (changed-files
// header + per-doc rendered BRANCH after-state) that the emitter publishes via the existing
// withArtifactPublication/writeArtifactRevisionInPublication primitives (see artifacts.test.ts).
// `isTrivialDocChange` is the single source of truth for "front-matter `order`-only churn" so a
// reorder-only edit never triggers a recap.
//
// Real git repos via fs.mkdtemp, mirroring diff-aggregator.test.ts's gitInit/createTaskWorktree
// pattern (a ticket branch's changes live in its own worktree, read live off disk — not the main
// checkout) and artifacts.test.ts's temp-workspace-per-test setup. Real git worktree ops are slow on
// Windows under parallel suite load (FLUX-749) — testTimeout raised file-wide.
//
// TDD red phase (FLUX-1662): `engine/src/doc-recap.ts` does not exist yet. These tests must fail
// with a module-not-found error until it's created.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import matter from 'gray-matter';
import { setWorkspaceRoot } from './workspace.js';
import { createTaskWorktree, listTaskWorktrees } from './task-worktree.js';
import { buildDocRecapHtml, isTrivialDocChange } from './doc-recap.js';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

async function makeParent(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'eh-docrecap-'));
}

async function gitInit(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await git(root, ['init', '-b', 'master']);
  await git(root, ['config', 'user.email', 'test@test.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await fs.mkdir(path.join(root, '.docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'init']);
}

async function headCommit(root: string): Promise<string> {
  const { stdout } = await git(root, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

function docFrontmatter(body: string, fm: Record<string, unknown>): string {
  return matter.stringify(body, fm);
}

describe('buildDocRecapHtml (FLUX-1662)', () => {
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    parent = await makeParent();
    repo = path.join(parent, 'EventHorizon');
    await gitInit(repo);
    setWorkspaceRoot(repo);
  });

  afterEach(async () => {
    try {
      const wts = await listTaskWorktrees(repo).catch(() => []);
      for (const w of wts) await git(repo, ['worktree', 'remove', '--force', w.path]).catch(() => {});
      await git(repo, ['worktree', 'prune']).catch(() => {});
    } catch { /* best-effort */ }
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  });

  it('returns a header + a section carrying data-eh-doc-path for a branch touching a docsRoot .md file', async () => {
    const baseline = await headCommit(repo);
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-docs', { linkDependencies: false });
    await fs.mkdir(path.join(wt, '.docs'), { recursive: true });
    await fs.writeFile(
      path.join(wt, '.docs', 'guide.md'),
      docFrontmatter('# Guide\n\nHello world.\n', { title: 'Guide', order: 1 }),
      'utf8',
    );
    await git(wt, ['add', '.docs/guide.md']);
    await git(wt, ['commit', '-m', 'add guide']);

    const result = await buildDocRecapHtml('FLUX-1', 'flux/FLUX-1-docs', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).toContain('.docs/guide.md');
    expect(html).toContain('data-eh-doc-path=".docs/guide.md"');
    expect(html.toLowerCase()).toContain('added');
    expect(html).toContain('Hello world.');
    expect(result!.docPaths).toEqual(['.docs/guide.md']);
    expect(html).toContain('docs-editor-content');
  });

  it('renders the BRANCH after-state of a doc, not the base/main content', async () => {
    await fs.writeFile(
      path.join(repo, '.docs', 'guide.md'),
      docFrontmatter('# Guide\n\nOld base content.\n', { title: 'Guide', order: 1 }),
      'utf8',
    );
    await git(repo, ['add', '.docs/guide.md']);
    await git(repo, ['commit', '-m', 'seed guide']);
    const baseline = await headCommit(repo);

    const wt = await createTaskWorktree(repo, 'FLUX-2', 'flux/FLUX-2-docs', { linkDependencies: false });
    await fs.writeFile(
      path.join(wt, '.docs', 'guide.md'),
      docFrontmatter('# Guide\n\nNew branch content.\n', { title: 'Guide', order: 1 }),
      'utf8',
    );
    await git(wt, ['add', '.docs/guide.md']);
    await git(wt, ['commit', '-m', 'update guide']);

    const result = await buildDocRecapHtml('FLUX-2', 'flux/FLUX-2-docs', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).toContain('New branch content.');
    expect(html).not.toContain('Old base content.');
  });

  it('excludes a doc whose only diff is front-matter `order` churn, and returns null when ALL changed docs are trivial', async () => {
    await fs.writeFile(
      path.join(repo, '.docs', 'a.md'),
      docFrontmatter('# A\n\nBody A.\n', { title: 'A', order: 1 }),
      'utf8',
    );
    await git(repo, ['add', '.docs/a.md']);
    await git(repo, ['commit', '-m', 'seed a']);
    const baseline = await headCommit(repo);

    const wt = await createTaskWorktree(repo, 'FLUX-3', 'flux/FLUX-3-trivial', { linkDependencies: false });
    await fs.writeFile(
      path.join(wt, '.docs', 'a.md'),
      docFrontmatter('# A\n\nBody A.\n', { title: 'A', order: 2 }),
      'utf8',
    );
    await git(wt, ['add', '.docs/a.md']);
    await git(wt, ['commit', '-m', 'reorder a']);

    const result = await buildDocRecapHtml('FLUX-3', 'flux/FLUX-3-trivial', baseline);
    expect(result).toBeNull();
  });

  it('treats a body content change as non-trivial (renders) even when front-matter is untouched', async () => {
    await fs.writeFile(
      path.join(repo, '.docs', 'b.md'),
      docFrontmatter('# B\n\nOld body.\n', { title: 'B', order: 1 }),
      'utf8',
    );
    await git(repo, ['add', '.docs/b.md']);
    await git(repo, ['commit', '-m', 'seed b']);
    const baseline = await headCommit(repo);

    const wt = await createTaskWorktree(repo, 'FLUX-4', 'flux/FLUX-4-body', { linkDependencies: false });
    await fs.writeFile(
      path.join(wt, '.docs', 'b.md'),
      docFrontmatter('# B\n\nNew body.\n', { title: 'B', order: 1 }),
      'utf8',
    );
    await git(wt, ['add', '.docs/b.md']);
    await git(wt, ['commit', '-m', 'edit b body']);

    const result = await buildDocRecapHtml('FLUX-4', 'flux/FLUX-4-body', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).toContain('data-eh-doc-path=".docs/b.md"');
    expect(html).toContain('New body.');
  });

  it('treats a front-matter key change outside the order-only allowlist as non-trivial (renders)', async () => {
    await fs.writeFile(
      path.join(repo, '.docs', 'c.md'),
      docFrontmatter('# C\n\nSame body.\n', { title: 'C', order: 1 }),
      'utf8',
    );
    await git(repo, ['add', '.docs/c.md']);
    await git(repo, ['commit', '-m', 'seed c']);
    const baseline = await headCommit(repo);

    const wt = await createTaskWorktree(repo, 'FLUX-4b', 'flux/FLUX-4b-title', { linkDependencies: false });
    await fs.writeFile(
      path.join(wt, '.docs', 'c.md'),
      docFrontmatter('# C\n\nSame body.\n', { title: 'C Renamed', order: 1 }),
      'utf8',
    );
    await git(wt, ['add', '.docs/c.md']);
    await git(wt, ['commit', '-m', 'rename c title']);

    const result = await buildDocRecapHtml('FLUX-4b', 'flux/FLUX-4b-title', baseline);
    expect(result).not.toBeNull();
    expect(result!.html).toContain('data-eh-doc-path=".docs/c.md"');
  });

  it('shows a header row but no content section for a deleted doc', async () => {
    await fs.writeFile(
      path.join(repo, '.docs', 'gone.md'),
      docFrontmatter('# Gone\n\nWill be deleted.\n', { title: 'Gone', order: 1 }),
      'utf8',
    );
    await git(repo, ['add', '.docs/gone.md']);
    await git(repo, ['commit', '-m', 'seed gone']);
    const baseline = await headCommit(repo);

    const wt = await createTaskWorktree(repo, 'FLUX-5', 'flux/FLUX-5-delete', { linkDependencies: false });
    await fs.rm(path.join(wt, '.docs', 'gone.md'));
    await git(wt, ['add', '.docs/gone.md']);
    await git(wt, ['commit', '-m', 'remove gone']);

    const result = await buildDocRecapHtml('FLUX-5', 'flux/FLUX-5-delete', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).toContain('.docs/gone.md');
    expect(html.toLowerCase()).toContain('deleted');
    expect(html).not.toContain('data-eh-doc-path=".docs/gone.md"');
    expect(html).not.toContain('Will be deleted.');
    expect(result!.docPaths).not.toContain('.docs/gone.md');
  });

  it('returns null when the branch touches no docsRoot .md files (root README.md and non-docs source)', async () => {
    const baseline = await headCommit(repo);
    const wt = await createTaskWorktree(repo, 'FLUX-6', 'flux/FLUX-6-nodocs', { linkDependencies: false });
    await fs.writeFile(path.join(wt, 'README.md'), '# changed readme\n', 'utf8');
    await fs.mkdir(path.join(wt, 'src'), { recursive: true });
    await fs.writeFile(path.join(wt, 'src', 'index.ts'), 'export {};\n', 'utf8');
    await git(wt, ['add', '.']);
    await git(wt, ['commit', '-m', 'non-doc changes']);

    const result = await buildDocRecapHtml('FLUX-6', 'flux/FLUX-6-nodocs', baseline);
    expect(result).toBeNull();
  });

  it('renders at most 5 docs inline and still lists every changed doc in the header', async () => {
    const baseline = await headCommit(repo);
    const wt = await createTaskWorktree(repo, 'FLUX-7', 'flux/FLUX-7-many', { linkDependencies: false });
    await fs.mkdir(path.join(wt, '.docs'), { recursive: true });
    for (let i = 1; i <= 7; i++) {
      await fs.writeFile(
        path.join(wt, '.docs', `doc${i}.md`),
        docFrontmatter(`# Doc ${i}\n\nContent ${i}.\n`, { title: `Doc ${i}`, order: i }),
        'utf8',
      );
    }
    await git(wt, ['add', '.docs']);
    await git(wt, ['commit', '-m', 'add 7 docs']);

    const result = await buildDocRecapHtml('FLUX-7', 'flux/FLUX-7-many', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    for (let i = 1; i <= 7; i++) {
      expect(html).toContain(`.docs/doc${i}.md`);
    }
    const sectionCount = (html.match(/data-eh-doc-path="/g) || []).length;
    expect(sectionCount).toBe(5);
    expect(result!.docPaths).toHaveLength(5);
    for (const p of result!.docPaths) {
      expect(html).toContain(`data-eh-doc-path="${p}"`);
    }
  });

  it('degrades a single over-cap doc to a "render skipped" fallback while sibling docs still render fully', async () => {
    const baseline = await headCommit(repo);
    const wt = await createTaskWorktree(repo, 'FLUX-8', 'flux/FLUX-8-big', { linkDependencies: false });
    await fs.mkdir(path.join(wt, '.docs'), { recursive: true });
    const bigBody = `# Big\n\n${'x'.repeat(210 * 1024)}\n`;
    await fs.writeFile(path.join(wt, '.docs', 'big.md'), docFrontmatter(bigBody, { title: 'Big', order: 1 }), 'utf8');
    await fs.writeFile(
      path.join(wt, '.docs', 'small.md'),
      docFrontmatter('# Small\n\nFits fine.\n', { title: 'Small', order: 2 }),
      'utf8',
    );
    await git(wt, ['add', '.docs']);
    await git(wt, ['commit', '-m', 'add big + small docs']);

    const result = await buildDocRecapHtml('FLUX-8', 'flux/FLUX-8-big', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).toContain('Fits fine.');
    expect(html).toContain('data-eh-doc-path=".docs/small.md"');
    expect(html).not.toContain('x'.repeat(210 * 1024));
    expect(html.toLowerCase()).toContain('render skipped');
  });

  it('never throws for an unknown branch / bogus baseline — returns null', async () => {
    await expect(
      buildDocRecapHtml('FLUX-9', 'flux/does-not-exist', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).resolves.not.toThrow();
    const result = await buildDocRecapHtml('FLUX-9', 'flux/does-not-exist', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(result).toBeNull();
  });

  it('injects the mermaid CDN script + init script + language-mermaid markup for a doc with a mermaid fence (FLUX-1674)', async () => {
    const baseline = await headCommit(repo);
    const wt = await createTaskWorktree(repo, 'FLUX-11', 'flux/FLUX-11-mermaid', { linkDependencies: false });
    await fs.mkdir(path.join(wt, '.docs'), { recursive: true });
    await fs.writeFile(
      path.join(wt, '.docs', 'diagram.md'),
      docFrontmatter('# Diagram\n\n```mermaid\ngraph TD;\nA-->B;\n```\n', { title: 'Diagram', order: 1 }),
      'utf8',
    );
    await git(wt, ['add', '.docs/diagram.md']);
    await git(wt, ['commit', '-m', 'add diagram']);

    const result = await buildDocRecapHtml('FLUX-11', 'flux/FLUX-11-mermaid', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js');
    expect(html).toContain('mermaid.initialize');
    expect(html).toContain('mermaid.render');
  });

  it('does not inject the mermaid CDN script for a doc with no mermaid fence (FLUX-1674)', async () => {
    const baseline = await headCommit(repo);
    const wt = await createTaskWorktree(repo, 'FLUX-12', 'flux/FLUX-12-nomermaid', { linkDependencies: false });
    await fs.mkdir(path.join(wt, '.docs'), { recursive: true });
    await fs.writeFile(
      path.join(wt, '.docs', 'plain.md'),
      docFrontmatter('# Plain\n\nJust text, no diagrams.\n', { title: 'Plain', order: 1 }),
      'utf8',
    );
    await git(wt, ['add', '.docs/plain.md']);
    await git(wt, ['commit', '-m', 'add plain doc']);

    const result = await buildDocRecapHtml('FLUX-12', 'flux/FLUX-12-nomermaid', baseline);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).not.toContain('cdn.jsdelivr.net/npm/mermaid');
    expect(html).not.toContain('mermaid.initialize');
  });

  it('never throws when the bound workspace root has no usable git repo — returns null', async () => {
    const bogus = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-docrecap-bogus-'));
    setWorkspaceRoot(bogus);
    await expect(buildDocRecapHtml('FLUX-10', 'flux/whatever', 'abc123')).resolves.toBeNull();
    await fs.rm(bogus, { recursive: true, force: true }).catch(() => {});
    setWorkspaceRoot(repo); // restore for this test's own afterEach worktree cleanup
  });
});

describe('isTrivialDocChange (FLUX-1662)', () => {
  it('treats front-matter `order`-only churn as trivial', () => {
    const before = docFrontmatter('# A\n\nBody.\n', { title: 'A', order: 1 });
    const after = docFrontmatter('# A\n\nBody.\n', { title: 'A', order: 2 });
    expect(isTrivialDocChange(before, after)).toBe(true);
  });

  it('treats byte-identical content with no front-matter as trivial', () => {
    const before = '# A\n\nBody.\n';
    const after = '# A\n\nBody.\n';
    expect(isTrivialDocChange(before, after)).toBe(true);
  });

  it('treats any body content change as non-trivial, even with identical front-matter', () => {
    const before = docFrontmatter('# A\n\nOld body.\n', { title: 'A', order: 1 });
    const after = docFrontmatter('# A\n\nNew body.\n', { title: 'A', order: 1 });
    expect(isTrivialDocChange(before, after)).toBe(false);
  });

  it('treats a non-order front-matter key change as non-trivial', () => {
    const before = docFrontmatter('# A\n\nBody.\n', { title: 'A', order: 1 });
    const after = docFrontmatter('# A\n\nBody.\n', { title: 'B', order: 1 });
    expect(isTrivialDocChange(before, after)).toBe(false);
  });

  it('treats a mixed order + other-key front-matter change as non-trivial', () => {
    const before = docFrontmatter('# A\n\nBody.\n', { title: 'A', order: 1 });
    const after = docFrontmatter('# A\n\nBody.\n', { title: 'B', order: 2 });
    expect(isTrivialDocChange(before, after)).toBe(false);
  });
});
