// @vitest-environment jsdom
// FLUX-1654: markdown round-trip fidelity. The docs editor's WYSIWYG save path always ran
// content through TipTap -> turndown, which reformats markdown it never touched (bullet markers,
// emphasis delimiters, ordered-list renumbering, table padding) — a one-word edit produced a
// whole-file diff. These tests exercise the raw-markdown mode added to fix that: a doc carrying
// extra front-matter keys (FLUX-1650's `extraFrontmatter`, the docs-as-code signal) opens in raw
// mode by default, where the textarea's value is the doc body byte-for-byte with zero
// transformation on load or save.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocsScreen } from './DocsScreen';
import { appStore } from '../store/appStore';
import { ConfirmProvider } from '../hooks/useConfirm';

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

// Anzu-brain-style regression anchor: a GFM table, a fenced code block containing nested
// backticks, a mixed/non-sequential ordered+unordered list, a wiki link, inline HTML, and
// underscore emphasis — every construct turndown's default options are known to reformat.
const { ANZU_BRAIN_BODY, RAW_DOC, RICH_DOC, MULTIBLOCK_DOC, FOOTNOTE_DOC, FRONTMATTER_CLEAN_DOC, MERMAID_DOC } = vi.hoisted(() => {
  const anzuBrainBody = [
    '# Provenance notes',
    '',
    'See [[Related Doc]] for background. Uses _underscore_ emphasis and __underscore strong__.',
    '',
    '| Column A | Column B |',
    '| -------- | -------- |',
    '| one      | two      |',
    '',
    '1. 1. First',
    '1. 1. Second',
    '   - nested bullet',
    '   - another nested bullet',
    '',
    '````markdown',
    '```js',
    'const x = 1;',
    '```',
    '````',
    '',
    '<details><summary>Expand</summary>Hidden content.</details>',
    '',
  ].join('\n');

  const footnoteBody = [
    'See this claim.[^1]',
    '',
    '[^1]: The footnote text.',
    '',
  ].join('\n');

  // FLUX-1663: a WELL-FORMED multi-block corpus (heading, paragraph, table, ordered list with a
  // simple nested bullet sub-list, fenced code = 5 blocks) that maps 1:1 into TipTap nodes when
  // each block is rendered in isolation. Deliberately NOT anzuBrainBody's torture-test constructs
  // (the non-sequential "1. 1." list numbering, the raw `<details>` HTML block) -- those are
  // exactly the mdast<->marked block-boundary-drift cases the plan calls out as expected to trip
  // the block-count-mismatch safety net (raw fallback), not the happy path this test covers.
  const multiblockCleanBody = [
    '# Provenance notes',
    '',
    'See [[Related Doc]] for background. Uses _underscore_ emphasis and __underscore strong__.',
    '',
    '| Column A | Column B |',
    '| -------- | -------- |',
    '| one      | two      |',
    '',
    '1. First',
    '2. Second',
    '   - nested bullet',
    '   - another nested bullet',
    '',
    '````markdown',
    '```js',
    'const x = 1;',
    '```',
    '````',
    '',
  ].join('\n');

  // FLUX-1674: a ```mermaid fence is just a fenced code block to the editor/save path — the live
  // TipTap editor keeps it as an editable code block for v1 (only the read-only preview renders
  // it as a diagram), so this must round-trip through the block-splice save path byte-for-byte,
  // exactly like any other fenced code block.
  const mermaidBody = [
    '# Architecture',
    '',
    'See the flow below.',
    '',
    '```mermaid',
    'graph TD;',
    '  A[Start] --> B{Decision};',
    '  B -->|Yes| C[End];',
    '```',
    '',
  ].join('\n');

  return {
    ANZU_BRAIN_BODY: anzuBrainBody,
    MERMAID_BODY: mermaidBody,
    RAW_DOC: {
      path: 'anzu-brain/provenance',
      title: 'Provenance',
      body: anzuBrainBody,
      slug: 'provenance',
      directory: 'anzu-brain',
      extraFrontmatter: { sources: ['https://example.com'], last_verified: '2026-01-01' },
    },
    RICH_DOC: {
      path: 'guide/overview',
      title: 'Overview',
      body: 'Hello world',
      slug: 'overview',
      directory: 'guide',
    },
    // FLUX-1663: no extra front-matter -- opens in Rich text mode, so it exercises the
    // block-splice save path instead of the raw textarea.
    MULTIBLOCK_DOC: {
      path: 'guide/multiblock',
      title: 'Multiblock',
      body: multiblockCleanBody,
      slug: 'multiblock',
      directory: 'guide',
    },
    FOOTNOTE_DOC: {
      path: 'guide/footnotes',
      title: 'Footnotes',
      body: footnoteBody,
      slug: 'footnotes',
      directory: 'guide',
    },
    // FLUX-1672: front matter but no block-splice-incompatible constructs — the realistic "real
    // knowledge repo" shape (owner/sources on a normal article), which should now open rendered.
    FRONTMATTER_CLEAN_DOC: {
      path: 'guide/clean-frontmatter',
      title: 'Clean Frontmatter',
      body: multiblockCleanBody,
      slug: 'clean-frontmatter',
      directory: 'guide',
      extraFrontmatter: { owner: 'team-docs' },
    },
    // FLUX-1674: no extra front-matter and no block-splice-incompatible constructs — opens in
    // Rich text mode, exercising the block-splice save path with a mermaid fence present.
    MERMAID_DOC: {
      path: 'guide/mermaid',
      title: 'Mermaid Diagram',
      body: mermaidBody,
      slug: 'mermaid',
      directory: 'guide',
    },
  };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  const docsByPath = new Map([
    [RAW_DOC.path, RAW_DOC],
    [RICH_DOC.path, RICH_DOC],
    [MULTIBLOCK_DOC.path, MULTIBLOCK_DOC],
    [FOOTNOTE_DOC.path, FOOTNOTE_DOC],
    [FRONTMATTER_CLEAN_DOC.path, FRONTMATTER_CLEAN_DOC],
    [MERMAID_DOC.path, MERMAID_DOC],
  ]);
  return {
    ...actual,
    fetchDocs: vi.fn().mockResolvedValue([RAW_DOC, RICH_DOC, MULTIBLOCK_DOC, FOOTNOTE_DOC, FRONTMATTER_CLEAN_DOC, MERMAID_DOC]),
    fetchDoc: vi.fn().mockImplementation((path: string) =>
      Promise.resolve(docsByPath.get(path) ?? RAW_DOC)),
    fetchDocRevisions: vi.fn().mockResolvedValue([]),
    fetchGroupStatus: vi.fn().mockResolvedValue({ configured: false, docsLabel: 'Product', members: [] }),
    updateDoc: vi.fn().mockImplementation((path: string, payload: { title?: string; body?: string }) =>
      Promise.resolve({ ...(docsByPath.get(path) ?? RAW_DOC), ...payload })),
    renameDocsFolder: vi.fn().mockResolvedValue(undefined),
  };
});

