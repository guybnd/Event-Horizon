/**
 * Advisory-only progress for the `## Acceptance criteria` body convention (FLUX-1148).
 * Mirrors the heading/checklist extraction shape in engine/src/project-scanner.ts
 * (extractHeadingItems + extractChecklistItems), reimplemented client-side since the
 * portal already has the ticket body on hand — no server round-trip needed.
 */

export interface AcceptanceCriteriaProgress {
  done: number;
  total: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CHECKBOX_RE = /^(\s*)-\s*\[( |x|X)\]\s+/;

/**
 * Finds the ticket's own top-level `## Acceptance criteria` heading and counts the GFM
 * checkbox items directly under it — stopping at the next heading of the same or higher
 * level, and ignoring indented (nested) sub-bullets so only the section's own items count.
 * A blockquoted heading (e.g. a subtask quoting its parent's criteria) never matches, since
 * `>` lines don't satisfy `HEADING_RE`. Returns `null` when there's no section, or the
 * section has zero checkbox items — never a "0/0" badge.
 */
export function parseAcceptanceCriteriaProgress(body: string | undefined | null): AcceptanceCriteriaProgress | null {
  if (!body) return null;

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let sectionLevel: number | null = null;
  let done = 0;
  let total = 0;

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      if (sectionLevel !== null) {
        if (level <= sectionLevel) break;
        continue;
      }
      if (level === 2 && /^acceptance criteria$/i.test(headingMatch[2]!.trim())) {
        sectionLevel = level;
      }
      continue;
    }

    if (sectionLevel === null) continue;

    const checkboxMatch = line.match(CHECKBOX_RE);
    if (!checkboxMatch) continue;
    if (checkboxMatch[1]!.length > 0) continue; // nested sub-bullet — not counted

    total++;
    if (checkboxMatch[2]!.toLowerCase() === 'x') done++;
  }

  return total > 0 ? { done, total } : null;
}
