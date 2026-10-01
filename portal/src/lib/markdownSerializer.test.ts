// @vitest-environment jsdom
// FLUX-1719: round-trip fidelity for the shared HTML<->HTML / HTML->markdown serializer used by
// both rich-text editors. Each corpus entry is driven through the REAL pipeline the editors use --
// marked -> shapeTaskLists -> a real TipTap Editor -> htmlToMarkdown -- so assertions bind to the
// DOM TipTap actually produces, not a hand-written HTML fixture.
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { TaskList } from '@tiptap/extension-list';
import { TaskItem } from '@tiptap/extension-list';
import { marked } from 'marked';
import { htmlToMarkdown, shapeTaskLists } from './markdownSerializer';

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdownToHtml(markdown: string): string {
  return (marked.parse(markdown) as string) || '<p></p>';
}

function createTestEditor(resizableTables: boolean): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      Table.configure({ resizable: resizableTables }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: '<p></p>',
    editable: true,
  });
}

// Renders `markdown` through the same pipeline the editors use, then serializes the live editor
// DOM back to markdown. `editor` defaults to a fresh non-resizable-table instance (DocsScreen's
// config); pass a shared editor to reuse one across a describe block.
function roundTrip(markdown: string, editor?: Editor): string {
  const own = editor ?? createTestEditor(false);
  const html = shapeTaskLists(renderMarkdownToHtml(markdown));
  own.commands.setContent(html, { emitUpdate: false });
  const result = htmlToMarkdown(own.getHTML());
  if (!editor) {
    own.destroy();
  }
  return result;
}

// `editor.getHTML()` serializes via each node's schema `renderHTML` spec. `DocsScreen`'s actual
// save path (`getSpliceableTopLevelNodeHtmls`) instead reads `editor.view.dom.children` outerHTML
// -- the LIVE DOM, built by a node's `addNodeView` when it has one (TaskItem does). The two can
// differ (TaskItem's node view never copies the `data-type` its bypassed `renderHTML` would have
// set), so a checklist/table round-trip must be verified against BOTH shapes.
function roundTripViaLiveDom(markdown: string, editor?: Editor): string {
  const own = editor ?? createTestEditor(false);
  const html = shapeTaskLists(renderMarkdownToHtml(markdown));
  own.commands.setContent(html, { emitUpdate: false });
  const liveHtml = Array.from(own.view.dom.children).map((child) => (child as HTMLElement).outerHTML).join('');
  const result = htmlToMarkdown(liveHtml);
  if (!editor) {
    own.destroy();
  }
  return result;
}

// Runs `markdown` through `roundTrip` twice, feeding save 1's output back in as save 2's input.
// Blocker 1 (nested checklist corruption) only manifests on the SECOND save -- save 1 produces
// over-indented-but-still-parseable markdown that `marked` misreads as a lazy paragraph
// continuation, and only save 2 flattens it into the parent item. A single-pass assertion can't
// see that; this can.
function roundTripTwice(markdown: string): { pass1: string; pass2: string } {
  const pass1 = roundTrip(markdown).trim();
  const pass2 = roundTrip(pass1).trim();
  return { pass1, pass2 };
}