describe('DocsScreen markdown round-trip fidelity (FLUX-1654)', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    vi.clearAllMocks();
  });

  // FLUX-1672: extra front-matter no longer forces raw mode by itself (that FLUX-1654 default was
  // retired now that front matter round-trips verbatim regardless of mode). This fixture's body
  // still lands in raw mode, but now via the capability-gap path: its non-sequential list
  // numbering + raw `<details>` HTML trip the block-splice count-mismatch safety net at render
  // time (FLUX-1663), which reactively falls back to raw and re-seeds the verbatim body.
  it('falls back to raw Markdown mode, verbatim, for a doc whose body is block-splice-incompatible', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');

    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.docs-editor-content') as HTMLTextAreaElement | null;
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });

    // Byte-identical load: the exact fixture body, no turndown/marked round trip.
    expect(textarea.value).toBe(ANZU_BRAIN_BODY);
    expect(screen.getByText('Markdown').className).toContain('bg-white');
  });

  it('defaults a doc with no extra front-matter to Rich text mode', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    fireEvent.click(screen.getByText('Overview'));
    await waitFor(() => expect(document.querySelector('textarea.docs-editor-content')).toBeNull());

    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).not.toBeNull();
    });
    expect(screen.getByText('Rich text').className).toContain('bg-white');
  });

  // FLUX-1672 AC1: a doc carrying front matter (owner/sources) but no block-splice-incompatible
  // constructs — the realistic shape for a real knowledge repo — now opens rendered by default,
  // with the front matter surfaced as a collapsible strip (collapsed by default) instead of
  // forcing raw mode.
  it('opens a doc with clean front matter in Rich text mode, with a collapsed front-matter strip', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    fireEvent.click(screen.getByText('Clean Frontmatter'));

    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).not.toBeNull();
    });
    expect(screen.getByText('Rich text').className).toContain('bg-white');
    expect(document.querySelector('textarea.docs-editor-content')).toBeNull();

    const stripToggle = await screen.findByText('Front matter');
    expect(screen.queryByText('team-docs')).toBeNull();
    fireEvent.click(stripToggle);
    await screen.findByText('team-docs');
  });

  it('saves raw-mode edits byte-for-byte, with no reformatting of untouched content', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    const { updateDoc } = await import('../api');
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.docs-editor-content') as HTMLTextAreaElement | null;
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });

    const editedBody = `${ANZU_BRAIN_BODY}\nOne more appended line.\n`;
    fireEvent.change(textarea, { target: { value: editedBody } });

    const saveButton = await screen.findByText('Save');
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateDoc).toHaveBeenCalled());
    const [, payload] = (updateDoc as ReturnType<typeof vi.fn>).mock.calls[0];
    // The saved body is exactly what was typed — no bullet/emphasis/list-numbering/table
    // normalization, and the untouched portion is byte-identical to the original fixture.
    expect(payload.body).toBe(editedBody);
    expect(payload.body.startsWith(ANZU_BRAIN_BODY)).toBe(true);
  });

  it('switching Rich text -> Markdown -> Rich text carries content without loss', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    fireEvent.click(screen.getByText('Overview'));
    await waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull());

    fireEvent.click(screen.getByText('Markdown'));
    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.docs-editor-content') as HTMLTextAreaElement | null;
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });
    expect(textarea.value.trim()).toBe('Hello world');

    fireEvent.click(screen.getByText('Rich text'));
    await waitFor(() => {
      const prose = document.querySelector('.ProseMirror');
      expect(prose?.textContent).toContain('Hello world');
    });
  });
});

