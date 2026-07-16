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
