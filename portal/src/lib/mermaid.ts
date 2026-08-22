// FLUX-1674: renders ```mermaid fences into live SVG diagrams inside the docs viewer's read-only
// rendered surfaces (`DocMarkdownPreview` — History tab, Changes/PR preview, task ArtifactPanel).
// The live TipTap editor is a different surface (contenteditable, FLUX-1663 block-splice) and is
// deliberately left untouched — the fence stays an editable code block there.
//
// `mermaid` is dynamically imported (Vite code-split) so it only loads for docs that actually
// contain a fence, keeping it out of the main portal bundle.
let renderCounter = 0;

/** Monotonic id generator for `mermaid.render` — avoids `Math.random()` collisions/non-determinism. */
function nextMermaidId(): string {
  renderCounter += 1;
  return `mermaid-diagram-${renderCounter}`;
}

/**
 * Finds every `code.language-mermaid` block inside `container`, renders it to SVG via `mermaid`,
 * and replaces the enclosing `<pre>` with the resulting markup. On a thrown render, the original
 * `<pre>` is left untouched in the DOM and a sibling `.mermaid-error` element with a short
 * human-readable message is appended — never blank the block or throw uncaught.
 */
export async function renderMermaidBlocks(container: HTMLElement, isDark: boolean): Promise<void> {
  const codeBlocks = Array.from(container.querySelectorAll('code.language-mermaid'));
  if (codeBlocks.length === 0) {
    return;
  }

  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
  });

  for (const codeBlock of codeBlocks) {
    const pre = codeBlock.closest('pre');
    if (!pre || !pre.parentNode) {
      continue;
    }

    const source = codeBlock.textContent ?? '';
    try {
      const { svg } = await mermaid.render(nextMermaidId(), source);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch (error) {
      // Leave the original <pre> in place and surface a short error note beside it — never
      // blank the block or let the render error propagate uncaught.
      const message = error instanceof Error ? error.message : String(error);
      const errorNode = document.createElement('div');
      errorNode.className = 'mermaid-error';
      errorNode.textContent = `Mermaid diagram failed to render: ${message}`;
      pre.insertAdjacentElement('afterend', errorNode);
    }
  }
}
