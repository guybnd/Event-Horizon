// @vitest-environment jsdom
// FLUX-1674: DocMarkdownPreview renders ```mermaid fences into live diagrams via a mocked
// `mermaid` dynamic import — jsdom can't produce real SVG output, so these assert on the
// render-call/selection/error-degrade behavior, not pixel output.
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { DocMarkdownPreview } from './DocMarkdownPreview';
import { appStore } from '../store/appStore';
import type { Doc } from '../types';

const renderMock = vi.fn();
const initializeMock = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

const DOCS: Doc[] = [];

describe('DocMarkdownPreview Mermaid rendering (FLUX-1674)', () => {
  beforeEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
    appStore.patch({ theme: 'axis-day' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('calls mermaid.render once per code.language-mermaid node found in the rendered HTML', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="rendered-diagram"></svg>' });

    const markdown = [
      '# Doc',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
      'Some text.',
      '',
      '```mermaid',
      'graph TD; C-->D;',
      '```',
      '',
    ].join('\n');

    const { container } = render(<DocMarkdownPreview markdown={markdown} docs={DOCS} />);

    // Before the effect resolves, both fences are still present as code blocks.
    expect(container.querySelectorAll('code.language-mermaid').length).toBe(2);

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'default' }),
    );

    // Both <pre> blocks got replaced with the mocked SVG markup.
    await waitFor(() => {
      expect(container.querySelectorAll('.mermaid-diagram').length).toBe(2);
    });
    expect(container.querySelectorAll('pre').length).toBe(0);
  });

  it('does not call mermaid.render for a doc with no mermaid fences', async () => {
    const markdown = '# Doc\n\nJust text, no code fences.\n';
    render(<DocMarkdownPreview markdown={markdown} docs={DOCS} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('leaves the original <pre> in the DOM and appends a .mermaid-error node when render throws', async () => {
    renderMock.mockRejectedValue(new Error('Parse error on line 1'));

    const markdown = ['```mermaid', 'not valid mermaid syntax {{{', '```', ''].join('\n');

    const { container } = render(<DocMarkdownPreview markdown={markdown} docs={DOCS} />);

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      expect(container.querySelector('.mermaid-error')).not.toBeNull();
    });
    // The original <pre><code class="language-mermaid"> block is untouched, not blanked.
    expect(container.querySelector('pre code.language-mermaid')).not.toBeNull();
    expect(container.querySelector('.mermaid-error')?.textContent).toMatch(/failed to render/i);
  });

  it('uses the dark Mermaid theme when the resolved app theme is dark-base', async () => {
    renderMock.mockResolvedValue({ svg: '<svg></svg>' });
    appStore.patch({ theme: 'matrix' }); // dark-base, not literally named "dark"

    const markdown = ['```mermaid', 'graph TD; A-->B;', '```', ''].join('\n');
    render(<DocMarkdownPreview markdown={markdown} docs={DOCS} />);

    await waitFor(() => expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
    ));
  });
});
