// @vitest-environment jsdom
// FLUX-1457: window.prompt throws in the Electron desktop shell, so the description editor's
// link handler now drives an async PromptModal instead. These tests exercise that async
// prompt -> TipTap chain path directly (no DOM `prompt`), the AC's enforceable evidence.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskDescriptionSurface } from './TaskDescriptionSurface';

// jsdom doesn't implement layout geometry (elementFromPoint, Range/Element getClientRects), which
// ProseMirror's posAtCoords/coordsAtPos need during mousedown-to-edit and scrollIntoView; no-op
// stubs are enough for these tests, which don't depend on real cursor/layout positions.
document.elementFromPoint = () => null;
const zeroRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = zeroRect;
Element.prototype.scrollIntoView = () => {};

describe('TaskDescriptionSurface link insertion (FLUX-1457)', () => {
  afterEach(() => cleanup());

  async function renderEditing() {
    const onChange = vi.fn();
    render(<TaskDescriptionSurface value="Hello world" onChange={onChange} mode="full" />);

    // Enter edit mode by mousing down on the editor surface (not a button/input).
    const shell = document.querySelector('.task-description-editor-shell');
    expect(shell).not.toBeNull();
    fireEvent.mouseDown(shell as Element);
    fireEvent.click(shell as Element);

    const linkButton = await screen.findByTitle('Link') as HTMLButtonElement;
    await waitFor(() => expect(linkButton.disabled).toBe(false));

    return { onChange, linkButton };
  }

  it('opens a styled prompt modal (no DOM window.prompt) and inserts the link on submit', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const { linkButton } = await renderEditing();

    fireEvent.click(linkButton);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Link URL')).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();

    const input = screen.getByRole('dialog').querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByText('Set link'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const editorRegion = document.querySelector('.task-description-editor-content') as HTMLElement;
    await waitFor(() => {
      const anchor = editorRegion.querySelector('a[href="https://example.com"]');
      expect(anchor).not.toBeNull();
    });

    promptSpy.mockRestore();
  });

  it('cancel leaves the editor untouched (resolves null, same as window.prompt cancel)', async () => {
    const { linkButton } = await renderEditing();

    fireEvent.click(linkButton);
    expect(await screen.findByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const editorRegion = document.querySelector('.task-description-editor-content') as HTMLElement;
    expect(editorRegion.querySelector('a')).toBeNull();
  });
});

// FLUX-1719: this surface has no block splice (unlike DocsScreen) and no raw-mode fallback -- ANY
// edit turndowns the WHOLE description, so a corrupt table/checklist serializer corrupts a ticket's
// `## Acceptance criteria` checkboxes on ANY unrelated edit, not just an edit to that section.
describe('TaskDescriptionSurface markdown round-trip fidelity (FLUX-1719)', () => {
  afterEach(() => cleanup());

  // Drives a real content-changing edit (the link-insertion flow, the only user-facing command in
  // this component that reliably mutates the doc under jsdom's lack of real contenteditable
  // typing) and asserts the checklist/table elsewhere in the document survive the resulting save.
  async function editUnrelatedTextAndCapture(value: string) {
    const onChange = vi.fn();
    render(<TaskDescriptionSurface value={value} onChange={onChange} mode="full" />);

    const shell = document.querySelector('.task-description-editor-shell');
    fireEvent.mouseDown(shell as Element);
    fireEvent.click(shell as Element);

    const linkButton = await screen.findByTitle('Link') as HTMLButtonElement;
    await waitFor(() => expect(linkButton.disabled).toBe(false));
    fireEvent.click(linkButton);

    const input = screen.getByRole('dialog').querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByText('Set link'));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    return onChange.mock.calls.at(-1)?.[0] as string;
  }

  it('preserves acceptance-criteria checkboxes and a table across an unrelated edit', async () => {
    const value = [
      '## Acceptance criteria',
      '',
      '- [ ] alpha',
      '- [x] beta',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'Hello world',
    ].join('\n');

    const savedMarkdown = await editUnrelatedTextAndCapture(value);

    expect(savedMarkdown).toContain('- [ ] alpha');
    expect(savedMarkdown).toContain('- [x] beta');
    expect(savedMarkdown).not.toContain('<table');
    expect(savedMarkdown).toContain('| A | B |');
  });

  it('never adds a checkbox to a plain item in a mixed checkbox/plain list', async () => {
    const value = ['- [ ] alpha', '- plain bravo', '', 'Hello world'].join('\n');

    const savedMarkdown = await editUnrelatedTextAndCapture(value);

    expect(savedMarkdown).toContain('- [ ] alpha');
    expect(savedMarkdown).toContain('- plain bravo');
    expect(savedMarkdown).not.toContain('- [ ] plain bravo');
  });

  it('renders a loaded checklist as real taskItem nodes, not a stripped-checkbox plain list', async () => {
    const value = ['- [ ] alpha', '- [x] beta'].join('\n');
    render(<TaskDescriptionSurface value={value} onChange={vi.fn()} mode="full" />);

    const editorRegion = await waitFor(() => {
      const el = document.querySelector('.task-description-editor-content');
      expect(el?.querySelectorAll('li').length).toBeGreaterThan(0);
      return el as HTMLElement;
    });

    // The live editing DOM is built by TaskItem's custom node view, which sets `data-checked` but
    // not `data-type` (that's only in the schema `renderHTML` spec `getHTML()` would use instead).
    const taskItems = editorRegion.querySelectorAll('li[data-checked]');
    expect(taskItems.length).toBe(2);
    expect(taskItems[0].getAttribute('data-checked')).toBe('false');
    expect(taskItems[1].getAttribute('data-checked')).toBe('true');
  });
});
