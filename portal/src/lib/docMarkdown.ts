// Shared docs markdown pipeline (FLUX-1653) — extracted out of DocsScreen.tsx so a read-only
// preview (History tab, PR/diff view) renders wiki-links identically to the live editor instead of
// drifting out of sync with a second implementation.
import { marked } from 'marked';
import type { Doc } from '../types';

marked.setOptions({ gfm: true, breaks: false });

export function normalizeDocPathInput(value: string) {
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return null;
  }

  const withoutExtension = normalized.toLowerCase().endsWith('.md') ? normalized.slice(0, -3) : normalized;
  const segments = withoutExtension.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  return segments.join('/');
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolveWikiDocPath(target: string, docs: Doc[]) {
  const normalizedPath = normalizeDocPathInput(target);
  const targetSlug = slugify(target);

  if (normalizedPath) {
    const directPathMatch = docs.find((doc) => doc.path.toLowerCase() === normalizedPath.toLowerCase());
    if (directPathMatch) {
      return directPathMatch.path;
    }

    const basenamePathMatch = docs.find((doc) => doc.path.split('/').pop()?.toLowerCase() === normalizedPath.toLowerCase());
    if (basenamePathMatch) {
      return basenamePathMatch.path;
    }
  }

  const slugMatch = docs.find((doc) => doc.slug === targetSlug);
  if (slugMatch) {
    return slugMatch.path;
  }

  const titleMatch = docs.find((doc) => slugify(doc.title) === targetSlug);
  return titleMatch?.path || null;
}

export function getWikiLinkDefinition(target: string, docs: Doc[]) {
  const label = target.trim();
  const resolvedPath = resolveWikiDocPath(label, docs);

  return {
    label,
    resolvedPath,
    href: resolvedPath ? `wiki:${encodeURIComponent(resolvedPath)}` : `broken:${encodeURIComponent(label)}`,
  };
}

export function injectWikiLinks(markdown: string, docs: Doc[]) {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
    const link = getWikiLinkDefinition(rawTarget, docs);

    if (!link.label) {
      return _match;
    }

    return `[${link.label}](${link.href})`;
  });
}

export function getBrokenWikiLinks(markdown: string, docs: Doc[]) {
  const brokenTargets = new Set<string>();

  markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
    const label = rawTarget.trim();
    if (label && !resolveWikiDocPath(label, docs)) {
      brokenTargets.add(label);
    }

    return _match;
  });

  return Array.from(brokenTargets);
}

/** Strip a leading YAML front-matter block (`---\n...\n---\n`), if present. Idempotent — a no-op
 *  on content that's already front-matter-free (e.g. a `Doc.body`, which the engine already
 *  separates from front-matter). Needed for raw file content pulled straight off disk/git (e.g.
 *  the Changes screen's rendered PR preview, FLUX-1653), which still carries it. */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

export function renderMarkdownToHtml(markdown: string, docs: Doc[]) {
  const rendered = marked.parse(injectWikiLinks(stripFrontmatter(markdown), docs)) as string;
  return rendered || '<p></p>';
}
