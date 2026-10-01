// FLUX-1719: shared HTML<->HTML and HTML->markdown serialization for the docs and ticket-description
// rich-text editors. This module never owns the markdown->HTML step (each surface keeps its own
// renderer) -- it only shapes the HTML TipTap will parse (`shapeTaskLists`) and serializes TipTap's
// own rendered HTML back to markdown with fidelity turndown's defaults don't provide on their own:
//
// - GFM tables without a `<thead>` (TipTap never emits one) defeat turndown-plugin-gfm's
//   `isHeadingRow` check, so the table falls through to its `keep()` raw-HTML fallback.
// - Neither editor registers TaskList/TaskItem, so ProseMirror drops a marked checkbox `<input>` at
//   parse time -- the checkbox is gone before turndown ever runs.
// - Turndown's built-in `listItem` rule always emits a 4-char bullet prefix (`"-   "`) and adds an
//   extra blank line between tight items (its `isParagraph` check fires for any `<li><p>` shape,
//   which is exactly what a rendered single-paragraph item looks like).
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

function unwrapElement(el: Element) {
  const parent = el.parentNode;
  if (!parent) {
    return;
  }
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
}

// marked emits a GFM checkbox as an inline `<input disabled type="checkbox">` token at the very
// start of a list item's inline content -- wrapped in a `<p>` for a loose list, bare otherwise --
// never as a dedicated node of its own.
function findLeadingCheckbox(item: Element): HTMLInputElement | null {
  const first = item.firstElementChild;
  if (first instanceof HTMLInputElement && first.type === 'checkbox') {
    return first;
  }
  if (first?.tagName === 'P') {
    const firstInParagraph = first.firstElementChild;
    if (firstInParagraph instanceof HTMLInputElement && firstInParagraph.type === 'checkbox') {
      return firstInParagraph;
    }
  }
  return null;
}

/**
 * Pure HTML -> HTML. Rewrites marked's GFM checkbox list items into the shape
 * `@tiptap/extension-list`'s TaskList/TaskItem `parseHTML` match:
 * `<ul data-type="taskList"><li data-type="taskItem" data-checked="true|false">...`
 *
 * GFM allows one list to mix checkbox and plain items (marked emits a single `<ul>` for that), but
 * TipTap's taskList content model is `taskItem+` -- tagging the whole `<ul>` would make every child
 * parse as a task item, turning a plain sibling into a checkbox it never had. Split a mixed list
 * into consecutive sibling lists instead, one per checkbox/plain run.
 */
export function shapeTaskLists(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  Array.from(doc.querySelectorAll('ul, ol')).forEach((list) => {
    const items = Array.from(list.children).filter((child): child is HTMLLIElement => child.tagName === 'LI');
    if (items.length === 0) {
      return;
    }

    const runs: { isTask: boolean; items: HTMLLIElement[] }[] = [];
    items.forEach((item) => {
      const checkbox = findLeadingCheckbox(item);
      const isTask = checkbox !== null;

      if (checkbox) {
        item.setAttribute('data-type', 'taskItem');
        item.setAttribute('data-checked', checkbox.checked ? 'true' : 'false');
        checkbox.remove();

        // Strip the leading space marked's checkbox renderer emits between the checkbox and the
        // item's label text (`<input ...> label` -- the space is part of the same inline run).
        const container = item.querySelector('p') || item;
        const firstNode = container.firstChild;
        if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
          firstNode.textContent = (firstNode.textContent || '').replace(/^ /, '');
        }
      }

      const lastRun = runs[runs.length - 1];
      if (lastRun && lastRun.isTask === isTask) {
        lastRun.items.push(item);
      } else {
        runs.push({ isTask, items: [item] });
      }
    });

    if (runs.length === 1) {
      if (runs[0].isTask) {
        list.setAttribute('data-type', 'taskList');
      }
      return;
    }

    // Mixed list: replace the original list element with one sibling list per run, in order.
    const parent = list.parentNode!;
    runs.forEach((run) => {
      const runList = doc.createElement(list.tagName.toLowerCase());
      if (run.isTask) {
        runList.setAttribute('data-type', 'taskList');
      }
      run.items.forEach((item) => runList.appendChild(item));
      parent.insertBefore(runList, list);
    });
    parent.removeChild(list);
  });

  return doc.body.innerHTML;
}

/**
 * Pure HTML -> HTML. Normalizes TipTap's own rendered HTML (from `editor.getHTML()` or the live
 * DOM) into the shape turndown needs for round-trip fidelity, before it ever sees the document.
 */