describe('markdownSerializer round-trip fidelity (FLUX-1719)', () => {
  it('round-trips a plain GFM table as pipe syntax, not raw HTML', () => {
    const markdown = [
      '| Spec | Value |',
      '| --- | --- |',
      '| one | two |',
      '| three | four |',
    ].join('\n');

    const result = roundTrip(markdown);
    expect(result).not.toContain('<table');
    expect(result).not.toContain('<colgroup');
    expect(result.trim()).toBe(markdown);
  });

  it('round-trips a table nested inside a list item as pipe syntax', () => {
    const markdown = [
      '- Item with a table',
      '',
      '  | A | B |',
      '  | --- | --- |',
      '  | 1 | 2 |',
    ].join('\n');

    const result = roundTrip(markdown);
    expect(result).not.toContain('<table');
  });

  it('round-trips a table under a resizable-table configuration (TaskDescriptionSurface)', () => {
    const editor = createTestEditor(true);
    const markdown = [
      '| Spec | Value |',
      '| --- | --- |',
      '| one | two |',
    ].join('\n');

    const result = roundTrip(markdown, editor);
    editor.destroy();
    expect(result).not.toContain('<table');
    expect(result.trim()).toBe(markdown);
  });

  it('round-trips a tight checklist byte-identical, checkbox and bold label preserved', () => {
    const markdown = [
      '- [ ] **alpha** thing',
      '- [x] beta thing',
    ].join('\n');

    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  it('toggling a checkbox writes the checked state and changes nothing else', () => {
    const editor = createTestEditor(false);
    const markdown = '- [ ] alpha\n- [ ] beta';
    const html = shapeTaskLists(renderMarkdownToHtml(markdown));
    editor.commands.setContent(html, { emitUpdate: false });

    // Directly flip the first task item's `checked` attr via a transaction, mirroring what the
    // TaskItem node view's checkbox `change` handler does.
    let flipped = false;
    editor.state.doc.descendants((node, docPos) => {
      if (!flipped && node.type.name === 'taskItem' && !node.attrs.checked) {
        flipped = true;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(docPos, undefined, { ...node.attrs, checked: true }));
        return false;
      }
      return !flipped;
    });

    const result = htmlToMarkdown(editor.getHTML());
    editor.destroy();
    expect(result.trim()).toBe('- [x] alpha\n- [ ] beta');
  });

  it('round-trips a tight checklist through the LIVE editor DOM (the actual DocsScreen save-path shape)', () => {
    const markdown = ['- [ ] alpha', '- [x] beta'].join('\n');
    expect(roundTripViaLiveDom(markdown).trim()).toBe(markdown);
  });

  it('splits a mixed checkbox/plain list so a plain item never gains a checkbox', () => {
    const markdown = ['- [ ] alpha', '- plain bravo'].join('\n');
    const result = roundTrip(markdown);
    expect(result).not.toContain('- [ ] plain bravo');
    expect(result).toContain('- [ ] alpha');
    expect(result).toContain('- plain bravo');
  });

  it('round-trips a nested bullet list, tight, with 2-space child indentation', () => {
    const markdown = [
      '- one',
      '  - nested bullet',
      '  - another nested bullet',
      '- two',
    ].join('\n');

    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  it('round-trips a nested checklist byte-identical (Blocker 1 regression guard)', () => {
    const markdown = ['- [ ] alpha', '  - [ ] nested', '- [x] beta'].join('\n');
    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  it('round-trips a plain child nested under a task-list parent, byte-identical', () => {
    const markdown = ['- [ ] alpha', '  - plain nested'].join('\n');
    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  it('round-trips a multi-paragraph task item, byte-identical', () => {
    const markdown = ['- [ ] alpha', '', '  more text', '', '- [ ] beta'].join('\n');
    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  describe('idempotency: a second save never differs from the first', () => {
    const samples: Record<string, string> = {
      'nested checklist': ['- [ ] alpha', '  - [ ] nested', '- [x] beta'].join('\n'),
      'deeply nested checklist': ['- [ ] a', '  - [ ] b', '    - [ ] c'].join('\n'),
      'plain child under task parent': ['- [ ] alpha', '  - plain nested'].join('\n'),
      'multi-paragraph task item': ['- [ ] alpha', '', '  more text', '', '- [ ] beta'].join('\n'),
      'flat checklist': ['- [ ] **alpha** thing', '- [x] beta thing'].join('\n'),
      'nested bullet list': ['- one', '  - nested bullet', '  - another nested bullet', '- two'].join('\n'),
      'loose list': ['- one', '', '  second para', '', '- two'].join('\n'),
      'mixed checkbox/plain list': ['- [ ] alpha', '- plain bravo'].join('\n'),
    };

    Object.entries(samples).forEach(([name, markdown]) => {
      it(`${name} is stable across two saves`, () => {
        const { pass1, pass2 } = roundTripTwice(markdown);
        expect(pass2).toBe(pass1);
      });
    });
  });

  it('round-trips an ordered list honoring a non-1 start value', () => {
    const markdown = ['3. first', '4. second', '5. third'].join('\n');
    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  it('round-trips a genuinely loose (multi-paragraph) list item with a real blank line preserved', () => {
    const markdown = ['- one', '', '  second para', '', '- two'].join('\n');
    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  it('round-trips a markdown link unchanged (regression guard)', () => {
    const markdown = 'See [docs](https://example.com/docs) for background.';
    expect(roundTrip(markdown).trim()).toBe(markdown);
  });

  it('round-trips a wiki-link-shaped anchor through a caller-added turndown rule', async () => {
    const { createMarkdownSerializer, normalizeEditorDom } = await import('./markdownSerializer');
    const service = createMarkdownSerializer();
    service.addRule('wiki-links', {
      filter: (node) => node instanceof HTMLElement && node.tagName === 'A' && (node.getAttribute('href') || '').startsWith('wiki:'),
      replacement: (content, node) => `[[${content || decodeURIComponent((node as HTMLElement).getAttribute('href')!.slice(5))}]]`,
    });

    const html = '<p>See <a href="wiki:Related%20Doc">Related Doc</a> for background.</p>';
    const result = service.turndown(normalizeEditorDom(html));
    expect(result.trim()).toBe('See [[Related Doc]] for background.');
  });

  it('leaves a mermaid fence as a plain fenced code block, byte-identical (regression guard)', () => {
    const markdown = [
      '```mermaid',
      'graph TD;',
      '  A[Start] --> B{Decision};',
      '```',
    ].join('\n');

    expect(roundTrip(markdown).trim()).toBe(markdown);
  });
});
