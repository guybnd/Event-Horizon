// FLUX-1663: fidelity-safe rendered editing. The docs rich editor round-tripped the whole
// document through TipTap -> turndown on every save, which reformats every untouched block (bullet
// markers, emphasis delimiters, list renumbering, table padding) into a whole-file diff. This
// module re-serializes ONLY the blocks whose content actually changed and copies every untouched
// top-level block's original source bytes verbatim, using a position-preserving markdown AST
// (mdast) to get exact byte ranges for the splice.
//
// Dirty-block detection is a SAVE-TIME content-signature alignment, not live transaction
// tracking: the caller snapshots each top-level block's signature on load, recomputes signatures
// at save time, and this module aligns current <-> clean by signature equality (tolerant of
// insert/delete/reorder, since matching is by value, not position).
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export interface Block {
  sourceText: string;
  startOffset: number;
  endOffset: number;
}

interface MdastNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdastNode[];
}

function parseTree(body: string): MdastNode {
  return fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as MdastNode;
}

export function parseBlocks(body: string): Block[] {
  const tree = parseTree(body);

  return (tree.children ?? []).map((node) => {
    const startOffset = node.position?.start.offset ?? 0;
    const endOffset = node.position?.end.offset ?? body.length;

    return {
      sourceText: body.slice(startOffset, endOffset),
      startOffset,
      endOffset,
    };
  });
}

// Reference-style links (`[text][ref]` + `[ref]: url`) and footnotes (`[^1]` + `[^1]: text`) are
// global constructs: a definition can be referenced from any block, so serializing one block at a
// time can silently drop or duplicate shared state. Detect and fall back to raw mode instead.
function findUnsupportedNodeType(node: MdastNode, predicate: (type: string) => boolean): boolean {
  if (predicate(node.type)) {
    return true;
  }

  return (node.children ?? []).some((child) => findUnsupportedNodeType(child, predicate));
}

export function detectUnsupported(body: string): { supported: boolean; reason?: string } {
  const tree = parseTree(body);
  const hasFootnote = (tree.children ?? []).some((node) =>
    findUnsupportedNodeType(node, (type) => type === 'footnoteReference' || type === 'footnoteDefinition'));

  if (hasFootnote) {
    return { supported: false, reason: 'This document uses footnotes, which rendered editing does not yet support.' };
  }

  const hasRefLink = (tree.children ?? []).some((node) =>
    findUnsupportedNodeType(node, (type) => type === 'linkReference' || type === 'definition'));

  if (hasRefLink) {
    return { supported: false, reason: 'This document uses reference-style links, which rendered editing does not yet support.' };
  }

  return { supported: true };
}

// Greedy signature-equality alignment: for each current block, claim the first not-yet-consumed
// clean block with an equal signature. Order-tolerant (unlike a strict order-preserving LCS), which
// is what makes a plain reorder of two unchanged blocks resolve to both blocks matching their own
// original bytes regardless of position.
function alignBySignature(cleanSigs: string[], currentSigs: string[]): number[] {
  const available = new Map<string, number[]>();
  cleanSigs.forEach((sig, index) => {
    const queue = available.get(sig);
    if (queue) {
      queue.push(index);
    } else {
      available.set(sig, [index]);
    }
  });

  return currentSigs.map((sig) => {
    const queue = available.get(sig);
    if (queue && queue.length > 0) {
      return queue.shift()!;
    }
    return -1;
  });
}

export function spliceEditedBlocks(
  originalBody: string,
  cleanSigs: string[],
  currentBlocks: Array<{ signature: string; content: string }>,
): string {
  const originalBlocks = parseBlocks(originalBody);

  if (originalBlocks.length === 0) {
    return currentBlocks.map((block) => block.content).join('\n\n');
  }

  const matchedIndices = alignBySignature(cleanSigs, currentBlocks.map((block) => block.signature));
  const sameCount = originalBlocks.length === currentBlocks.length;

  const prefix = originalBody.slice(0, originalBlocks[0].startOffset);
  const suffix = originalBody.slice(originalBlocks[originalBlocks.length - 1].endOffset);

  let result = prefix;
  currentBlocks.forEach((block, index) => {
    const matchedIndex = matchedIndices[index];
    result += matchedIndex >= 0 ? originalBlocks[matchedIndex].sourceText : block.content;

    if (index < currentBlocks.length - 1) {
      // Same block count means this is a pure edit/reorder (no insert/delete) -- reuse the exact
      // original inter-block whitespace so unrelated blocks' line numbers never shift. A changed
      // count (insert/delete) has no single original gap that's still valid, so fall back to a
      // canonical blank-line separator.
      result += sameCount
        ? originalBody.slice(originalBlocks[index].endOffset, originalBlocks[index + 1].startOffset)
        : '\n\n';
    }
  });
  result += suffix;

  return result;
}
