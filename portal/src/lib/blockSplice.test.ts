// FLUX-1663: pins the block-splice engine contract used by the docs rich editor to make
// rendered-mode saves produce clean diffs. No TipTap instance involved — this module is pure
// text-in/text-out, so it's testable without mounting an editor.
import { describe, expect, it } from 'vitest';
import { detectUnsupported, parseBlocks, spliceEditedBlocks } from './blockSplice';

// Anzu-brain-style regression anchor (mirrors DocsScreen.roundtrip.test.tsx's ANZU_BRAIN_BODY): a
// GFM table, a fenced code block with nested backticks, a mixed/non-sequential ordered+nested
// list, a wiki link, inline HTML, and underscore emphasis -- every construct turndown's default
// options are known to reformat, and every one of them must round-trip verbatim when untouched.
const CORPUS_BODY = [
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
].join('\n');

function cleanSigsFor(body: string) {
  return parseBlocks(body).map((block) => block.sourceText);
}

function currentBlocksFor(body: string) {
  return parseBlocks(body).map((block) => ({ signature: block.sourceText, content: block.sourceText }));
}

function lineDiffIndices(a: string, b: string): number[] {
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const max = Math.max(linesA.length, linesB.length);
  const diffs: number[] = [];
  for (let i = 0; i < max; i += 1) {
    if (linesA[i] !== linesB[i]) {
      diffs.push(i);
    }
  }
  return diffs;
}

