import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { deriveGist, buildDoneIndexBlock, hasExistingVersionBlock, type ReleaseTask } from './release.js';

function task(id: string, title: string, history: unknown[]): ReleaseTask {
  const parsed = matter(`---\nid: ${id}\ntitle: ${title}\nstatus: Done\n---\nbody`);
  parsed.data.history = history;
  return { id, parsed, filePath: `/flux/${id}.md` };
}

describe('deriveGist', () => {
  it('returns undefined for an empty history', () => {
    expect(deriveGist([])).toBeUndefined();
  });

  it('returns undefined when no entry has type "comment"', () => {
    expect(deriveGist([{ type: 'status_change', from: 'Todo', to: 'Done' }])).toBeUndefined();
  });

  it('picks the most recent comment entry', () => {
    const history = [
      { type: 'comment', comment: 'older comment' },
      { type: 'status_change', from: 'In Progress', to: 'Ready' },
      { type: 'comment', comment: 'Fixed the thing.' },
    ];
    expect(deriveGist(history)).toBe('Fixed the thing.');
  });

  it('collapses multi-line comments to a single line', () => {
    const history = [{ type: 'comment', comment: 'Line one.\n\nLine two.\nLine three.' }];
    expect(deriveGist(history)).toBe('Line one. Line two. Line three.');
  });

  it('truncates long comments to ~120 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const gist = deriveGist([{ type: 'comment', comment: long }])!;
    expect(gist.length).toBe(120);
    expect(gist.endsWith('…')).toBe(true);
  });

  it('skips comment entries with a blank/whitespace-only comment', () => {
    const history = [
      { type: 'comment', comment: 'real gist' },
      { type: 'comment', comment: '   ' },
    ];
    expect(deriveGist(history)).toBe('real gist');
  });

  it('ignores malformed entries without throwing', () => {
    expect(deriveGist([null, 42, 'string-entry', { type: 'comment', comment: 123 }])).toBeUndefined();
  });
});

describe('buildDoneIndexBlock', () => {
  it('formats one line per ticket, with gist when present and title-only fallback otherwise', () => {
    const tasks = [
      task('FLUX-1', 'Fix the bug', [{ type: 'comment', comment: 'Fixed via patch X.' }]),
      task('FLUX-2', 'Add the feature', []),
    ];
    const block = buildDoneIndexBlock('v2.0.0', tasks);
    expect(block).toContain('## Release v2.0.0');
    expect(block).toContain('- **FLUX-1**: Fix the bug — Fixed via patch X.\n');
    expect(block).toContain('- **FLUX-2**: Add the feature\n');
    expect(block).not.toContain('FLUX-2**: Add the feature —');
  });

  it('is a no-op-safe empty block when given zero tasks', () => {
    const block = buildDoneIndexBlock('v3.0.0', []);
    expect(block).toContain('## Release v3.0.0');
    expect(block.trim().split('\n')).toHaveLength(1);
  });
});

describe('hasExistingVersionBlock', () => {
  it('returns false on empty/unrelated content', () => {
    expect(hasExistingVersionBlock('', 'v1.0.0')).toBe(false);
    expect(hasExistingVersionBlock('## Release v0.9.0\n', 'v1.0.0')).toBe(false);
  });

  it('returns true when the version heading is already present', () => {
    expect(hasExistingVersionBlock('## Release v1.0.0 — 2026-01-01\n', 'v1.0.0')).toBe(true);
  });

  it('does not false-positive on a version that is a prefix of an already-indexed one', () => {
    expect(hasExistingVersionBlock('## Release v2.0.0 — 2026-01-01T00:00:00.000Z\n\n', 'v2')).toBe(false);
    expect(hasExistingVersionBlock('## Release v1.0.1 — 2026-01-01T00:00:00.000Z\n\n', 'v1.0')).toBe(false);
  });

  it('still matches when the version contains regex-special characters', () => {
    expect(hasExistingVersionBlock('## Release v1.2.0+build.1 — 2026-01-01\n', 'v1.2.0+build.1')).toBe(true);
  });
});