export function normalizeEditorDom(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll('table').forEach((table) => {
    table.removeAttribute('style');
    table.querySelectorAll('colgroup').forEach((colgroup) => colgroup.remove());

    // Promote an all-<th> first row out of <tbody> into a real <thead> -- turndown-plugin-gfm's
    // `isHeadingRow` needs a THEAD parent (or an untagged first-TBODY row with no THEAD sibling),
    // and TipTap's Table extension never emits a <thead> at all.
    const firstRow = table.querySelector('tr');
    const firstRowBody = firstRow?.parentElement;
    if (firstRow && firstRowBody?.tagName === 'TBODY' && firstRowBody === table.querySelector('tbody')) {
      const allHeaderCells = firstRow.children.length > 0
        && Array.from(firstRow.children).every((cell) => cell.tagName === 'TH');
      if (allHeaderCells) {
        const thead = doc.createElement('thead');
        thead.appendChild(firstRow);
        table.insertBefore(thead, firstRowBody);
      }
    }
  });

  doc.querySelectorAll('th, td').forEach((cell) => {
    if (cell.getAttribute('colspan') === '1') {
      cell.removeAttribute('colspan');
    }
    if (cell.getAttribute('rowspan') === '1') {
      cell.removeAttribute('rowspan');
    }
    cell.removeAttribute('colwidth');

    // A cell's sole paragraph round-trips as embedded newlines in the pipe-table cell text
    // (turndown's `paragraph` rule wraps it in `\n\n...\n\n`) unless unwrapped first.
    if (cell.children.length === 1 && cell.firstElementChild?.tagName === 'P') {
      unwrapElement(cell.firstElementChild);
    }
  });

  doc.querySelectorAll('li').forEach((item) => {
    // Undo the TaskItem node view's editing chrome: `<label><input/><span/></label><div>content</div>`
    // back down to the content alone, with checked-ness already carried on the <li>'s own
    // `data-checked` attribute. Detect via `data-checked` (not `data-type="taskItem"`) --
    // `editor.getHTML()` serializes via the node's schema `renderHTML` spec (which includes
    // `data-type`), but the LIVE DOM (`editor.view.dom`, what `DocsScreen`'s block-splice save path
    // reads) is built by TaskItem's imperative `addNodeView` instead, whose hand-rolled attribute
    // application never copies the hardcoded `data-type` the (bypassed) `renderHTML` spec would
    // have set -- `data-checked` (from the `checked` NodeAttribute) is the one thing both paths emit.
    if (item.hasAttribute('data-checked')) {
      item.querySelectorAll(':scope > label').forEach((label) => label.remove());
      const contentDiv = item.querySelector(':scope > div');
      if (contentDiv) {
        unwrapElement(contentDiv);
      }
    }

    // Unwrap a leading sole <p> so a tight (single-paragraph) item serializes without turndown's
    // paragraph rule inserting a spurious blank line. A genuinely loose (multi-paragraph) item
    // keeps its <p> tags -- there's no ProseMirror tight/loose flag to tell the two apart, so a
    // list where every item happens to have exactly one paragraph re-serializes tight even if the
    // source markdown had blank lines between items (accepted -- semantically identical markdown).
    const paragraphChildren = Array.from(item.children).filter((child) => child.tagName === 'P');
    if (paragraphChildren.length === 1 && item.firstElementChild?.tagName === 'P') {
      unwrapElement(item.firstElementChild);
    }
  });

  return doc.body.innerHTML;
}

function tightListItemRule(): TurndownService.Rule {
  return {
    filter: 'li',
    replacement: (content, node) => {
      const item = node as HTMLLIElement;
      const parent = item.parentElement;

      let marker: string;
      if (parent?.tagName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.prototype.indexOf.call(parent.children, item);
        marker = `${start ? Number(start) + index : index + 1}. `;
      } else {
        marker = '- ';
      }

      // Capture the indent from the marker BEFORE the checkbox prefix is appended -- a GFM task
      // checkbox is list-item content, not part of the list marker, so the content column of
      // `- [ ] alpha` is 2 (the width of `- `), not 6 (the width of `- [ ] `). Indenting
      // continuation lines by the post-checkbox width puts them past the content start, which
      // markdown no longer parses as nested list content -- it re-parses as a lazy paragraph
      // continuation of the parent item on the very next save.
      const indent = ' '.repeat(marker.length);

      if (item.hasAttribute('data-checked')) {
        marker += item.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ';
      }

      const trimmed = content.replace(/^\n+/, '').replace(/\n+$/, '');
      // Indent every continuation line, but leave blank lines empty -- indenting a blank line
      // would make a loose item's inter-paragraph gap not a real blank line.
      const indented = trimmed
        .split('\n')
        .map((line, index) => (index === 0 || line.length === 0 ? line : indent + line))
        .join('\n');
      const isLastItem = !item.nextElementSibling;
      const isLoose = Array.from(item.children).filter((child) => child.tagName === 'P').length > 1;

      return marker + indented + (isLastItem ? '' : isLoose ? '\n\n' : '\n');
    },
  };
}

function createSerializerService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  service.use(gfm);
  service.addRule('tightListItem', tightListItemRule());

  return service;
}

/** HTML -> markdown, via `normalizeEditorDom` then turndown. Callers add their own surface-specific
 *  rules (e.g. wiki-link handling) with `service.addRule` before calling `turndown` directly if they
 *  need more than this default pipeline -- see `createMarkdownSerializer`. */
export function htmlToMarkdown(html: string): string {
  return createSerializerService().turndown(normalizeEditorDom(html));
}

/** Builds a turndown service pre-loaded with the shared rules (gfm + tightListItem), for a caller
 *  that needs to add its own rules (e.g. `DocsScreen`'s wiki-link rule) before converting. Always
 *  run HTML through `normalizeEditorDom` before handing it to the returned service's `turndown`. */
export function createMarkdownSerializer(): TurndownService {
  return createSerializerService();
}
