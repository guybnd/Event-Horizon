import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, MessageSquare, Pencil, Send, X } from 'lucide-react';
import type { ArtifactAnnotation, PlanAnnotation } from '../../lib/planAnnotations';

type EditState = { source: 'plan' | 'artifact'; key: number } | null;

/**
 * Module-scoped claim registry for the guided-controls invitation (FLUX-1440). Two artifact
 * surfaces can be mounted at once (the plan-review panel's controlled pill AND the standalone
 * artifact view's), and each independently detects guided controls — so without coordination the
 * user could see the same "drag a slider" invitation twice. Each pill that wants to show the
 * invitation registers a claim; only the LATEST claim (the most recently opened surface — the one
 * the user is actually looking at) renders it.
 */
let inviteClaims: number[] = [];
let nextInviteClaim = 1;
const inviteListeners = new Set<() => void>();
function notifyInviteListeners() { for (const l of inviteListeners) l(); }
function claimInvite(): number {
  const id = nextInviteClaim++;
  inviteClaims = [...inviteClaims, id];
  notifyInviteListeners();
  return id;
}
function releaseInvite(id: number) {
  inviteClaims = inviteClaims.filter((c) => c !== id);
  notifyInviteListeners();
}
function subscribeInvites(listener: () => void) {
  inviteListeners.add(listener);
  return () => { inviteListeners.delete(listener); };
}
function latestInviteClaim(): number {
  return inviteClaims.length ? inviteClaims[inviteClaims.length - 1] : 0;
}

/** FLUX-1440: the expanded-row anchor label for an artifact annotation — mirrors the symbol/format
 *  conventions `formatArtifactAnnotations` (planAnnotations.ts) uses for the composed chat message,
 *  so the staged-tray row reads the same way the sent message will. Falls back to the existing
 *  text/element anchor when a 'feel'/'decision' item has no `value` yet. */
function artifactAnnotationAnchor(a: ArtifactAnnotation): string {
  // `label` is the control's declared title/question — the engine already bakes any unit into
  // `value` itself (e.g. "40ms"), so label is a descriptive prefix, not a suffix (FLUX-1440).
  if (a.kind === 'feel' && a.value) return `· ${a.label ? `${a.label}: ` : 'value: '}${a.value}`;
  if (a.kind === 'decision' && a.value) return `→ ${a.label ? `${a.label} — ` : ''}chose ${a.value}`;
  // FLUX-1440: surface a raw right-click's captured `.value` (readValue) so it isn't dead data.
  if (a.kind === 'element') return `⊙ ${a.label || 'element'}${a.value ? ` = ${a.value}` : ''}`;
  return `> ${a.text || '(no excerpt)'}`;
}

/**
 * FLUX-1362: one row of the expanded list. Hoisted to module scope (NOT defined inside `AnnotationPill`'s
 * render body) — a component defined inline is a fresh element type on every parent render, so React would
 * unmount/remount the edit `<textarea>` on each keystroke (losing caret position and breaking IME
 * composition). Edit state is threaded in as props so the row stays a pure function of them.
 */