// FLUX-1671: an external change (merged PR, another tab's save) to the doc currently open in the
// editor previously left the docs viewer's client state adrift -- false-dirty prompts, stale or
// empty editor content, and a Save that could write that bad buffer over a good on-disk article.
describe('DocsScreen external doc update state machine (FLUX-1671)', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    vi.clearAllMocks();
  });

  // Renaming an UNRELATED folder ('guide', not 'anzu-brain') bumps `docsRefreshKey` -- the real
  // trigger behind the docs-list refresh -- without touching `selectedPath`/`workspacePath`, so it
  // never also re-fires the load-on-select effect. This isolates the docs-list-refresh
  // reconciliation fix under test from that separate, pre-existing full-reload-on-nav path.
  const renameUnrelatedFolder = async () => {
    fireEvent.click(screen.getByTitle('Rename guide'));
    const input = screen.getByDisplayValue('guide');
    fireEvent.change(input, { target: { value: 'guide-renamed' } });
    fireEvent.click(screen.getByTitle('Save name'));
    const { renameDocsFolder } = await import('../api');
    await waitFor(() => expect(renameDocsFolder).toHaveBeenCalled());
  };

  it('reconciles an external change to the open, non-dirty doc -- no false-dirty prompt, fresh content applied', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    const { fetchDocs } = await import('../api');
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.docs-editor-content') as HTMLTextAreaElement | null;
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });
    expect(textarea.value).toBe(ANZU_BRAIN_BODY);

    // Simulate PRs merging into this doc's file while it's open, unedited.
    const externallyUpdatedRawDoc = { ...RAW_DOC, body: `${ANZU_BRAIN_BODY}Merged externally.\n` };
    (fetchDocs as ReturnType<typeof vi.fn>).mockResolvedValueOnce([externallyUpdatedRawDoc, RICH_DOC, MULTIBLOCK_DOC, FOOTNOTE_DOC]);

    await renameUnrelatedFolder();

    // The open doc picked up the fresh body -- no stale content, no empty buffer.
    await waitFor(() => expect(textarea.value).toBe(externallyUpdatedRawDoc.body));

    // No edits were made -- navigating away must not false-prompt "Discard unsaved doc changes?".
    fireEvent.click(screen.getByText('Overview'));
    expect(screen.queryByText('Discard unsaved doc changes?')).toBeNull();

    // The new selection renders ITS OWN content -- never the previous doc's body, never empty.
    await waitFor(() => {
      const prose = document.querySelector('.ProseMirror');
      expect(prose?.textContent).toContain('Hello world');
    });
    expect(document.querySelector('textarea.docs-editor-content')).toBeNull();
  });

  it('routes an external change to a DIRTY open doc through the conflict banner instead of overwriting the draft or silently going dirty', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    const { fetchDocs, updateDoc } = await import('../api');
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.docs-editor-content') as HTMLTextAreaElement | null;
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });

    const myDraft = `${ANZU_BRAIN_BODY}My local unsaved edit.\n`;
    fireEvent.change(textarea, { target: { value: myDraft } });
    const saveButton = await screen.findByText('Save');
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));

    const externallyUpdatedRawDoc = { ...RAW_DOC, body: `${ANZU_BRAIN_BODY}Merged externally.\n` };
    (fetchDocs as ReturnType<typeof vi.fn>).mockResolvedValueOnce([externallyUpdatedRawDoc, RICH_DOC, MULTIBLOCK_DOC, FOOTNOTE_DOC]);

    await renameUnrelatedFolder();

    // The user's unsaved draft is never silently overwritten by the external change...
    expect(textarea.value).toBe(myDraft);
    // ...and the conflict banner (FLUX-1655) surfaces instead of a silent dirty-flag drift.
    await screen.findByText(/changed on disk since you loaded it/i);

    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('Save refuses to write an empty buffer over a non-empty on-disk doc', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    const { updateDoc } = await import('../api');
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.docs-editor-content') as HTMLTextAreaElement | null;
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });

    fireEvent.change(textarea, { target: { value: '' } });
    const saveButton = await screen.findByText('Save');
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);

    await screen.findByText(/Refusing to save/i);
    expect(updateDoc).not.toHaveBeenCalled();
  });
});

