// FLUX-1662 (Phase A steps 2-3) — builds the self-contained HTML for the auto doc-recap artifact:
// a changed-files header plus the rendered BRANCH after-state of each non-trivial changed doc.
// Reuses the existing branch-diff primitives (diffFilesForBranch/fileContentPair/
// isDocsRootMarkdownFile in diff-aggregator.ts) rather than inventing new diff logic — those are
// already worktree-aware and read the branch's live content, which is what a recap should reflect.
// Never throws: any git/filesystem failure degrades to `null` (no recap) rather than blocking the
// Ready transition that triggers this.

import matter from 'gray-matter';
import { requireWorkspaceRoot } from './workspace.js';
import { isDocsRootMarkdownFile, diffFilesForBranch, fileContentPair, type ChangedFile } from './diff-aggregator.js';
import { renderDocMarkdownToHtml } from './doc-render.js';
import { DOC_RECAP_CSS } from './doc-recap-styles.js';

const MAX_INLINE_DOCS = 5;
const MAX_DOC_BYTES = 200 * 1024;
// v1: only a front-matter `order` change is considered trivial (pure reorder churn).
const TRIVIAL_FRONTMATTER_ALLOWLIST = new Set(['order']);

// FLUX-1674: loaded from jsDelivr (already whitelisted in ARTIFACT_CSP's script-src, see
// artifacts.ts) rather than bundled — the recap is a standalone HTML document with no build step.
// Injected only when the assembled body actually contains a mermaid fence, to avoid an unnecessary
// network fetch for the (common) non-diagram doc recap.
const MERMAID_CDN_SCRIPT = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>';

// Walks `code.language-mermaid` elements and renders each in place, degrading to the original
// <pre><code> block plus a `.mermaid-error` note on a thrown/rejected render. Mirrors the portal's
// mermaid helper (lazy-load, strict security level, monotonic ids) but is its own inline template —
// the engine has no import path into portal/src, and this is a static string injected verbatim
// into the recap document rather than compiled TypeScript.
const MERMAID_INIT_SCRIPT = `<script>
(function () {
  var counter = 0;
  function renderAll() {
    if (typeof mermaid === 'undefined') return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
    });
    var blocks = document.querySelectorAll('code.language-mermaid');
    blocks.forEach(function (block) {
      var pre = block.closest('pre');
      if (!pre) return;
      var source = block.textContent || '';
      var id = 'eh-mermaid-' + (counter++);
      mermaid.render(id, source).then(function (result) {
        var wrapper = document.createElement('div');
        wrapper.className = 'eh-mermaid-diagram';
        wrapper.innerHTML = result.svg;
        pre.replaceWith(wrapper);
      }).catch(function (err) {
        var note = document.createElement('div');
        note.className = 'mermaid-error';
        note.textContent = 'Mermaid render failed: ' + (err && err.message ? err.message : String(err));
        pre.insertAdjacentElement('afterend', note);
      });
    });
  }
  renderAll();
})();
</script>`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A doc change is trivial iff the body is byte-identical and every changed front-matter key is
 *  in the allowlist above — any body diff, or a non-allowlisted front-matter key diff, is real. */
export function isTrivialDocChange(before: string, after: string): boolean {
  let beforeParsed: ReturnType<typeof matter>;
  let afterParsed: ReturnType<typeof matter>;
  try {
    beforeParsed = matter(before ?? '');
    afterParsed = matter(after ?? '');
  } catch {
    return false;
  }
  if (beforeParsed.content !== afterParsed.content) return false;

  const beforeData: Record<string, unknown> = beforeParsed.data ?? {};
  const afterData: Record<string, unknown> = afterParsed.data ?? {};
  const keys = new Set([...Object.keys(beforeData), ...Object.keys(afterData)]);
  for (const key of keys) {
    const changed = JSON.stringify(beforeData[key]) !== JSON.stringify(afterData[key]);
    if (changed && !TRIVIAL_FRONTMATTER_ALLOWLIST.has(key)) return false;
  }
  return true;
}

