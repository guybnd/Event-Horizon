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

/**
 * FLUX-1362: an artifact-region annotation, mirrored LIVE out of the sandboxed iframe into the host
 * so it can join the plan-text {@link PlanAnnotation}s in ONE unified, editable list (the floating
 * "N changes" pill). `id` is the in-iframe pin id — stable within a viewer session — so a host-side
 * edit/remove can reverse-sync to the matching `data-eh-pin`. `text` (a text selection) OR `label`
 * (a right-clicked element) supplies the human anchor; `selector` is the CSS path the agent locates.
 */
export interface ArtifactAnnotation {
  id: number;
  kind: 'text' | 'element' | 'feel' | 'decision';
  selector: string;
  text: string;
  label: string;
  note: string;
  /** FLUX-1440: a captured control value ('feel') or chosen option ('decision') from the artifact's
   *  guided controls. Absent for the pre-existing 'text'/'element' kinds. */
  value?: string;
  /** The artifact revision the pin was placed on. */
  rev: number;
}

/**
 * FLUX-1362: compose the `🎯 Artifact annotations` chat/regroom block from the unified host-side
 * list (formerly built inside `ArtifactPanel.sendAnnotationBatch` from the in-iframe Send batch).
 * Mirrors that shape so agents (and history readers) recognize the region-anchored format.
 */
export function formatArtifactAnnotations(items: ArtifactAnnotation[]): string {
  if (items.length === 0) return '';
  const rev = items[items.length - 1]!.rev;
  const blocks = items
    .map((it, i) => {
      const noteLine = it.note ? `   ${it.note}\n` : '';
      const anchorLine = `   _anchor:_ \`${it.selector || '(document)'}\``;
      // FLUX-1440: guided-control captures. `value` is the signal — a 'feel'/'decision' item with no
      // `value` (e.g. an older payload, or a kind sent before the control was interacted with) falls
      // through to the text/element rendering below unchanged.
      if (it.kind === 'feel' && it.value) {
        // `label` is the control's declared title (e.g. "Scroll speed") — the engine already bakes
        // any unit into `value` itself (e.g. "40ms"), so label is a descriptive prefix, not a suffix.
        const prefix = it.label ? `${it.label}: ` : 'value: ';
        return `${i + 1}. · ${prefix}\`${it.value}\`\n` + noteLine + anchorLine;
      }
      if (it.kind === 'decision' && it.value) {
        // `label` carries the decision's question; only shown when present so the fixture without one
        // still reads as a plain "chose `x`".
        const prefix = it.label ? `${it.label} — ` : '';
        return `${i + 1}. → ${prefix}chose \`${it.value}\`\n` + noteLine + anchorLine;
      }
      if (it.kind === 'element') {
        // FLUX-1440: a raw right-clicked <input>/<select>/<textarea> also captures `.value` now
        // (readValue in the engine script) — surface it here so it isn't dead data at render time.
        const valueSuffix = it.value ? ` = \`${it.value}\`` : '';
        return `${i + 1}. ⊙ \`${it.label || 'element'}\`${valueSuffix}\n` + noteLine + anchorLine;
      }
      const excerpt = it.text || '(no excerpt)';
      return `${i + 1}. > ${excerpt}\n` + noteLine + anchorLine;
    })
    .join('\n\n');
  return (
    `🎯 **Artifact annotations** · rev ${rev} · ${items.length} region${items.length === 1 ? '' : 's'}\n\n` +
    `${blocks}\n\n` +
    `Please revise the artifact to address ${items.length === 1 ? 'this' : 'these'} and call ` +
    `\`publish_artifact\` to publish the updated revision.`
  );
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
  /** FLUX-1306: `planBodyHash(task.body)` at the moment this draft was composed, when the caller
   *  supplies one. Lets `loadPlanReviewDraft` tell a draft anchored to the CURRENT plan text apart
   *  from one composed against a since-superseded revision (the plan can be revised + re-reviewed
   *  via the engine's auto-loop, or another surface, while the panel stays closed). */
  bodyHash?: string;
}

const drafts = new Map<string, PlanReviewDraft>();

/**
 * @param currentBodyHash When given, a stored draft whose own `bodyHash` is set and DIFFERS is
 * stale — the plan changed underneath it since it was composed (e.g. a revise + re-review ran
 * while the panel was closed). A stale draft is dropped rather than silently rehydrated as if it
 * still anchored to the current plan text.
 */
export function loadPlanReviewDraft(ticketId: string, currentBodyHash?: string): PlanReviewDraft {
  const draft = drafts.get(ticketId);
  if (!draft) return { annotations: [], notes: '' };
  if (currentBodyHash && draft.bodyHash && draft.bodyHash !== currentBodyHash) {
    drafts.delete(ticketId);
    return { annotations: [], notes: '' };
  }
  return draft;
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
 * FLUX-1339: count of unsent feedback items in the ticket's draft — each accumulated inline
 * annotation plus (if present) the freeform notes box, counted as one. Read directly from the
 * module store so surfaces that don't own the panel's React state (the minimized strip, the
 * chat-close guard) can still show/act on "N notes — not sent yet" without the panel mounted.
 */
export function planReviewDraftCount(ticketId: string): number {
  const d = drafts.get(ticketId);
  if (!d) return 0;
  return d.annotations.length + (d.notes.trim() ? 1 : 0);
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
