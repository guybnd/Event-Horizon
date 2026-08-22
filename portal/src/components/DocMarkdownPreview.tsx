// Read-only rendered markdown preview (FLUX-1653) — shares the docs editor's markdown pipeline
// (`renderMarkdownToHtml`, wiki-links resolve identically) and its `docs-editor-content` prose
// styling, without instantiating a TipTap editor instance (a perf trap in a revision list or a
// side-by-side PR preview). Reused by the docs History tab and the Changes screen's PR preview.
import { useEffect, useRef } from 'react';
import type { Doc } from '../types';
import { renderMarkdownToHtml } from '../lib/docMarkdown';
import { renderMermaidBlocks } from '../lib/mermaid';
import { THEMES } from '../AppContext';
import { useAppSelector } from '../store/useAppSelector';

interface DocMarkdownPreviewProps {
  markdown: string;
  docs: Doc[];
  className?: string;
}

export function DocMarkdownPreview({ markdown, docs, className = '' }: DocMarkdownPreviewProps) {
  const html = renderMarkdownToHtml(markdown, docs);
  const containerRef = useRef<HTMLDivElement>(null);
  // FLUX-1674: `baseMode`, not the literal theme name — matrix/cyber/midnight/axis-night are all
  // dark-base themes, not just the one literally named "dark".
  const theme = useAppSelector((s) => s.theme);
  const isDark = THEMES.find((t) => t.name === theme)?.baseMode === 'dark';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    void renderMermaidBlocks(container, isDark);
    // Re-render diagrams whenever the markdown content (the HTML just set via
    // dangerouslySetInnerHTML is derived from it) or the resolved theme changes.
  }, [markdown, isDark]);

  return (
    <div
      ref={containerRef}
      className={`docs-editor-content text-sm leading-6 text-gray-900 dark:text-gray-100 ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
