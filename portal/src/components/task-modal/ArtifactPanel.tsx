import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Info, Loader2, Maximize2, Minimize2, Send, X } from 'lucide-react';
import { useAppActions, useAppSelector } from '../../store/useAppSelector';
import { useDebouncedArtifactReload } from '../../hooks/useDebouncedArtifactReload';
import { triggerEscape, useEscapeKey } from '../../hooks/useEscapeKey';
import { AnnotationPill } from './AnnotationPill';
import { formatArtifactAnnotations, type ArtifactAnnotation } from '../../lib/planAnnotations';
import { ehEventSourceUrl, fetchDiffOverview, fetchDiffFileContent, commitDiffFileEdit, fetchDocs, fetchBranchDiff } from '../../api';
import { DocMarkdownPreview } from '../DocMarkdownPreview';
import type { Task, Doc } from '../../types';

/**
 * FLUX-873 (Tier 1): viewer for a ticket's rich grooming artifact, rendered in a **sandboxed iframe**
 * — `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so the agent-authored HTML runs in a unique
 * opaque origin and cannot reach the portal's cookies, DOM, or storage. The engine serves it with a
 * strict CSP (see engine `ARTIFACT_CSP`) over a relative same-origin URL (embeddable under the route's
 * `frame-ancestors 'self'` in both the Vite dev proxy and the prod single-origin).
 *
 * FLUX-874 / FLUX-875 (Tier 2/3): the artifact becomes annotatable + auditable. Pin-drop + note-capture
 * live **inside the iframe** (injected at serve time — see `ARTIFACT_ANNOTATOR_SCRIPT`): a floating
 * composer popover at the selection and numbered pins anchored to the content.
 *
 * FLUX-1362: the accumulated annotations are mirrored **live** out of the iframe into ONE host-side,
 * editable list — the floating "N changes" pill ({@link AnnotationPill}). The standalone artifact-only
 * view owns its own list (and a Send action); the plan-review panel lifts the list up (controlled via
 * `onArtifactAnnotationsChange`) and merges plan-text annotations into the same pill, so there's one
 * place to manage everything. A host-side edit/remove reverse-syncs to the matching in-iframe pin. The
 * host stays the trust boundary — it sanitizes on **every** ingest, not just on send.
 *
 * FLUX-1362: the open-time layout audit is now **non-blocking** — the artifact always renders; warnings
 * surface as a small header warning icon (hover to describe, click to copy the fix prompt) instead of a
 * full-cover mask the user must click past.
 *
 * Trust boundary: the iframe is opaque-origin, so its `postMessage` arrives with `event.origin ===
 * "null"`. We therefore do NOT trust the origin string — we validate `event.source` IS our iframe's
 * `contentWindow` plus a message-type allowlist (`ns === 'eh-artifact'`). The schema is intentionally
 * tiny (see the typed unions below).
 */

const NS = 'eh-artifact';

/** One annotation captured inside the iframe, mirrored live to the host. FLUX-1362: carries its
 * stable pin `id` so a host-side edit/remove round-trips to the matching `data-eh-pin`. */
interface AnnotationItem {
  id?: number;
  kind?: 'text' | 'element' | 'feel' | 'decision';
  selector: string;
  text: string;
  containerText?: string;
  label?: string;
  note?: string;
  /** FLUX-1440: a captured control value ('feel') or chosen option ('decision') from the artifact's
   *  guided controls. */
  value?: string;
}

/** FLUX-875 (Tier 3): one layout problem the open-time audit found inside the artifact. */
interface LayoutWarning {
  kind: 'overflow-x' | 'off-canvas' | 'clipped' | 'overlap' | string;
  selector: string;
  detail: string;
}

/** Messages the iframe sends up to the host (validated by `source` + this `ns`/`type` allowlist). */
type InboundMessage =
  | { ns: typeof NS; type: 'ready'; hasGuidedControls?: boolean }
  | { ns: typeof NS; type: 'annotations'; items: AnnotationItem[] }
  | { ns: typeof NS; type: 'layout-audit'; ok: boolean; warnings: LayoutWarning[] }
  | { ns: typeof NS; type: 'escape' }
  /** FLUX-1662 (Phase B): the doc-recap's injected per-section Edit button, clicked inside the
   *  sandboxed iframe. Opens the host-side inline editor drawer for this doc path — no agent. */
  | { ns: typeof NS; type: 'doc-edit-request'; path: string };

/** Messages the host sends down to the iframe. */
type OutboundMessage =
  | { ns: typeof NS; type: 'request-audit' }
  | { ns: typeof NS; type: 'remove-pin'; id: number }
  | { ns: typeof NS; type: 'update-pin'; id: number; note: string }
  /** FLUX-1667: the Docs panel's per-doc tab strip — shows exactly the section for `path` inside
   *  the doc-recap artifact (ARTIFACT_DOC_TABS_SCRIPT), hiding the rest. */
  | { ns: typeof NS; type: 'show-doc'; path: string }
  /** FLUX-1670: hides/shows the doc-recap's injected per-section Edit button — sent once the
   *  branch's live-worktree status is known, so the button never invites a click that can only
   *  ever land on the "unavailable" message `openDocEdit` already shows. */
  | { ns: typeof NS; type: 'set-doc-edit-availability'; available: boolean };

/** State of the open-time layout-audit for the currently-shown revision (advisory, non-blocking). */
type AuditState =
  | { status: 'pending' }
  | { status: 'clean' }
  | { status: 'warnings'; warnings: LayoutWarning[] }
  | { status: 'skipped' }; // audit never reported (errored / timed out).