function statusBadge(status: ChangedFile['status']): string {
  switch (status) {
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'renamed':
      return 'Renamed';
    default:
      return 'Modified';
  }
}

interface Survivor {
  file: ChangedFile;
  after: string;
}

export interface DocRecapResult {
  html: string;
  /** Ordered set of doc paths that actually got a rendered `<section data-eh-doc-path>` in `html`
   *  — exactly the inline-rendered subset (`nonDeleted.slice(0, MAX_INLINE_DOCS)`), NOT the full
   *  survivor list, so every entry maps 1:1 to a real section (FLUX-1667: the portal's per-doc tab
   *  strip reads this from the selected revision to build its tabs). */
  docPaths: string[];
}

/** Resolves the branch's changed docsRoot `.md` files vs the merge-base, drops trivial changes,
 *  and renders a self-contained HTML recap: a changed-files header followed by up to
 *  `MAX_INLINE_DOCS` rendered sections (each carrying `data-eh-doc-path`, the hook the Phase B
 *  inline editor keys off of). Returns `null` when there's nothing worth showing. */
export async function buildDocRecapHtml(_ticketId: string, branch: string, baselineCommit: string): Promise<DocRecapResult | null> {
  try {
    const workspaceRoot = requireWorkspaceRoot();
    const opts = { baselineCommit: baselineCommit || null };
    const summary = await diffFilesForBranch(workspaceRoot, branch, opts);
    const docFiles = summary.files.filter((f) => isDocsRootMarkdownFile(f.file));
    if (docFiles.length === 0) return null;

    const survivors: Survivor[] = [];
    for (const file of docFiles) {
      if (file.status === 'deleted') {
        survivors.push({ file, after: '' });
        continue;
      }
      const { before, after } = await fileContentPair(workspaceRoot, branch, file.file, opts).catch(() => ({ before: '', after: '' }));
      if (isTrivialDocChange(before, after)) continue;
      survivors.push({ file, after });
    }
    if (survivors.length === 0) return null;

    const nonDeleted = survivors.filter((s) => s.file.status !== 'deleted');
    const docPaths = nonDeleted.slice(0, MAX_INLINE_DOCS).map((s) => s.file.file);
    const inlinePaths = new Set(docPaths);

    const headerRows = survivors
      .map(
        (s) =>
          `<tr><td>${escapeHtml(s.file.file)}</td><td>+${s.file.additions} -${s.file.deletions}</td><td class="eh-doc-recap-badge">${statusBadge(s.file.status)}</td></tr>`,
      )
      .join('\n');

    const sections = survivors
      .filter((s) => s.file.status !== 'deleted' && inlinePaths.has(s.file.file))
      .map((s) => {
        const oversize = Buffer.byteLength(s.after, 'utf-8') > MAX_DOC_BYTES;
        const body = oversize
          ? '<p class="eh-doc-recap-skipped">Render skipped — this document exceeds the recap size cap.</p>'
          : renderDocMarkdownToHtml(s.after);
        return `<section data-eh-doc-path="${escapeHtml(s.file.file)}">\n<h2>${escapeHtml(s.file.file)}</h2>\n${body}\n</section>`;
      })
      .join('\n');

    const hasMermaid = sections.includes('class="language-mermaid"');
    const mermaidScripts = hasMermaid ? `\n${MERMAID_CDN_SCRIPT}\n${MERMAID_INIT_SCRIPT}` : '';

    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>${DOC_RECAP_CSS}</style></head>
<body>
<table class="eh-doc-recap-header">
<thead><tr><th>File</th><th>Changes</th><th>Status</th></tr></thead>
<tbody>
${headerRows}
</tbody>
</table>
<div class="docs-editor-content">
${sections}
</div>${mermaidScripts}
</body>
</html>`;

    return { html, docPaths };
  } catch {
    return null;
  }
}