describe('DocsScreen block-scoped rendered editing (FLUX-1663)', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    vi.clearAllMocks();
  });

  it('a Rich text no-op save (title-only edit) is byte-identical to the on-disk body', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    const { updateDoc } = await import('../api');
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    fireEvent.click(screen.getByText('Multiblock'));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')?.textContent).toContain('Provenance notes');
    });

    // Force isDirty via a TITLE-only edit -- the rendered body itself is never touched, so a
    // byte-identical splice result exercises the real block-splice save wiring end to end
    // (not just "nothing happened" from a no-op UI where Save would stay disabled).
    const titleButton = document.querySelector('h1 button') as HTMLButtonElement;
    fireEvent.click(titleButton);
    const titleInput = await screen.findByDisplayValue('Multiblock');
    fireEvent.change(titleInput, { target: { value: 'Multiblock Renamed' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });

    const saveButton = await screen.findByText('Save');
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateDoc).toHaveBeenCalled());
    const [, payload] = (updateDoc as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.title).toBe('Multiblock Renamed');
    // Every block is unchanged -- the block-splice save must copy the ENTIRE body verbatim from
    // source bytes, byte-for-byte, matching FLUX-1654's raw-mode fidelity bar in Rich text mode too.
    expect(payload.body).toBe(MULTIBLOCK_DOC.body);
  });

  // FLUX-1674: the live TipTap editor must NOT render the mermaid fence as a diagram — it stays
  // an editable fenced code block there (only the read-only preview renders Mermaid), and the
  // fence's markdown bytes round-trip exactly through the block-splice save path.
  it('a mermaid fence stays an editable code block in Rich text mode and round-trips byte-for-byte', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    const { updateDoc } = await import('../api');
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    fireEvent.click(screen.getByText('Mermaid Diagram'));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')?.textContent).toContain('Architecture');
    });

    // The fence renders as a plain code block in the editor -- never an SVG/diagram element.
    const proseMirror = document.querySelector('.ProseMirror') as HTMLElement;
    expect(proseMirror.querySelector('svg')).toBeNull();
    expect(proseMirror.querySelector('pre code')).not.toBeNull();
    expect(proseMirror.textContent).toContain('graph TD');

    // Force isDirty via a title-only edit -- the rendered body itself is never touched, so a
    // byte-identical splice result confirms the mermaid fence's bytes are preserved verbatim.
    const titleButton = document.querySelector('h1 button') as HTMLButtonElement;
    fireEvent.click(titleButton);
    const titleInput = await screen.findByDisplayValue('Mermaid Diagram');
    fireEvent.change(titleInput, { target: { value: 'Mermaid Diagram Renamed' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });

    const saveButton = await screen.findByText('Save');
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateDoc).toHaveBeenCalled());
    const [, payload] = (updateDoc as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.title).toBe('Mermaid Diagram Renamed');
    expect(payload.body).toBe(MERMAID_DOC.body);
  });

  it('a document with footnotes opens in Markdown mode with a visible notice', async () => {
    appStore.patch({ currentUser: 'tester', config: undefined, workspacePath: '/repo' });
    render(<ConfirmProvider><DocsScreen /></ConfirmProvider>);

    await screen.findByText('Provenance');
    fireEvent.click(screen.getByText('Footnotes'));

    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.docs-editor-content') as HTMLTextAreaElement | null;
      expect(el?.value).toBe(FOOTNOTE_DOC.body);
      return el as HTMLTextAreaElement;
    });

    // Falls back to raw mode -- never silently mis-serializes a doc with a global construct
    // (footnotes) that single-block serialization can't safely handle.
    expect(textarea.value).toBe(FOOTNOTE_DOC.body);
    expect(screen.getByText('Markdown').className).toContain('bg-white');
    expect(screen.getByText(/uses footnotes/i)).toBeTruthy();
  });
});
