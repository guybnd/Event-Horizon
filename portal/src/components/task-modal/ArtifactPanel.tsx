import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Eye, Loader2, Maximize2, Minimize2, Send } from 'lucide-react';
import { useAppActions, useAppSelector } from '../../store/useAppSelector';
import { useDebouncedArtifactReload } from '../../hooks/useDebouncedArtifactReload';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { Task } from '../../types';

/**
 * FLUX-873 (Tier 1): viewer for a ticket's rich grooming artifact, rendered in a **sandboxed iframe**
 * — `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so the agent-authored HTML runs in a unique
 * opaque origin and cannot reach the portal's cookies, DOM, or storage. The engine serves it with a
 * strict CSP (see engine `ARTIFACT_CSP`) over a relative same-origin URL (embeddable under the route's
 * `frame-ancestors 'self'` in both the Vite dev proxy and the prod single-origin).
 *
 * FLUX-874 / FLUX-875 (Tier 2/3): the artifact becomes annotatable + auditable. The entire annotation
 * UI now lives **inside the iframe** (injected at serve time — see `ARTIFACT_ANNOTATOR_SCRIPT`): a
 * floating composer popover at the selection, numbered pins anchored to the content, and a
 * scroll-following tray that **collects multiple annotations** before sending. Keeping it in-iframe is
 * what makes the tray/pins follow scroll over an opaque-origin iframe (host overlays can't track the
 * iframe's internal scroll without constant message spam). The host's only annotation job is to
 * receive the final **batch** on "Send" and round-trip it into the ticket chat (`onSendToChat`) as a
 * single message — so the user can annotate several regions, then send once, instead of kicking off a
 * chat per selection.
 *
 * The host owns: the **revision picker**, the **layout-audit gate** (mask until clean), and
 * **full-screen** mode.
 *
 * Trust boundary: the iframe is opaque-origin, so its `postMessage` arrives with `event.origin ===
 * "null"`. We therefore do NOT trust the origin string — we validate `event.source` IS our iframe's
 * `contentWindow` plus a message-type allowlist (`ns === 'eh-artifact'`). The schema is intentionally
 * tiny (see the typed unions below).
 */

const NS = 'eh-artifact';

/** One annotation captured inside the iframe (sent up only as part of a batch on "Send").
 * FLUX-892: `kind` discriminates a text-selection anchor (`'text'`, the default for back-compat) from
 * a right-click element pick (`'element'`); element picks carry a short `label` instead of an excerpt. */
interface AnnotationItem {
  kind?: 'text' | 'element';
  selector: string;
  text: string;
  containerText?: string;
  label?: string;
  note?: string;
}

/** FLUX-875 (Tier 3): one layout problem the open-time audit found inside the artifact. */
interface LayoutWarning {
  kind: 'overflow-x' | 'off-canvas' | 'clipped' | 'overlap' | string;
  selector: string;
  detail: string;
}

/** Messages the iframe sends up to the host (validated by `source` + this `ns`/`type` allowlist). */
type InboundMessage =
  | { ns: typeof NS; type: 'ready' }
  | { ns: typeof NS; type: 'annotations'; items: AnnotationItem[] }
  | { ns: typeof NS; type: 'layout-audit'; ok: boolean; warnings: LayoutWarning[] };

/** Messages the host sends down to the iframe. */
type OutboundMessage = { ns: typeof NS; type: 'request-audit' };

/** State of the open-time layout-audit gate for the currently-shown revision. */
type AuditState =
  | { status: 'pending' }
  | { status: 'clean' }
  | { status: 'warnings'; warnings: LayoutWarning[] }
  | { status: 'skipped' }; // audit never reported (errored / timed out) — fail open, reveal.

