/** FLUX-1303: inline plan annotations — the plan-view sibling of the artifact viewer's in-iframe
 *  annotation flow (FLUX-874/875/892). The user selects text in the PlanApprovalPanel's Plan /
 *  Acceptance Criteria / Tests tabs, attaches a note to the selection, and ACCUMULATES several
 *  notes before sending them together with "Send for re-grooming" (or "Ask in chat"). These are
 *  plain text anchors (the quoted excerpt), not CSS paths — the grooming agent locates the excerpt
 *  in the ticket body directly. */

export interface PlanAnnotation {
  /** The selected excerpt the note anchors to (clipped at capture time). */
  excerpt: string;
  /** The user's note about that excerpt. */
  note: string;
}

/** Cap stored excerpts so a select-all can't bloat the payload; the head is enough to locate it. */
export const PLAN_ANNOTATION_EXCERPT_MAX = 300;

export function clipExcerpt(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > PLAN_ANNOTATION_EXCERPT_MAX ? `${t.slice(0, PLAN_ANNOTATION_EXCERPT_MAX).trimEnd()}…` : t;
}

/**
 * FLUX-1303: per-ticket draft store for the panel's unsent feedback (accumulated annotations + the
 * freeform notes text). Lives at MODULE level — deliberately outside the PlanApprovalPanel's
 * component scope — so closing the panel, switching tickets, or remounting the modal never eats a
 * half-collected batch (the "annotations reset when I moved to another tab" failure the artifact
 * viewer had). Session-lived by design: a draft describes the plan as currently written, so it
 * should not outlive a reload the way durable ticket state does. Cleared on a successful send.
 */
export interface PlanReviewDraft {
  annotations: PlanAnnotation[];
  notes: string;
}

const drafts = new Map<string, PlanReviewDraft>();

export function loadPlanReviewDraft(ticketId: string): PlanReviewDraft {
  return drafts.get(ticketId) ?? { annotations: [], notes: '' };
}

/** Save (or prune, when emptied) the ticket's unsent draft. */
export function savePlanReviewDraft(ticketId: string, draft: PlanReviewDraft): void {
  if (draft.annotations.length === 0 && !draft.notes.trim()) drafts.delete(ticketId);
  else drafts.set(ticketId, draft);
}

export function clearPlanReviewDraft(ticketId: string): void {
  drafts.delete(ticketId);
}

/**
 * Bundle accumulated annotations + the freeform notes textarea into the ONE notes string handed to
 * `startPlanRevise` / "Ask in chat". Mirrors the artifact batch's `🎯 …` message shape so agents
 * (and humans reading history) recognize the region-anchored format.
 */
export function formatRegroomNotes(annotations: PlanAnnotation[], freeform: string): string {
  const parts: string[] = [];
  if (annotations.length > 0) {
    parts.push(
      `🎯 Plan annotations · ${annotations.length} region${annotations.length === 1 ? '' : 's'}:\n\n` +
      annotations.map((a) => `> ${a.excerpt}\n${a.note.trim()}`).join('\n\n'),
    );
  }
  const trimmed = freeform.trim();
  if (trimmed) parts.push(trimmed);
  return parts.join('\n\n');
}