function AnnotationRow({
  source,
  rowKey,
  anchor,
  note,
  onRemove,
  editing,
  draft,
  setDraft,
  beginEdit,
  commitEdit,
  cancelEdit,
}: {
  source: 'plan' | 'artifact';
  rowKey: number;
  anchor: string;
  note: string;
  onRemove?: () => void;
  editing: EditState;
  draft: string;
  setDraft: (v: string) => void;
  beginEdit: (source: 'plan' | 'artifact', key: number, note: string) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
}) {
  const isEditing = editing?.source === source && editing.key === rowKey;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/5 px-2.5 py-1.5 text-[12px]">
      <div className="min-w-0 flex-1">
        <div className="truncate italic text-[var(--eh-text-muted)]">{anchor}</div>
        {isEditing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); cancelEdit(); }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitEdit();
            }}
            rows={2}
            className="eh-border mt-1 w-full resize-none rounded border bg-[var(--eh-input-bg)] px-2 py-1 text-[12px] outline-none focus:border-amber-500"
          />
        ) : (
          <div className="whitespace-pre-wrap break-words text-[var(--eh-text-primary)]">{note || <span className="italic text-[var(--eh-text-muted)]">(no note)</span>}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {isEditing ? (
          <button
            type="button"
            onClick={commitEdit}
            title="Save note"
            className="rounded p-0.5 text-emerald-600 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => beginEdit(source, rowKey, note)}
            title="Edit note"
            className="rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove this annotation"
            className="rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * FLUX-1362: the unified annotation list's collapsed form — a floating "N changes" pill overlaid at
 * the bottom-right of its OWNING surface, so the accumulated feedback never eats working space.
 * Renders as a `position:absolute` full-cover overlay: the parent supplies the positioning context
 * (a `relative` wrapper around the region the pill should float over). It used to be a
 * `position:fixed` portal to document.body, which anchored it to the VIEWPORT bottom-right — far
 * from its panel in a non-maximized layout, on top of the chat composer's send button, and (because
 * a portal escapes the CSS hierarchy) still visible when its stay-mounted owner was `display:none`
 * hidden, producing a stray duplicate pill. Clicking it expands to an editable list that merges the plan-text annotations
 * (`PlanAnnotation`) and the artifact-region annotations (`ArtifactAnnotation`, mirrored live out of
 * the sandboxed iframe) into ONE surface — each row shows its anchor, an editable note, and a remove
 * control. An optional Send action ships the batch (used by the standalone artifact-only view; the
 * plan-review panel drives sending through its own Approve / Send-for-re-grooming footer instead).
 *
 * Dumb + controlled: the owner holds the two arrays and applies edits/removals, which lets the
 * artifact rows reverse-sync to the in-iframe pins (see `ArtifactPanel`). Renders nothing when both
 * lists are empty.
 */
export function AnnotationPill({
  planItems = [],
  artifactItems = [],
  onEditPlan,
  onRemovePlan,
  onEditArtifact,
  onRemoveArtifact,
  onSend,
  sendLabel = 'Send to agent',
  sendDisabled = false,
  sentConfirm,
  hasGuidedControls = false,
}: {
  planItems?: PlanAnnotation[];
  artifactItems?: ArtifactAnnotation[];
  onEditPlan?: (index: number, note: string) => void;
  onRemovePlan?: (index: number) => void;
  onEditArtifact?: (id: number, note: string) => void;
  onRemoveArtifact?: (id: number) => void;
  /** When provided, an explicit "Send to agent" button appears in the expanded list. */
  onSend?: () => void;
  sendLabel?: string;
  sendDisabled?: boolean;
  /** Transient confirmation text shown in place of the pill count after a send (e.g. "✓ Sent 3"). */
  sentConfirm?: string;
  /** FLUX-1440: whether the current artifact revision exposes guided controls (sliders/pickers wired
   *  to emit 'feel'/'decision' annotations). When true AND the list is otherwise empty, the pill
   *  renders a small illustrated invitation instead of staying hidden — plain artifacts (the common
   *  case, this prop falsy) are completely unaffected. */
  hasGuidedControls?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Which row is mid-edit + its scratch text. Keyed by source so a plan index can't collide with an
  // artifact pin id.
  const [editing, setEditing] = useState<EditState>(null);
  const [draft, setDraft] = useState('');

  const count = planItems.length + artifactItems.length;
  // FLUX-1440: an empty list normally renders nothing at all. The one exception is a guided-controls
  // artifact with nothing captured yet — show a compact invitation instead of staying invisible. Every
  // other empty case (plain artifacts, or `hasGuidedControls` falsy) is byte-for-byte the prior
  // `return null` — no visual change for the common case.
  const wantsGuidedEmptyState = count === 0 && !sentConfirm && hasGuidedControls;
  // Register/withdraw this pill's invitation claim so only one surface shows it (see the module
  // registry above). Hooks must run unconditionally, before the empty-case early return.
  const claimRef = useRef<number | null>(null);
  useEffect(() => {
    if (!wantsGuidedEmptyState) return;
    const id = claimInvite();
    claimRef.current = id;
    return () => {
      claimRef.current = null;
      releaseInvite(id);
    };
  }, [wantsGuidedEmptyState]);
  const latestClaim = useSyncExternalStore(subscribeInvites, latestInviteClaim);
  const showGuidedEmptyState = wantsGuidedEmptyState && claimRef.current !== null && latestClaim === claimRef.current;
  if (count === 0 && !sentConfirm && !hasGuidedControls) return null;
  // Another mounted pill owns the invitation — render nothing rather than an empty "0 changes" button.
  if (wantsGuidedEmptyState && !showGuidedEmptyState) return null;

  const beginEdit = (source: 'plan' | 'artifact', key: number, note: string) => {
    setEditing({ source, key });
    setDraft(note);
  };
  const cancelEdit = () => {
    setEditing(null);
    setDraft('');
  };
  const commitEdit = () => {
    if (!editing) return;
    const note = draft.trim();
    if (note) {
      if (editing.source === 'plan') onEditPlan?.(editing.key, note);
      else onEditArtifact?.(editing.key, note);
    }
    setEditing(null);
    setDraft('');
  };

  // Full-cover absolute overlay pinned to the OWNING surface (the caller wraps the region in a
  // `relative` container), so the tally stays with its panel across scroll and tab switches instead
  // of floating at the viewport bottom-right over unrelated UI (the chat composer's send button, the
  // ticket dock). `absolute` — unlike the previous portaled `fixed` — resolves correctly under the
  // chat window's at-rest framer-motion transform, and inherits `display:none` from a stay-mounted
  // hidden owner, so a hidden surface can no longer leak a stray duplicate pill. Expanded list opens
  // upward from the pill; justify-end + the list's min-h-0 let it shrink to the region's height
  // (its internal scroller takes over) instead of overflowing the panel. pointer-events-none on the
  // wrapper (and the purely-informational invitation below) so the overlay never swallows clicks or
  // text selection meant for the content underneath; the interactive children opt back in with
  // pointer-events-auto.
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-end justify-end gap-2 p-3">
      {expanded && count > 0 && (
        <div className="eh-surface eh-border pointer-events-auto flex min-h-0 max-h-[60vh] w-80 max-w-full flex-col overflow-hidden rounded-xl border shadow-2xl">
          <div className="eh-border flex shrink-0 items-center justify-between border-b px-3 py-2 text-[12px] font-semibold text-[var(--eh-text-primary)]">
            <span>{count} change{count === 1 ? '' : 's'}</span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              title="Collapse"
              className="rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
            {planItems.map((a, i) => (
              <AnnotationRow
                key={`plan-${i}`}
                source="plan"
                rowKey={i}
                anchor={`> ${a.excerpt}`}
                note={a.note}
                onRemove={onRemovePlan ? () => onRemovePlan(i) : undefined}
                editing={editing}
                draft={draft}
                setDraft={setDraft}
                beginEdit={beginEdit}
                commitEdit={commitEdit}
                cancelEdit={cancelEdit}
              />
            ))}
            {artifactItems.map((a) => (
              <AnnotationRow
                key={`artifact-${a.id}`}
                source="artifact"
                rowKey={a.id}
                anchor={artifactAnnotationAnchor(a)}
                note={a.note}
                onRemove={onRemoveArtifact ? () => onRemoveArtifact(a.id) : undefined}
                editing={editing}
                draft={draft}
                setDraft={setDraft}
                beginEdit={beginEdit}
                commitEdit={commitEdit}
                cancelEdit={cancelEdit}
              />
            ))}
          </div>
          {onSend && (
            <div className="eh-border flex shrink-0 justify-end border-t px-3 py-2">
              <button
                type="button"
                onClick={onSend}
                disabled={sendDisabled}
                className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-[11.5px] font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
              >
                <Send className="h-3 w-3" /> {sendLabel}
              </button>
            </div>
          )}
        </div>
      )}
      {showGuidedEmptyState ? (
        // FLUX-1440: nothing captured yet, but the artifact has guided controls — a purely informational
        // invitation, not a button (no count to view/expand and no send to trigger; preview-only, same
        // as everything else in this pill — transmission stays behind the explicit Send action above).
        // Inherits the wrapper's pointer-events-none: it must never intercept clicks meant for
        // whatever sits underneath it.
        <div
          role="status"
          className="eh-surface eh-border flex max-w-[15rem] shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] text-[var(--eh-text-secondary)] shadow-lg"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5 flex-shrink-0 text-amber-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="2.5" />
            <path d="M4 16h6M14 16h6M17 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" />
          </svg>
          <span>Drag a slider or pick an option to get started</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => count > 0 && setExpanded((v) => !v)}
          title={count > 0 ? 'View & edit your changes' : undefined}
          className="pointer-events-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/50 bg-amber-500/90 px-3 py-1.5 text-[12px] font-semibold text-white shadow-lg transition-colors hover:bg-amber-500"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {sentConfirm ? <span>{sentConfirm}</span> : <span>{count} change{count === 1 ? '' : 's'}</span>}
        </button>
      )}
    </div>
  );
}