// The iframe runs *agent-authored* JS in its opaque origin, so every `eh-artifact` message is HOSTILE
// input, not a trusted user action: a compromised / prompt-injected artifact can `postMessage` an
// arbitrary, unbounded `annotations` / `layout-audit` payload directly (the `e.source` check only
// proves it came from *this* iframe, not that a human selected anything). Since the host composes
// these into a chat message fed straight back to the grooming LLM, we clamp every string and array
// length host-side before composing — otherwise an attacker artifact could (a) inject unbounded,
// attacker-chosen instructions into the agent loop on open, or (b) blow up tokens/cost with a giant
// batch. The in-iframe caps are advisory only (that script is replaceable by the agent's own JS), so
// the bound MUST live here.
const MAX_ANNOTATIONS = 50;
const MAX_AUDIT_WARNINGS = 12; // matches the in-iframe MAX_WARNINGS
const MAX_NOTE = 600;

/** Coerce to a single-line string of at most `max` chars (strips newlines so a payload can't smuggle
 * extra markdown structure into the composed chat message). */
function clampLine(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeAnnotations(items: AnnotationItem[]): AnnotationItem[] {
  return items.slice(0, MAX_ANNOTATIONS).map((it) => ({
    // Element items are equally untrusted: coerce kind to 'element' only on an exact match, else 'text'.
    kind: it?.kind === 'element' ? 'element' : 'text',
    selector: clampLine(it?.selector, 300),
    text: clampLine(it?.text, 280),
    label: clampLine(it?.label, 120),
    note: clampLine(it?.note, MAX_NOTE),
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
 *  (see `useDebouncedArtifactReload`) and the DOM is left untouched, so the in-iframe annotation
 *  tray survives. Only a hide that outlasts this grace period drops the iframe to reclaim the
 *  compiled Tailwind/JS it's holding onto. */
const HIDDEN_UNMOUNT_GRACE_MS = 60_000;

export function ArtifactPanel({
  task,
  onSendToChat,
  visible,
}: {
  task: Task;
  onSendToChat?: (text: string) => void;
  /** FLUX-1136: whether this panel is actually on-screen (its section isn't collapsed etc.) —
   *  threaded down by the caller. Combined here with the app's own window-visibility signal, so
   *  an agent iterating while the browser tab is backgrounded doesn't pay the compile cost either. */
  visible: boolean;
}) {
  const { subscribeToEvent } = useAppActions();
  const isWindowVisible = useAppSelector((s) => s.isWindowVisible);
  // The one true "can the user actually see this iframe right now" signal — gates both the
  // debounced-reload deferral and the grace-period unmount below.
  const effectiveVisible = visible && isWindowVisible;

  const revisions = task.artifacts?.revisions ?? [];
  const latest = task.artifacts?.latest ?? (revisions.length > 0 ? revisions[revisions.length - 1]!.rev : 0);

  // The revision currently shown. Tier 1 tracked `latest`; the picker (below) lets the user step back.
  const [rev, setRev] = useState<number>(latest);
  // Cache-buster so a re-publish (or a forced reload) reliably reloads the iframe.
  const [reloadNonce, setReloadNonce] = useState(0);

  // FLUX-1136: whether the iframe itself is currently in the DOM. Stays true across a short hide
  // (display:none upstream is enough to stop paint) and only flips false after the grace period —
  // see the effect below, next to the `artifactReady` subscription it works alongside.
  const [iframeMounted, setIframeMounted] = useState(true);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // FLUX-875 (Tier 3): open-time layout-audit gate. The artifact is masked until the audit reports
  // clean (or the user reveals it anyway); warnings can be round-tripped to the agent for a fix.
  const [audit, setAudit] = useState<AuditState>({ status: 'pending' });
  const [revealed, setRevealed] = useState(false);
  const [auditSent, setAuditSent] = useState(false);

  // Full-screen mode (the annotation UI lives in the iframe, so it works unchanged at any size).
  const [fullscreen, setFullscreen] = useState(false);
  // Transient "sent N annotations" confirmation after a batch round-trips to chat.
  const [sentCount, setSentCount] = useState(0);

  // `rev`/`onSendToChat` change between renders; keep them in refs so the (stable) message listener
  // composes the batch against the *current* values without re-subscribing on every revision step.
  const revRef = useRef(rev);
  const onSendRef = useRef(onSendToChat);
  useEffect(() => { revRef.current = rev; }, [rev]);
  useEffect(() => { onSendRef.current = onSendToChat; }, [onSendToChat]);

  // The stable message listener reads `revealed` to decide whether a late re-audit may re-impose the
  // mask — keep it in a ref so the listener never re-subscribes (and never reads a stale value).
  const revealedRef = useRef(revealed);
  useEffect(() => { revealedRef.current = revealed; }, [revealed]);

  // FLUX-1136: a fresh publish jumps the viewer to the new revision and reloads it — but debounced
  // (a burst of publishes costs one reload of the final revision, not one Tailwind-CDN compile per
  // publish) and deferred entirely while hidden (a publish that arrives invisibly just updates the
  // pending target; it reloads once, the moment the panel is shown again).
  const applyReload = useCallback((pendingRev: number | undefined) => {
    if (typeof pendingRev === 'number') setRev(pendingRev);
    setReloadNonce((n) => n + 1);
  }, []);
  const notifyArtifactReady = useDebouncedArtifactReload(effectiveVisible, applyReload);

  // FLUX-1136: `task.artifacts.latest` also updates via the engine's `taskUpdated` broadcast (a
  // portal refetch fired alongside — but independent of — the `artifactReady` SSE event below on
  // every `publish_artifact` call). Route that path through the same debounced/visibility-gated
  // reload instead of `setRev` directly, or a publish while the panel is hidden (or a fast burst)
  // bypasses the gating entirely via this second path. `prevLatestRef` starts equal to `latest` so
  // the effect's mount-time run is a no-op — opening the panel shouldn't schedule a reload of the
  // revision it already initialized to.
  const prevLatestRef = useRef(latest);
  useEffect(() => {
    if (prevLatestRef.current === latest) return;
    prevLatestRef.current = latest;
    notifyArtifactReady(latest);
  }, [latest, notifyArtifactReady]);

  useEffect(() => {
    const off = subscribeToEvent('artifactReady', (data) => {
      const payload = data as { ticketId?: string; rev?: number };
      if (payload?.ticketId !== task.id) return;
      notifyArtifactReady(payload.rev);
    });
    return off;
  }, [subscribeToEvent, task.id, notifyArtifactReady]);

  // FLUX-1136: grace-period teardown. A short hide costs nothing (the reload above is simply
  // deferred, and the DOM goes untouched) so the in-iframe annotation tray survives a quick
  // collapse/reopen. Only once hidden outlasts the grace period do we actually drop the iframe —
  // reclaiming the compiled Tailwind/JS a long-abandoned panel would otherwise hold onto forever.
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

  const sendAnnotationBatch = useCallback((rawItems: AnnotationItem[]) => {
    const send = onSendRef.current;
    if (!send || !Array.isArray(rawItems) || rawItems.length === 0) return;
    const items = sanitizeAnnotations(rawItems); // bound the untrusted iframe payload (see helpers)
    if (items.length === 0) return;
    const blocks = items
      .map((it, i) => {
        const note = it.note || '';
        const noteLine = note ? `   ${note}\n` : '';
        const anchorLine = `   _anchor:_ \`${it.selector || '(document)'}\``;
        // Element picks (right-click, no selected text) have no excerpt — show the element label with a
        // ⊙ marker instead of an empty `> quote` line. Text selections render exactly as before.
        if (it.kind === 'element') {
          return `${i + 1}. ⊙ \`${it.label || 'element'}\`\n` + noteLine + anchorLine;
        }
        const excerpt = it.text || '(no excerpt)';
        return `${i + 1}. > ${excerpt}\n` + noteLine + anchorLine;
      })
      .join('\n\n');
    const message =
      `🎯 **Artifact annotations** · rev ${revRef.current} · ${items.length} region${items.length === 1 ? '' : 's'}\n\n` +
      `${blocks}\n\n` +
      `Please revise the artifact to address ${items.length === 1 ? 'this' : 'these'} and call ` +
      `\`publish_artifact\` to publish the updated revision.`;
    send(message);
    setSentCount(items.length);
  }, []);

  // Host-side message listener — the trust boundary. Validate `source` (our iframe) over the opaque
  // origin string, then the `ns`/`type` allowlist. Stable (no deps) — reads live values via refs.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Trust boundary: require the message to come from *our* iframe's contentWindow. Inverted from
      // the prior `iframeRef.current && …` form, which short-circuited (accepting ANY window's
      // `eh-artifact` message) during the tiny window before the ref was set.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const d = e.data as InboundMessage | null;
      if (!d || typeof d !== 'object' || d.ns !== NS) return;
      if (d.type === 'annotations') {
        if (Array.isArray(d.items)) sendAnnotationBatch(d.items);
      } else if (d.type === 'layout-audit') {
        // The audit re-fires as late async content (Mermaid SVG, Tailwind CDN, images, fonts) settles,
        // so a 'warnings' state can legitimately upgrade to 'clean'. But once the user has revealed the
        // artifact — or we already failed open to 'skipped' — a late audit must NEVER snap the mask
        // back: the gate is non-trapping by contract, so we drop those late re-mask attempts.
        if (revealedRef.current) return;
        const warnings = sanitizeWarnings(Array.isArray(d.warnings) ? d.warnings : []);
        setAudit((prev) =>
          prev.status === 'skipped'
            ? prev
            : d.ok || warnings.length === 0
              ? { status: 'clean' }
              : { status: 'warnings', warnings },
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sendAnnotationBatch]);

  // The displayed src. Changing it remounts the iframe (key={src}); re-arm the layout-audit gate
  // (each revision is audited fresh) and clear any stale "sent" confirmation. FLUX-1136: also re-arm
  // on `iframeMounted` flipping back true — a grace-period teardown recreates the iframe from
  // scratch even when `src` itself didn't change while hidden.
  const src = `/api/tasks/${encodeURIComponent(task.id)}/artifact?rev=${rev}&_n=${reloadNonce}`;
  useEffect(() => {
    if (!iframeMounted) return;
    setAudit({ status: 'pending' });
    setRevealed(false);
    setAuditSent(false);
    setSentCount(0);
    // Fail open: if the audit script never reports (artifact JS error, very heavy doc), don't trap
    // the user behind the mask forever — reveal after a grace period.
    const t = window.setTimeout(() => {
      setAudit((a) => (a.status === 'pending' ? { status: 'skipped' } : a));
    }, 4000);
    return () => window.clearTimeout(t);
  }, [src, iframeMounted]);

  // Clear the "sent N annotations" confirmation after a few seconds.
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

  // FLUX-1022: Esc exits full screen — routed through the shared Escape stack (rather than this
  // component's own listener) because this panel nests inside TaskModal and inside a dock
  // ChatWindow's sideview, both of which now have their own Escape handling; sharing the stack
  // keeps a single ESC press from exiting fullscreen AND closing/collapsing the host at once.
  useEscapeKey(() => setFullscreen(false), { enabled: fullscreen });

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

  const sendAuditWarnings = () => {
    if (audit.status !== 'warnings' || !onSendToChat) return;
    const lines = audit.warnings
      .map((w) => `- **${w.kind}** \`${w.selector}\` — ${w.detail}`)
      .join('\n');
    const message =
      `🧪 **Layout audit failed** · rev ${rev}\n\n` +
      `The published artifact has ${audit.warnings.length} layout problem${audit.warnings.length === 1 ? '' : 's'} ` +
      `(overflow / clipping / overlap) that mask it in the viewer:\n\n` +
      `${lines}\n\n` +
      `Please fix the layout and call \`publish_artifact\` to publish a corrected revision.`;
    onSendToChat(message);
    setAuditSent(true);
  };

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-[120] flex flex-col gap-2 bg-[var(--eh-surface)] p-4'
          : 'flex flex-col gap-2'
      }
    >
      {/* Header: title + revision picker + full-screen toggle. We deliberately offer NO "open in new
          tab" — a top-level navigation to the artifact route would un-sandbox the agent HTML. */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--eh-text-muted)]">
        <span className="min-w-0 truncate">
          {current?.title || 'Artifact'} · rev {rev}{rev === latest ? ' (latest)' : ''}
          {sentCount > 0 && (
            <span role="status" aria-live="polite" className="ml-2 text-emerald-500">
              ✓ Sent {sentCount} annotation{sentCount === 1 ? '' : 's'} to agent
            </span>
          )}
        </span>
        <div className="flex flex-shrink-0 items-center gap-1">
          {revisions.length > 1 && (
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
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? 'Exit full screen (Esc)' : 'Open full screen'}
            className="rounded p-0.5 hover:text-[var(--eh-text-secondary)]"
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* The iframe (with its in-document annotation UI) + the open-time layout-audit mask. The mask
          covers the artifact while the audit is pending or has surfaced warnings, until reveal.
          FLUX-1136: `iframeMounted` drops the iframe (and its compiled Tailwind/JS) once hidden has
          outlasted the grace period — a short hide leaves it alone so annotations survive. */}
      <div className={fullscreen ? 'relative min-h-0 flex-1' : 'relative'}>
        {iframeMounted ? (
          <iframe
            key={src}
            ref={iframeRef}
            title={`Artifact for ${task.id}`}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className={`eh-border w-full rounded-lg border bg-white ${fullscreen ? 'h-full' : 'h-[58vh]'}`}
          />
        ) : (
          <div className={`eh-border w-full rounded-lg border bg-white ${fullscreen ? 'h-full' : 'h-[58vh]'}`} />
        )}

        {iframeMounted && !revealed && audit.status === 'pending' && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/70 backdrop-blur-[2px]"
          >
            <div className="flex items-center gap-2 text-[12px] text-[var(--eh-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking layout…
            </div>
          </div>
        )}

        {iframeMounted && !revealed && audit.status === 'warnings' && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 flex flex-col gap-2 overflow-y-auto rounded-lg bg-[var(--eh-surface)] p-3"
          >
            <div className="flex items-center gap-2 text-[12px] font-semibold text-amber-500">
              <AlertTriangle className="h-4 w-4" />
              Layout audit found {audit.warnings.length} issue{audit.warnings.length === 1 ? '' : 's'}
            </div>
            <p className="text-[11px] text-[var(--eh-text-muted)]">
              The artifact is masked until the layout is clean. Send the warnings to the grooming agent for a
              corrected revision, or reveal it anyway.
            </p>
            <ul className="flex flex-col gap-1 text-[11px] text-[var(--eh-text-secondary)]">
              {audit.warnings.map((w, i) => (
                <li key={i} className="eh-border rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1">
                  <span className="font-medium text-amber-600">{w.kind}</span>{' '}
                  <code className="text-[10px] text-[var(--eh-text-muted)]">{w.selector}</code>
                  <div className="text-[var(--eh-text-secondary)]">{w.detail}</div>
                </li>
              ))}
            </ul>
            <div className="mt-auto flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setRevealed(true)}
                title="Show the artifact despite the layout warnings"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--eh-text-muted)] hover:text-[var(--eh-text-secondary)]"
              >
                <Eye className="h-3 w-3" /> Show anyway
              </button>
              <button
                type="button"
                onClick={sendAuditWarnings}
                disabled={!onSendToChat || auditSent}
                title={onSendToChat ? 'Send the layout warnings to the grooming agent' : 'Chat unavailable'}
                className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-40"
              >
                <Send className="h-3 w-3" /> {auditSent ? 'Sent to agent' : 'Send to agent'}
              </button>
            </div>
          </div>
        )}
      </div>

      {current?.note && !fullscreen ? (
        <p className="px-1 text-[11px] text-[var(--eh-text-muted)]">{current.note}</p>
      ) : null}

      {!fullscreen && (
        <p className="px-1 text-[10px] text-[var(--eh-text-muted)]">
          Tip: select text — or right-click any element (toggle, button, chart bar) — in the artifact to
          annotate it. Collect several notes, then “Send to agent” from the tray — or open full screen for
          a larger canvas.
        </p>
      )}
    </div>
  );
}
