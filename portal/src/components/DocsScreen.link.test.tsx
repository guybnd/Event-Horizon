// @vitest-environment jsdom
// FLUX-1457: window.prompt throws in the Electron desktop shell, so the Docs editor's wiki-link
// and URL-link handlers now drive an async PromptModal instead. These tests exercise that async
// prompt -> TipTap chain path directly (no DOM `prompt`), the AC's enforceable evidence.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocsScreen } from './DocsScreen';
import { appStore } from '../store/appStore';
import type { Doc } from '../types';

// jsdom doesn't implement layout geometry that ProseMirror's coordsAtPos/scrollIntoView need;
// no-op stubs are enough for these tests, which don't depend on real cursor/layout positions.
document.elementFromPoint = () => null;
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as Storage;
}
const zeroRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = zeroRect;
Element.prototype.scrollIntoView = () => {};

const { TARGET_DOC, OTHER_DOC } = vi.hoisted(() => ({
  TARGET_DOC: {
    path: 'guide/overview',
    title: 'Overview',
    body: 'Hello world',
    slug: 'overview',
    directory: 'guide',
  } as Doc,
  OTHER_DOC: {
    path: 'guide/other',
    title: 'Other Doc',
    body: 'Other body',
    slug: 'other',
    directory: 'guide',
  } as Doc,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchDocs: vi.fn().mockResolvedValue([TARGET_DOC, OTHER_DOC]),
    fetchDoc: vi.fn().mockImplementation((path: string) =>
      Promise.resolve(path === OTHER_DOC.path ? OTHER_DOC : TARGET_DOC)),
    fetchGroupStatus: vi.fn().mockResolvedValue({ configured: false, docsLabel: 'Product', members: [] }),
  };
});

describe('DocsScreen link insertion (FLUX-1457)', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  async function renderWithToolbar() {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    render(<DocsScreen />);

    await screen.findByText('Overview');

    const editorRegion = await waitFor(() => {
      const el = document.querySelector('.docs-editor-content') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.focus(editorRegion);

    const wikiButton = await screen.findByTitle('Wiki Link') as HTMLButtonElement;
    const linkButton = await screen.findByTitle('External Link') as HTMLButtonElement;
    await waitFor(() => {
      expect(wikiButton.disabled).toBe(false);
      expect(linkButton.disabled).toBe(false);
    });

    return { editorRegion, wikiButton, linkButton };
  }

  it('inserts a wiki link via the async prompt modal (no DOM window.prompt)', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const { editorRegion, wikiButton } = await renderWithToolbar();

    fireEvent.click(wikiButton);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Insert wiki link')).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();

    const input = screen.getByRole('dialog').querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Other Doc' } });
    fireEvent.click(screen.getByText('Insert'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await waitFor(() => {
      const anchor = editorRegion.querySelector(`a[href="wiki:${encodeURIComponent(OTHER_DOC.path)}"]`);
      expect(anchor).not.toBeNull();
    });

    promptSpy.mockRestore();
  });

  it('drives the URL-link prompt round-trip without a DOM window.prompt', async () => {
    // Note: jsdom has no real text-selection/layout, so this doesn't assert the mark lands
    // (extendMarkRange on an empty selection legitimately no-ops — unchanged pre-existing TipTap
    // behavior, not something this ticket touches). It asserts the async chain this ticket adds
    // — open, populate, submit, close — runs without a native prompt and without throwing.
    const promptSpy = vi.spyOn(window, 'prompt');
    const { linkButton } = await renderWithToolbar();

    fireEvent.click(linkButton);
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByText('Link URL')).toBeTruthy();
    const input = dialog.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe(''); // no existing link under the cursor

    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByText('Set link'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(promptSpy).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it('cancel leaves the doc untouched (resolves null, same as window.prompt cancel)', async () => {
    const { editorRegion, linkButton } = await renderWithToolbar();

    fireEvent.click(linkButton);
    expect(await screen.findByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(editorRegion.querySelector('a')).toBeNull();
  });

  it('Escape closes the modal while the autofocused input is focused, leaving the doc untouched (same as window.prompt cancel)', async () => {
    const { editorRegion, linkButton } = await renderWithToolbar();

    fireEvent.click(linkButton);
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(editorRegion.querySelector('a')).toBeNull();
  });
});