// The iframe runs *agent-authored* JS in its opaque origin, so every `eh-artifact` message is HOSTILE
// input, not a trusted user action: a compromised / prompt-injected artifact can `postMessage` an
// arbitrary, unbounded `annotations` / `layout-audit` payload directly (the `e.source` check only
// proves it came from *this* iframe, not that a human selected anything). Since the host composes
// these into a chat message fed straight back to the grooming LLM, we clamp every string and array
// length host-side on EVERY ingest (FLUX-1362: now a live stream, not just a Send) — otherwise an
// attacker artifact could (a) inject unbounded, attacker-chosen instructions into the agent loop, or
// (b) blow up tokens/cost. The in-iframe caps are advisory only (that script is replaceable by the
// agent's own JS), so the bound MUST live here.
const MAX_ANNOTATIONS = 50;
const MAX_AUDIT_WARNINGS = 12; // matches the in-iframe MAX_WARNINGS
const MAX_NOTE = 600;

/** Coerce to a single-line string of at most `max` chars (strips newlines so a payload can't smuggle
 * extra markdown structure into the composed chat message). */
function clampLine(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Sanitize the untrusted iframe payload into the host-side {@link ArtifactAnnotation} shape. Items
 * missing a numeric `id` are dropped — the id is what lets a host edit/remove reverse-sync to a pin. */
function sanitizeAnnotations(items: AnnotationItem[], rev: number): ArtifactAnnotation[] {
  return items
    .slice(0, MAX_ANNOTATIONS)
    .filter((it) => typeof it?.id === 'number' && Number.isFinite(it.id))
    .map((it) => ({
      id: it.id as number,
      // Every kind is equally untrusted: coerce through an explicit allowlist, else fall back to
      // 'text'. FLUX-1440: widened to admit the guided-control kinds ('feel'/'decision') the same way.
      kind:
        it?.kind === 'element' || it?.kind === 'feel' || it?.kind === 'decision'
          ? it.kind
          : ('text' as const),
      selector: clampLine(it?.selector, 300),
      text: clampLine(it?.text, 280),
      label: clampLine(it?.label, 120),
      note: clampLine(it?.note, MAX_NOTE),
      // FLUX-1440: a guided-control capture ('feel'/'decision'); clamped the same as the other
      // single-line string fields above.
      value: clampLine(it?.value, 120),
      rev,
    }));
}

function sanitizeWarnings(warnings: LayoutWarning[]): LayoutWarning[] {
  return warnings.slice(0, MAX_AUDIT_WARNINGS).map((w) => ({
    kind: clampLine(w?.kind, 40),
    selector: clampLine(w?.selector, 200),
    detail: clampLine(w?.detail, MAX_NOTE),
  }));
}

/** FLUX-1136: how long a hidden panel keeps its iframe alive before it's actually torn down.
 *  Short hides (collapse-then-reopen, a quick alt-tab) are free — nothing reloads while hidden
 *  (see `useDebouncedArtifactReload`) and the DOM is left untouched, so in-iframe pins survive.
 *  Only a hide that outlasts this grace period drops the iframe to reclaim the compiled Tailwind/JS. */
const HIDDEN_UNMOUNT_GRACE_MS = 60_000;

export function ArtifactPanel({
  task,
  onSendToChat,
  visible,
  fillHeight = false,
  artifactAnnotations,
  onArtifactAnnotationsChange,
  onHasGuidedControlsChange,
  collapsed = false,
  headerStart,
  headerEnd,
  channel = 'plan',
}: {
  task: Task;
  onSendToChat?: (text: string) => void;
  /** FLUX-1136: whether this panel is actually on-screen (its section isn't collapsed etc.) —
   *  threaded down by the caller. Combined here with the app's own window-visibility signal, so
   *  an agent iterating while the browser tab is backgrounded doesn't pay the compile cost either. */
  visible: boolean;
  /** FLUX-1362: in the full-screen plan surface the iframe fills the available height instead of the
   *  fixed `h-[58vh]` the lean sideview keeps. */
  fillHeight?: boolean;
  /** FLUX-1362: CONTROLLED mode — the plan-review panel owns the unified annotation list and folds
   *  the artifact items into its own floating pill. When provided, this panel does NOT render its own
   *  pill; it only bridges the iframe (ingest + reverse-sync). Omit both for the standalone artifact-
   *  only view, which owns its own list + Send. */
  artifactAnnotations?: ArtifactAnnotation[];
  onArtifactAnnotationsChange?: (items: ArtifactAnnotation[]) => void;
  /** FLUX-1440: fires whenever the in-iframe annotator reports (via `type:'ready'`) whether this
   *  artifact revision exposes guided controls (sliders/pickers wired to emit 'feel'/'decision'
   *  annotations). Only needed in CONTROLLED mode, where the caller renders its own pill and needs the
   *  signal to drive that pill's empty state; the standalone view reads its own local state instead. */
  onHasGuidedControlsChange?: (value: boolean) => void;
  /** FLUX-1474: true when the CALLER's own section chrome is collapsed. Renders only the compact
   *  header row (`headerStart` + `headerEnd`, no title/rev/warnings/rev-picker/fullscreen) and keeps
   *  the iframe body hidden via `display:none` (still mounted, per FLUX-1136) rather than unmounted —
   *  distinct from `visible`, which governs iframe reload/compile throttling, not layout. */
  collapsed?: boolean;
  /** FLUX-1474: rendered first in the single header row — the sideview's collapse-toggle + identity
   *  label ("Artifact" / "Visual Recap"), so that toggle and the artifact's own controls share ONE
   *  strip instead of stacking two. Omitted by the plan-review panel, which has no collapse state. */
  headerStart?: ReactNode;
  /** FLUX-1474: appended to the header's action cluster, before the fullscreen toggle — the
   *  sideview's "View Plan" entry point. */
  headerEnd?: ReactNode;
  /** FLUX-1667: which typed artifact channel to bind to — `'plan'` (default, `task.artifacts`) or
   *  `'doc-recap'` (`task.docRecap`, the Docs tab). Drives the revision source, the served URL's
   *  `?channel=`, and (only for `'doc-recap'`) the per-doc tab strip. */
  channel?: 'plan' | 'doc-recap';
}) {
  const { subscribeToEvent } = useAppActions();
  const isWindowVisible = useAppSelector((s) => s.isWindowVisible);
  const effectiveVisible = visible && isWindowVisible;

  // FLUX-1667: the doc-recap channel lives at task.docRecap, independent of the plan channel's
  // task.artifacts — same pointer shape, so everything below (rev state, picker, reload wiring)
  // is unchanged regardless of which one this instance is bound to.
  const pointer = channel === 'doc-recap' ? task.docRecap : task.artifacts;
  const revisions = pointer?.revisions ?? [];
  const latest = pointer?.latest ?? (revisions.length > 0 ? revisions[revisions.length - 1]!.rev : 0);

  const [rev, setRev] = useState<number>(latest);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [iframeMounted, setIframeMounted] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // FLUX-875 → FLUX-1362: the audit is advisory + non-blocking. We keep its state only to drive the
  // small header warning icon; the artifact always renders.
  const [audit, setAudit] = useState<AuditState>({ status: 'pending' });

  // Full-screen mode (the pin/composer UI lives in the iframe, so it works unchanged at any size).
  const [fullscreen, setFullscreen] = useState(false);
  // Transient "sent N annotations" confirmation after the standalone view's Send.
  const [sentCount, setSentCount] = useState(0);
  // FLUX-1440: whether the currently-shown revision's annotator reports guided controls (sliders /
  // pickers). Reported once per iframe mount via `type:'ready'`; false until that arrives.
  const [hasGuidedControls, setHasGuidedControls] = useState(false);
  // FLUX-1667: the Docs panel's per-doc tab strip — which of the SELECTED revision's `docPaths`
  // is currently shown inside the iframe. `undefined` defers to the iframe's own default (the
  // first section present, via ARTIFACT_DOC_TABS_SCRIPT) rather than duplicating that default
  // here. Reset on every revision switch below (the fresh iframe reverts to its own default too).
  const [activeDocPath, setActiveDocPath] = useState<string | undefined>(undefined);

  // FLUX-1670: whether the doc-recap's injected per-section Edit button should show itself —
  // mirrors `openDocEdit`'s own live-worktree gate, one step earlier (before the user ever
  // clicks). Defaults to `true` (available) until the fetch resolves, so the common case (a live
  // worktree) never flashes hidden→shown; only a positively-confirmed missing worktree hides it.
  // Only meaningful for the doc-recap channel — the plan/Visual-Recap artifact never renders this
  // button, so there's nothing to fetch/post for that channel.
  const [docEditAvailable, setDocEditAvailable] = useState(true);
  useEffect(() => {
    if (channel !== 'doc-recap' || !task.branch) { setDocEditAvailable(true); return undefined; }
    let cancelled = false;
    fetchBranchDiff(task.id)
      .then((summary) => {
        if (!cancelled) setDocEditAvailable(summary.worktree !== null);
      })
      .catch(() => {
        // Best-effort — keep the default (available) so a transient fetch failure doesn't hide a
        // button that may well work; `openDocEdit`'s own check remains the source of truth.
      });
    return () => { cancelled = true; };
  }, [channel, task.id, task.branch]);

  // FLUX-1662 (Phase B): the doc-recap's self-serve inline editor drawer, opened by a
  // `doc-edit-request` from the injected per-section Edit button. `availability` mirrors the
  // Changes screen's `source.kind === 'live'` gate (constraint 3): editing is only wired to a
  // branch with an active worktree, so a raced/removed worktree degrades to read-only rather than
  // letting the commit 409 be the user's first signal.
  const [docEdit, setDocEdit] = useState<{
    path: string;
    availability: 'checking' | 'available' | 'unavailable';
    unavailableReason?: string;
    draft: string;
    commitMessage: string;
    committing: boolean;
    commitError: string | null;
  } | null>(null);
  const [docsForPreview, setDocsForPreview] = useState<Doc[]>([]);

  useEffect(() => {
    fetchDocs().then(setDocsForPreview).catch(() => {});
  }, []);

  const openDocEdit = useCallback((path: string) => {
    setDocEdit({ path, availability: 'checking', draft: '', commitMessage: '', committing: false, commitError: null });
    const branch = task.branch;
    if (!branch) {
      setDocEdit((prev) => (prev && prev.path === path
        ? { ...prev, availability: 'unavailable', unavailableReason: 'This ticket has no branch to edit.' }
        : prev));
      return;
    }
    Promise.all([fetchDiffOverview().catch(() => null), fetchDiffFileContent(branch, path)])
      .then(([overview, pair]) => {
        const live = !!overview?.groups.some((g) => g.kind === 'worktree' && g.branch === branch);
        setDocEdit((prev) => (prev && prev.path === path
          ? {
              ...prev,
              availability: live ? 'available' : 'unavailable',
              unavailableReason: live
                ? undefined
                : 'This branch has no active worktree — self-serve edits are unavailable. Annotate above to have an agent make the edit instead.',
              draft: pair.after,
            }
          : prev));
      })
      .catch((err) => {
        setDocEdit((prev) => (prev && prev.path === path
          ? { ...prev, availability: 'unavailable', unavailableReason: err instanceof Error ? err.message : 'Failed to load doc content.' }
          : prev));
      });
  }, [task.branch]);
  const openDocEditRef = useRef(openDocEdit);
  useEffect(() => { openDocEditRef.current = openDocEdit; }, [openDocEdit]);

  const submitDocEdit = useCallback(async () => {
    if (!docEdit || docEdit.availability !== 'available' || !task.branch || !docEdit.commitMessage.trim()) return;
    setDocEdit((prev) => (prev ? { ...prev, committing: true, commitError: null } : prev));
    try {
      // The 409 guards (main ref / no worktree / active session) surface here VERBATIM on a race —
      // the availability check above is a best-effort UI gate, not the source of truth (plan step 9).
      await commitDiffFileEdit(task.branch, docEdit.path, docEdit.draft, docEdit.commitMessage.trim());
      // Re-emit happens engine-side (POST /diffs/file/commit); the existing artifactReady subscription
      // above reloads the iframe to the new revision — no manual refetch needed here.
      setDocEdit(null);
    } catch (err) {
      setDocEdit((prev) => (prev ? { ...prev, committing: false, commitError: err instanceof Error ? err.message : 'Failed to commit the edit' } : prev));
    }
  }, [docEdit, task.branch]);

  // FLUX-1362: the unified artifact-annotation list. CONTROLLED by the plan panel when
  // `onArtifactAnnotationsChange` is given; otherwise owned here (standalone artifact-only view).
  const controlled = !!onArtifactAnnotationsChange;
  const [ownItems, setOwnItems] = useState<ArtifactAnnotation[]>([]);
  // Stable identity so the reverse-sync effect doesn't refire every render (a `?? []` would be new
  // each time). Controlled → the parent's array; standalone → our own state.
  const items = useMemo(
    () => (controlled ? artifactAnnotations ?? [] : ownItems),
    [controlled, artifactAnnotations, ownItems],
  );
  const applyItems = useCallback(
    (next: ArtifactAnnotation[]) => {
      if (onArtifactAnnotationsChange) onArtifactAnnotationsChange(next);
      else setOwnItems(next);
    },
    [onArtifactAnnotationsChange],
  );
  // What the iframe currently holds (id → note), set on ingest — the reverse-sync effect diffs the
  // host-authoritative `items` against this to post exactly the remove/update the user made host-side.
  const iframeLiveRef = useRef<Map<number, string>>(new Map());

  const revRef = useRef(rev);
  useEffect(() => { revRef.current = rev; }, [rev]);

  const applyReload = useCallback((pendingRev: number | undefined) => {
    if (typeof pendingRev === 'number') setRev(pendingRev);
    setReloadNonce((n) => n + 1);
  }, []);
  const notifyArtifactReady = useDebouncedArtifactReload(effectiveVisible, applyReload);

  const prevLatestRef = useRef(latest);
  useEffect(() => {
    if (prevLatestRef.current === latest) return;
    prevLatestRef.current = latest;
    notifyArtifactReady(latest);
  }, [latest, notifyArtifactReady]);

  useEffect(() => {
    const off = subscribeToEvent('artifactReady', (data) => {
      const payload = data as { ticketId?: string; rev?: number; channel?: 'plan' | 'doc-recap' };
      if (payload?.ticketId !== task.id) return;
      // FLUX-1667: both channels share one ascending rev counter, so an unfiltered reload here
      // would swing THIS panel's `rev` state to the OTHER channel's newly-published revision
      // number — a revision its own pointer doesn't contain. Every emitter now stamps `channel`
      // (defaulting 'plan' for a pre-FLUX-1667 payload that somehow omits it).
      if ((payload.channel ?? 'plan') !== channel) return;
      notifyArtifactReady(payload.rev);
    });
    return off;
  }, [subscribeToEvent, task.id, notifyArtifactReady, channel]);

  useEffect(() => {
    if (effectiveVisible) {
      setIframeMounted(true);
      return;
    }
    const t = window.setTimeout(() => setIframeMounted(false), HIDDEN_UNMOUNT_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [effectiveVisible]);

  const postToIframe = useCallback((msg: OutboundMessage) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // FLUX-1670: tracks whether the CURRENT iframe has announced `'ready'` — posting
  // `set-doc-edit-availability` before that would land on a not-yet-mounted document. Reset to
  // `false` on every iframe remount (the revision-switch effect below), same lifecycle as the
  // other per-mount iframe state (`hasGuidedControls`, `activeDocPath`).
  const iframeReadyRef = useRef(false);
  const docEditAvailableRef = useRef(docEditAvailable);
  useEffect(() => { docEditAvailableRef.current = docEditAvailable; }, [docEditAvailable]);
  // Posts on every `docEditAvailable` change once the iframe is ready (guarded by the ref so an
  // early change — before 'ready' — doesn't post into a not-yet-mounted document; the 'ready'
  // handler below posts the then-current value itself).
  useEffect(() => {
    if (channel !== 'doc-recap' || !iframeReadyRef.current) return;
    postToIframe({ ns: NS, type: 'set-doc-edit-availability', available: docEditAvailable });
  }, [channel, docEditAvailable, postToIframe]);

  // FLUX-1362: ingest the iframe's LIVE annotation mirror. Sanitize (trust boundary), stamp the
  // current rev, record what the iframe now holds, and push into the (own or lifted) list.
  const applyItemsRef = useRef(applyItems);
  useEffect(() => { applyItemsRef.current = applyItems; }, [applyItems]);
  const ingestAnnotations = useCallback((rawItems: AnnotationItem[]) => {
    const next = sanitizeAnnotations(Array.isArray(rawItems) ? rawItems : [], revRef.current);
    iframeLiveRef.current = new Map(next.map((a) => [a.id, a.note]));
    applyItemsRef.current(next);
  }, []);
  // FLUX-1440: read live in the stable (no-deps) message-listener effect below, same pattern as
  // `applyItemsRef`.
  const onHasGuidedControlsChangeRef = useRef(onHasGuidedControlsChange);
  useEffect(() => { onHasGuidedControlsChangeRef.current = onHasGuidedControlsChange; }, [onHasGuidedControlsChange]);
  // FLUX-1670: `channel` is a prop read inside the same stable (no-deps) message-listener effect —
  // mirror it into a ref so the closure sees the current value rather than the one from first mount.
  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);

  // Host-side message listener — the trust boundary. Validate `source` (our iframe) over the opaque
  // origin string, then the `ns`/`type` allowlist. Stable (no deps) — reads live values via refs.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const d = e.data as InboundMessage | null;
      if (!d || typeof d !== 'object' || d.ns !== NS) return;
      if (d.type === 'annotations') {
        if (Array.isArray(d.items)) ingestAnnotations(d.items);
      } else if (d.type === 'ready') {
        // FLUX-1440: reported once per iframe mount by the injected annotator script. Threaded to
        // both local state (standalone view's own pill) and the controlled-mode callback (the plan
        // panel renders its own pill and needs the signal too).
        const value = !!d.hasGuidedControls;
        setHasGuidedControls(value);
        onHasGuidedControlsChangeRef.current?.(value);
        // FLUX-1670: the iframe is now mounted and listening — flip the ready flag and post the
        // CURRENT availability immediately (the effect above only fires on a later *change*, so
        // this is what delivers the initial value to a fresh iframe).
        iframeReadyRef.current = true;
        if (channelRef.current === 'doc-recap') {
          postToIframe({ ns: NS, type: 'set-doc-edit-availability', available: docEditAvailableRef.current });
        }
      } else if (d.type === 'layout-audit') {
        // Advisory only now — never masks. A late clean re-audit still upgrades the icon away.
        const warnings = sanitizeWarnings(Array.isArray(d.warnings) ? d.warnings : []);
        setAudit((prev) =>
          prev.status === 'skipped'
            ? prev
            : d.ok || warnings.length === 0
              ? { status: 'clean' }
              : { status: 'warnings', warnings },
        );
      } else if (d.type === 'escape') {
        triggerEscape();
      } else if (d.type === 'doc-edit-request') {
        if (typeof d.path === 'string' && d.path) openDocEditRef.current(d.path);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [ingestAnnotations, postToIframe]);

  // FLUX-1362: reverse-sync host-side edits/removals to the in-iframe pins. Diff what the iframe holds
  // (`iframeLiveRef`) against the host-authoritative `items`: an id the iframe still has but the host
  // dropped → `remove-pin`; a note the host changed → `update-pin`. Ingest sets `iframeLiveRef` to
  // match `items` first, so an iframe-originated change never re-posts (no feedback loop).
  useEffect(() => {
    const live = iframeLiveRef.current;
    const cur = new Map(items.map((a) => [a.id, a.note]));
    for (const [id, note] of Array.from(live.entries())) {
      if (!cur.has(id)) {
        postToIframe({ ns: NS, type: 'remove-pin', id });
        live.delete(id);
      } else if (cur.get(id) !== note) {
        const newNote = cur.get(id)!;
        postToIframe({ ns: NS, type: 'update-pin', id, note: newNote });
        live.set(id, newNote);
      }
    }
  }, [items, postToIframe]);

  // The displayed src. Changing it remounts the iframe (key={src}); re-arm the audit + clear stale
  // annotation state (the fresh iframe starts with no pins). FLUX-1136: also re-arm on `iframeMounted`
  // flipping back true — a grace-period teardown recreates the iframe from scratch.
  // Board-scoped via `?ws=` (ehEventSourceUrl) — an iframe navigation can't carry the
  // X-EH-Workspace header, so without the param the engine would serve the artifact from
  // whichever board was most recently opened (epic FLUX-1230 S10 switcher), 404-ing this one.
  const src = ehEventSourceUrl(
    `/tasks/${encodeURIComponent(task.id)}/artifact?rev=${rev}&_n=${reloadNonce}${channel === 'doc-recap' ? '&channel=doc-recap' : ''}`,
  );
  useEffect(() => {
    if (!iframeMounted) return;
    setAudit({ status: 'pending' });
    setSentCount(0);
    // FLUX-1440: a fresh iframe hasn't announced 'ready' yet — don't carry the previous revision's
    // guided-controls signal over.
    setHasGuidedControls(false);
    onHasGuidedControlsChangeRef.current?.(false);
    // FLUX-1670: same reasoning — the fresh iframe hasn't announced 'ready' yet, so hold off
    // posting `set-doc-edit-availability` until it does (the 'ready' handler posts the current
    // value itself once it fires).
    iframeReadyRef.current = false;
    // The fresh iframe holds no pins; drop any stale host list + live map so counts start clean.
    iframeLiveRef.current = new Map();
    applyItemsRef.current([]);
    // FLUX-1662: a revision switch (incl. the re-emit after this drawer's own commit) invalidates
    // any open doc-edit drawer — its `before` snapshot no longer matches what's on screen.
    setDocEdit(null);
    // FLUX-1667: the fresh iframe defaults to its own first-section behavior; forget which tab was
    // active on the PREVIOUS revision rather than carrying a path the new revision's docPaths may
    // not even contain (FLUX-1667's guard against a `show-doc` targeting an absent section).
    setActiveDocPath(undefined);
    const t = window.setTimeout(() => {
      setAudit((a) => (a.status === 'pending' ? { status: 'skipped' } : a));
    }, 4000);
    return () => window.clearTimeout(t);
  }, [src, iframeMounted]);

  useEffect(() => {
    if (!sentCount) return;
    const t = window.setTimeout(() => setSentCount(0), 4000);
    return () => window.clearTimeout(t);
  }, [sentCount]);

  // Entering/leaving full screen resizes the iframe; the audit width changes with it, so re-run it.
  const firstFsRun = useRef(true);
  useEffect(() => {
    if (firstFsRun.current) { firstFsRun.current = false; return; }
    const t = window.setTimeout(() => postToIframe({ ns: NS, type: 'request-audit' }), 150);
    return () => window.clearTimeout(t);
  }, [fullscreen, postToIframe]);

  // FLUX-1022: Esc exits full screen — routed through the shared Escape stack.
  useEscapeKey(() => setFullscreen(false), { enabled: fullscreen });

  // Warning-icon popover (hover to describe, click to copy the fix prompt). FLUX-1362.
  const [warnOpen, setWarnOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [auditSent, setAuditSent] = useState(false);
  useEffect(() => { setAuditSent(false); setCopied(false); }, [rev, src]);

  if (revisions.length === 0 || !latest) {
    return <p className="px-1 py-2 text-[12px] text-[var(--eh-text-muted)]">No artifact published yet.</p>;
  }

  const current = revisions.find((r) => r.rev === rev) ?? revisions[revisions.length - 1];
  const idx = revisions.findIndex((r) => r.rev === rev);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < revisions.length - 1;
  const stepTo = (i: number) => {
    const target = revisions[i];
    if (target) setRev(target.rev);
  };

  // FLUX-1667: the per-doc tab strip reads the CURRENTLY-SELECTED revision's `docPaths` — never
  // `revisions[latest]` — so switching to an older rev via the picker above can't leave a
  // `show-doc` targeting a path this revision's HTML never rendered a section for (FLUX-1662's
  // self-edit re-emit creates new recap revisions routinely, so an older one is a normal, reachable
  // state, not an edge case). `undefined` when no explicit tab has been picked defers to the
  // iframe's own default (first section) instead of duplicating that default host-side.
  const docPaths = channel === 'doc-recap' ? current?.docPaths ?? [] : [];
  const effectiveActiveDocPath = activeDocPath && docPaths.includes(activeDocPath) ? activeDocPath : docPaths[0];
  const selectDoc = (path: string) => {
    setActiveDocPath(path);
    postToIframe({ ns: NS, type: 'show-doc', path });
  };

  // The fix-instruction message for a failed layout audit (reused by copy-to-clipboard + send-to-agent).
  const buildAuditMessage = (): string | null => {
    if (audit.status !== 'warnings') return null;
    const lines = audit.warnings.map((w) => `- **${w.kind}** \`${w.selector}\` — ${w.detail}`).join('\n');
    return (
      `🧪 **Layout audit** · rev ${rev}\n\n` +
      `The published artifact has ${audit.warnings.length} layout problem${audit.warnings.length === 1 ? '' : 's'} ` +
      `(overflow / clipping / overlap):\n\n` +
      `${lines}\n\n` +
      `Please fix the layout and call \`publish_artifact\` to publish a corrected revision.`
    );
  };

  const copyAuditFix = () => {
    const message = buildAuditMessage();
    if (!message) return;
    // Advisory action — degrade gracefully if the clipboard is unavailable (Send-to-agent still works).
    navigator.clipboard?.writeText(message).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const sendAuditWarnings = () => {
    const message = buildAuditMessage();
    if (!message || !onSendToChat) return;
    onSendToChat(message);
    setAuditSent(true);
  };

  const iframeSizeClass = fillHeight || fullscreen ? 'h-full' : 'h-[58vh]';

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-[120] flex flex-col gap-2 bg-[var(--eh-surface)] p-4'
          : fillHeight
            ? 'flex min-h-0 flex-1 flex-col gap-2'
            : 'flex flex-col gap-2'
      }
    >
      {/* FLUX-1474: ONE header row — the caller's collapse-toggle/identity (`headerStart`) and
          "View Plan" (`headerEnd`) are composed in alongside this panel's own title/rev caption,
          layout-warning pill, revision picker, and full-screen toggle, so a section wrapper never
          has to stack a second header strip beneath this one. `collapsed` (distinct from `visible`,
          which only throttles iframe reload) hides everything but the two caller slots. */}
      <div className="flex items-center gap-2 text-[11px] text-[var(--eh-text-muted)]">
        {headerStart}
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate">
            {current?.title || 'Artifact'} · rev {rev}{rev === latest ? ' (latest)' : ''}
            {/* FLUX-1475: the revision caption folds into this one-line truncating header span
                instead of a permanent paragraph below the iframe — same "no dedicated real estate"
                treatment FLUX-1474 already gave the rest of this row. */}
            {current?.note ? ` — ${current.note}` : ''}
            {sentCount > 0 && (
              <span role="status" aria-live="polite" className="ml-2 text-emerald-500">
                ✓ Sent {sentCount} annotation{sentCount === 1 ? '' : 's'} to agent
              </span>
            )}
          </span>
        )}
        <div className="ml-auto flex flex-shrink-0 items-center gap-1">
          {/* FLUX-1362: non-blocking layout-audit indicator. Hover describes the warnings; click copies
              the fix prompt to the clipboard. The artifact itself renders regardless. FLUX-1474:
              labeled ("N warnings") so the highest-signal element in the header reads at a glance
              instead of requiring a hover to decode a bare count. */}
          {!collapsed && audit.status === 'warnings' && (
            <div
              className="relative"
              onMouseEnter={() => setWarnOpen(true)}
              onMouseLeave={() => setWarnOpen(false)}
            >
              <button
                type="button"
                onClick={copyAuditFix}
                title="Layout warnings — click to copy the fix prompt"
                className="flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="text-[10px] font-semibold">
                  {audit.warnings.length} warning{audit.warnings.length === 1 ? '' : 's'}
                </span>
              </button>
              {warnOpen && (
                <div className="eh-surface eh-border absolute right-0 top-full z-[130] mt-1 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border p-2.5 text-left shadow-2xl">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-500">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {audit.warnings.length} layout warning{audit.warnings.length === 1 ? '' : 's'}
                  </div>
                  <ul className="flex flex-col gap-1 text-[11px] text-[var(--eh-text-secondary)]">
                    {audit.warnings.map((w, i) => (
                      <li key={i} className="eh-border rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1">
                        <span className="font-medium text-amber-600">{w.kind}</span>{' '}
                        <code className="text-[10px] text-[var(--eh-text-muted)]">{w.selector}</code>
                        <div className="text-[var(--eh-text-secondary)]">{w.detail}</div>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center justify-end gap-2">
                    <span className="mr-auto text-[10px] text-emerald-500">{copied ? '✓ Copied fix prompt' : ''}</span>
                    <button
                      type="button"
                      onClick={copyAuditFix}
                      className="rounded px-2 py-0.5 text-[11px] text-[var(--eh-text-muted)] hover:text-[var(--eh-text-secondary)]"
                    >
                      Copy fix
                    </button>
                    <button
                      type="button"
                      onClick={sendAuditWarnings}
                      disabled={!onSendToChat || auditSent}
                      title={onSendToChat ? 'Send the layout warnings to the grooming agent' : 'Chat unavailable'}
                      className="inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-40"
                    >
                      <Send className="h-3 w-3" /> {auditSent ? 'Sent' : 'Send to agent'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {!collapsed && revisions.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => canPrev && stepTo(idx - 1)}
                disabled={!canPrev}
                title="Previous revision"
                className="rounded p-0.5 enabled:hover:text-[var(--eh-text-secondary)] disabled:opacity-30"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <select
                value={rev}
                onChange={(e) => {
                  const i = revisions.findIndex((r) => r.rev === Number(e.target.value));
                  if (i >= 0) stepTo(i);
                }}
                className="eh-border max-w-[8rem] rounded border bg-[var(--eh-input-bg)] px-1 py-0.5 text-[11px] text-[var(--eh-text-secondary)]"
              >
                {revisions.map((r) => (
                  <option key={r.rev} value={r.rev}>
                    rev {r.rev}{r.rev === latest ? ' (latest)' : ''}{r.title ? ` — ${r.title}` : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => canNext && stepTo(idx + 1)}
                disabled={!canNext}
                title="Next revision"
                className="rounded p-0.5 enabled:hover:text-[var(--eh-text-secondary)] disabled:opacity-30"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {headerEnd}
          {/* FLUX-1475: the permanent "Tip: select text…" paragraph used to sit between the artifact
              and the composer on every render — now an info-glyph with the same text as a native
              tooltip, so it costs no vertical space until someone actually wants it. */}
          {!collapsed && (
            <button
              type="button"
              title={`Select text — or right-click any element (toggle, button, chart bar) — in the artifact to annotate it. Your changes collect in the "${items.length} change${items.length === 1 ? '' : 's'}" pill; click a pin to edit its note.`}
              className="rounded p-0.5 text-[var(--eh-text-muted)] hover:text-[var(--eh-text-secondary)]"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          )}
          {!collapsed && (
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              title={fullscreen ? 'Exit full screen (Esc)' : 'Open full screen'}
              className="rounded p-0.5 hover:text-[var(--eh-text-secondary)]"
            >
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* FLUX-1667: one sub-tab per doc rendered inline in this recap revision — built from the
          SELECTED revision's `docPaths` (see the derivation above), so it always matches what the
          iframe can actually show. Hidden entirely for a single-doc recap (nothing to switch between)
          and for the plan channel (docPaths is always [] there). */}
      {!collapsed && docPaths.length > 1 && (
        <div className="eh-border flex flex-shrink-0 flex-wrap gap-1 border-b pb-2 text-[11px]">
          {docPaths.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => selectDoc(path)}
              title={path}
              className={`max-w-[14rem] truncate rounded-full px-2 py-0.5 font-mono transition-colors ${
                path === effectiveActiveDocPath
                  ? 'bg-primary text-white'
                  : 'bg-[var(--eh-input-bg)] text-[var(--eh-text-muted)] hover:text-[var(--eh-text-secondary)]'
              }`}
            >
              {path.split('/').pop()}
            </button>
          ))}
        </div>
      )}

      {/* FLUX-1474: the body (iframe + note/tip + pill) — hidden via `display:none` rather than
          unmounted when the caller's section is collapsed, preserving FLUX-1136's "stay mounted"
          contract (an instant unmount would eat an in-progress annotation batch living inside the
          iframe). FLUX-1474: also the pane's SOLE vertical scroller — `fillHeight` callers bound this
          block's height via their own flex/height context (FLUX-1515: `TicketSideView`'s Plan tab),
          so the iframe's own internal scrollbar is the only one that can appear within it; the host
          never grows a second, competing scrollbar around it. */}
      <div
        style={collapsed ? { display: 'none' } : undefined}
        className={fullscreen || fillHeight ? 'flex min-h-0 flex-1 flex-col gap-2' : 'flex flex-col gap-2'}
      >
        {/* The iframe (with its in-document pin/composer UI). FLUX-1362: no mask — the artifact renders
            immediately; a brief non-blocking spinner in the corner shows while the layout audit runs. */}
        <div className={fullscreen || fillHeight ? 'relative min-h-0 flex-1' : 'relative'}>
          {iframeMounted ? (
            <iframe
              key={src}
              ref={iframeRef}
              title={`Artifact for ${task.id}`}
              src={src}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className={`eh-border w-full rounded-lg border bg-white ${iframeSizeClass}`}
            />
          ) : (
            <div className={`eh-border w-full rounded-lg border bg-white ${iframeSizeClass}`} />
          )}

          {iframeMounted && audit.status === 'pending' && (
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-1 text-[10px] font-medium text-white"
            >
              <Loader2 className="h-3 w-3 animate-spin" /> Checking layout…
            </div>
          )}

          {/* FLUX-1662 (Phase B): the doc-recap's self-serve inline editor drawer — opened by the
              in-iframe Edit button (`doc-edit-request`), never an agent. Overlays the iframe rather
              than replacing it so closing/committing just drops back to the (possibly now stale,
              soon re-emitted) recap underneath. */}
          {docEdit && (
            <div className="eh-border absolute inset-0 z-[110] flex flex-col gap-2 rounded-lg border bg-white p-3 dark:bg-[var(--eh-surface)]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-700 dark:text-gray-200" title={docEdit.path}>
                  {docEdit.path}
                </span>
                <button
                  type="button"
                  onClick={() => setDocEdit(null)}
                  disabled={docEdit.committing}
                  title="Close"
                  className="rounded p-1 text-gray-400 hover:text-gray-600 disabled:opacity-50 dark:hover:text-gray-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {docEdit.availability === 'checking' && (
                <p className="text-xs text-[var(--eh-text-muted)]">Checking edit availability…</p>
              )}
              {docEdit.availability === 'unavailable' && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {docEdit.unavailableReason || 'Self-serve edit is unavailable for this branch.'}
                </p>
              )}
              {docEdit.availability !== 'checking' && (
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                  <div className="grid min-h-[12rem] flex-1 gap-2 md:grid-cols-2">
                    <textarea
                      value={docEdit.draft}
                      onChange={(e) => setDocEdit((prev) => (prev ? { ...prev, draft: e.target.value } : prev))}
                      disabled={docEdit.availability !== 'available' || docEdit.committing}
                      className="min-h-[12rem] w-full resize-none rounded-xl border border-gray-200 bg-white p-2.5 font-mono text-xs text-gray-800 outline-none focus:border-primary disabled:opacity-60 dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
                      spellCheck={false}
                    />
                    <div className="min-h-[12rem] overflow-auto rounded-xl border border-gray-200 bg-white p-2.5 dark:border-white/10 dark:bg-black/20">
                      <DocMarkdownPreview markdown={docEdit.draft} docs={docsForPreview} />
                    </div>
                  </div>
                  {docEdit.commitError && <p className="text-xs text-red-500">{docEdit.commitError}</p>}
                  <div className="flex items-center gap-2">
                    <input
                      value={docEdit.commitMessage}
                      onChange={(e) => setDocEdit((prev) => (prev ? { ...prev, commitMessage: e.target.value } : prev))}
                      placeholder="Commit message…"
                      disabled={docEdit.availability !== 'available' || docEdit.committing}
                      className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-800 outline-none focus:border-primary disabled:opacity-60 dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
                    />
                    <button
                      type="button"
                      onClick={() => void submitDocEdit()}
                      disabled={docEdit.availability !== 'available' || docEdit.committing || !docEdit.commitMessage.trim()}
                      className="flex-none rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                    >
                      {docEdit.committing ? 'Committing…' : 'Commit to branch & push'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDocEdit(null)}
                      disabled={docEdit.committing}
                      className="flex-none rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* FLUX-1362: the floating unified list. Standalone (artifact-only) view owns + renders it
              with a Send action; in controlled mode the plan-review panel renders the pill (with
              plan-text items merged in), so this panel only bridges the iframe. Lives INSIDE this
              `relative` iframe wrapper so it floats at the artifact's own bottom-right — not (as the
              old body-portaled fixed pill did) at the viewport corner over unrelated UI, and not
              visible while a stay-mounted owner has this panel `display:none` hidden. */}
          {!controlled && (
            <AnnotationPill
              artifactItems={items}
              onEditArtifact={(id, note) => applyItems(items.map((a) => (a.id === id ? { ...a, note } : a)))}
              onRemoveArtifact={(id) => applyItems(items.filter((a) => a.id !== id))}
              onSend={onSendToChat ? () => {
                // FLUX-1667: name the channel + active doc so a Docs-panel annotation batch reads
                // distinctly from a Plan-channel one instead of an identical `🎯` message. Omitted
                // for the plan channel — that call site's message stays byte-for-byte unchanged.
                const message = formatArtifactAnnotations(
                  items,
                  channel === 'doc-recap' ? { channelLabel: 'Docs', docPath: effectiveActiveDocPath } : undefined,
                );
                if (message) { onSendToChat(message); setSentCount(items.length); applyItems([]); }
              } : undefined}
              sendDisabled={items.length === 0}
              sentConfirm={sentCount > 0 ? `✓ Sent ${sentCount}` : undefined}
              hasGuidedControls={hasGuidedControls}
            />
          )}
        </div>
      </div>
    </div>
  );
}