describe('blockSplice', () => {
  describe('parseBlocks', () => {
    it('returns one Block per top-level mdast node, with offsets that slice back to sourceText exactly', () => {
      const blocks = parseBlocks(CORPUS_BODY);

      // heading, paragraph, table, list, fenced code, inline HTML = 6 top-level blocks.
      expect(blocks.length).toBe(6);
      blocks.forEach((block) => {
        expect(CORPUS_BODY.slice(block.startOffset, block.endOffset)).toBe(block.sourceText);
      });
    });

    it('is deterministic and stable in length across two calls on the same body', () => {
      const first = parseBlocks(CORPUS_BODY);
      const second = parseBlocks(CORPUS_BODY);
      expect(second.length).toBe(first.length);
      expect(second.map((b) => b.sourceText)).toEqual(first.map((b) => b.sourceText));
    });
  });

  describe('spliceEditedBlocks', () => {
    it('returns a byte-identical body for a no-op splice', () => {
      const cleanSigs = cleanSigsFor(CORPUS_BODY);
      const currentBlocks = currentBlocksFor(CORPUS_BODY);

      const result = spliceEditedBlocks(CORPUS_BODY, cleanSigs, currentBlocks);

      expect(result).toBe(CORPUS_BODY);
    });

    it('scopes a single-block edit to only that block\'s line range', () => {
      const cleanSigs = cleanSigsFor(CORPUS_BODY);
      const currentBlocks = currentBlocksFor(CORPUS_BODY);

      // Edit exactly the heading block (index 0): new signature + new content.
      const editedHeading = '# Provenance notes (updated)';
      currentBlocks[0] = { signature: editedHeading, content: editedHeading };

      const result = spliceEditedBlocks(CORPUS_BODY, cleanSigs, currentBlocks);

      expect(result).not.toBe(CORPUS_BODY);
      expect(result.startsWith(editedHeading)).toBe(true);

      const diffLines = lineDiffIndices(CORPUS_BODY, result);
      // Only line 0 (the heading) should differ; every other line -- including the blank
      // separator line and every other block -- must be pinned exactly.
      expect(diffLines).toEqual([0]);
    });

    it('scopes an edit inside a nested list to the outermost top-level block only', () => {
      const cleanSigs = cleanSigsFor(CORPUS_BODY);
      const currentBlocks = currentBlocksFor(CORPUS_BODY);
      const listBlockIndex = 3; // heading, paragraph, table, list, code, html

      const originalListBlock = parseBlocks(CORPUS_BODY)[listBlockIndex].sourceText;
      expect(originalListBlock).toContain('nested bullet');

      const editedList = originalListBlock.replace('another nested bullet', 'a fully rewritten nested bullet');
      currentBlocks[listBlockIndex] = { signature: editedList, content: editedList };

      const result = spliceEditedBlocks(CORPUS_BODY, cleanSigs, currentBlocks);

      expect(result).toContain('a fully rewritten nested bullet');
      // Every block after the list (fenced code + inline HTML) is untouched, verbatim.
      expect(result).toContain('````markdown');
      expect(result).toContain('<details><summary>Expand</summary>Hidden content.</details>');
      // Every block before the list (heading, paragraph, table) is untouched, verbatim.
      expect(result.startsWith('# Provenance notes')).toBe(true);
      expect(result).toContain('| Column A | Column B |');
    });

    it('inserts a new block at the requested position, leaving originals verbatim', () => {
      const cleanSigs = cleanSigsFor(CORPUS_BODY);
      const currentBlocks = currentBlocksFor(CORPUS_BODY);
      const newBlockContent = 'A brand-new inserted paragraph.';

      currentBlocks.splice(1, 0, { signature: newBlockContent, content: newBlockContent });

      const result = spliceEditedBlocks(CORPUS_BODY, cleanSigs, currentBlocks);
      const originalBlocks = parseBlocks(CORPUS_BODY);

      const headingIndex = result.indexOf(originalBlocks[0].sourceText);
      const insertedIndex = result.indexOf(newBlockContent);
      const paragraphIndex = result.indexOf(originalBlocks[1].sourceText);

      expect(headingIndex).toBeGreaterThanOrEqual(0);
      expect(insertedIndex).toBeGreaterThan(headingIndex);
      expect(paragraphIndex).toBeGreaterThan(insertedIndex);
      originalBlocks.forEach((block) => {
        expect(result).toContain(block.sourceText);
      });
    });

    it('omits a deleted block, leaving the remaining blocks verbatim', () => {
      const cleanSigs = cleanSigsFor(CORPUS_BODY);
      const currentBlocks = currentBlocksFor(CORPUS_BODY);
      const tableBlockIndex = 2;
      const deletedBlock = parseBlocks(CORPUS_BODY)[tableBlockIndex].sourceText;

      currentBlocks.splice(tableBlockIndex, 1);

      const result = spliceEditedBlocks(CORPUS_BODY, cleanSigs, currentBlocks);
      const originalBlocks = parseBlocks(CORPUS_BODY);

      expect(result).not.toContain(deletedBlock);
      originalBlocks
        .filter((_, index) => index !== tableBlockIndex)
        .forEach((block) => {
          expect(result).toContain(block.sourceText);
        });
    });

    it('reorders two unchanged blocks using their original verbatim source, not re-serialized content', () => {
      const cleanSigs = cleanSigsFor(CORPUS_BODY);
      const currentBlocks = currentBlocksFor(CORPUS_BODY);

      // Swap the heading (0) and paragraph (1) -- same signatures, just reordered.
      [currentBlocks[0], currentBlocks[1]] = [currentBlocks[1], currentBlocks[0]];

      const result = spliceEditedBlocks(CORPUS_BODY, cleanSigs, currentBlocks);
      const originalBlocks = parseBlocks(CORPUS_BODY);

      const paragraphIndex = result.indexOf(originalBlocks[1].sourceText);
      const headingIndex = result.indexOf(originalBlocks[0].sourceText);

      // Paragraph now comes first, heading second -- and both are the ORIGINAL bytes (no
      // turndown re-serialization ran, since neither block's signature changed).
      expect(paragraphIndex).toBeGreaterThanOrEqual(0);
      expect(headingIndex).toBeGreaterThan(paragraphIndex);
      expect(result).toContain(originalBlocks[0].sourceText);
      expect(result).toContain(originalBlocks[1].sourceText);
    });
  });

  describe('detectUnsupported', () => {
    it('flags a body containing a footnote reference and definition', () => {
      const body = `${CORPUS_BODY}\n\nSee this claim.[^1]\n\n[^1]: The footnote text.\n`;
      const result = detectUnsupported(body);

      expect(result.supported).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(result.reason?.toLowerCase()).toContain('footnote');
    });

    it('flags a body containing a reference-style link and its link-reference definition', () => {
      const body = `${CORPUS_BODY}\n\nSee [the docs][ref] for more.\n\n[ref]: https://example.com\n`;
      const result = detectUnsupported(body);

      expect(result.supported).toBe(false);
    });

    it('reports supported=true for the clean multi-block corpus', () => {
      const result = detectUnsupported(CORPUS_BODY);
      expect(result).toEqual({ supported: true });
    });
  });
});
