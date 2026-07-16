import fs from 'fs/promises';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';
import { isPathInsideRoot } from './file-utils.js';

/**
 * Rich grooming artifacts (FLUX-872 / Tier 1 FLUX-873).
 *
 * A grooming agent can publish a **self-contained HTML artifact** (a rendered mockup, an
 * architecture diagram, an interactive prototype) that the user reasons *against* — catching
 * misunderstanding before code is written. Storage is **revision-keyed from the start** (parent
 * decision: keep history): every `publish_artifact` call is a new revision, never an overwrite,
 * so the Tier-2 revision picker is a non-breaking add. The HTML lives in a sidecar under
 * `.flux/artifacts/{ID}/{rev}.html` (never inlined in the markdown body — the body is injected
 * into every agent session and has a 10K soft limit); the ticket frontmatter carries only a small
 * {@link ArtifactPointer} listing revisions.
 *
 * Security note: the HTML is agent-authored and untrusted-ish. The REST route ({@link ARTIFACT_CSP})
 * serves it with a strict CSP, and the portal renders it in `<iframe sandbox="allow-scripts">` WITHOUT
 * `allow-same-origin`, so artifact JS runs in a unique opaque origin and cannot reach portal
 * cookies / DOM / storage. This module owns the on-disk shape + path-traversal guards.
 */

export interface ArtifactRevision {
  rev: number;
  title?: string;
  note?: string;
  /** ISO timestamp of publish. */
  createdAt: string;
  /** Size of the stored HTML in bytes (for the picker / digest, avoids re-reading the file). */
  bytes: number;
}

export interface ArtifactPointer {
  /** Highest revision number published — the viewer's default. */
  latest: number;
  /** Every revision ever published, oldest-first (history is kept). */
  revisions: ArtifactRevision[];
}

/**
 * Content-Security-Policy applied to the served artifact HTML. The iframe sandbox already isolates
 * the document to an opaque origin (no `allow-same-origin`); this CSP is the second layer — it lets
 * the artifact use inline `<style>`/`<script>` and load from the named CDNs the grooming skill
 * allows (Mermaid via jsDelivr/unpkg, Google Fonts, and Tailwind as a heavy last resort — see the
 * skill's "Rich Artifacts" section) while blocking exfiltration:
 * `connect-src 'none'` (no fetch/XHR/WebSocket beaconing), `form-action 'none'`, `base-uri 'none'`,
 * and `frame-ancestors 'self'` so only the portal can embed it. `'unsafe-eval'` is tolerated here
 * because the document is sandboxed to an opaque origin with nothing of value to reach.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://fonts.googleapis.com https://unpkg.com",
  "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
  "img-src data: blob: https:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

// Ticket ids are used as a path segment — keep them to a safe charset so a crafted id can never
// escape the artifacts root (defense-in-depth alongside isPathInsideRoot below).
const SAFE_TICKET_ID_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeTicketId(id: unknown): id is string {
  return typeof id === 'string' && id !== '.' && id !== '..' && SAFE_TICKET_ID_RE.test(id);
}

/**
 * Parse a `rev` query/param value into a positive integer or the `'latest'` sentinel. Returns null
 * for anything malformed (non-integer, zero, negative, NaN) so the caller can 400 rather than risk
 * an unexpected path. Empty / missing / `'latest'` all resolve to `'latest'`.
 */
export function parseRevParam(value: unknown): number | 'latest' | null {
  if (value == null || value === '' || value === 'latest') return 'latest';
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function getArtifactsRoot(): string {
  return path.join(getActiveFluxDir(), 'artifacts');
}

export function getTicketArtifactsDir(ticketId: string): string {
  return path.join(getArtifactsRoot(), ticketId);
}

export function getArtifactFilePath(ticketId: string, rev: number): string {
  return path.join(getTicketArtifactsDir(ticketId), `${rev}.html`);
}

/** Revision numbers present on disk for a ticket, ascending. Empty array if none / dir missing. */
export async function listArtifactRevisionsOnDisk(ticketId: string): Promise<number[]> {
  if (!isSafeTicketId(ticketId)) return [];
  try {
    const entries = await fs.readdir(getTicketArtifactsDir(ticketId));
    return entries
      .map((name) => {
        const m = /^(\d+)\.html$/.exec(name);
        return m ? Number(m[1]) : null;
      })
      .filter((n): n is number => n != null && Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Write a NEW revision of an artifact (never overwrites). The next revision number is
 * `max(highest-on-disk, pointer.latest) + 1` so it is robust even if the frontmatter pointer and
 * the disk drift. Returns the new rev, the updated pointer (caller persists it onto the ticket
 * frontmatter), and the byte size.
 */
export async function writeArtifactRevision(
  ticketId: string,
  html: string,
  meta: { title?: string | undefined; note?: string | undefined },
  existing: ArtifactPointer | undefined,
): Promise<{ rev: number; pointer: ArtifactPointer; bytes: number }> {
  if (!isSafeTicketId(ticketId)) throw new Error(`Unsafe ticket id: ${ticketId}`);

  const onDisk = await listArtifactRevisionsOnDisk(ticketId);
  const maxOnDisk = onDisk.length > 0 ? onDisk[onDisk.length - 1]! : 0;
  const maxPointer = existing?.latest ?? 0;
  const rev = Math.max(maxOnDisk, maxPointer) + 1;

  const filePath = getArtifactFilePath(ticketId, rev);
  if (!isPathInsideRoot(getArtifactsRoot(), filePath)) {
    throw new Error('Resolved artifact path escapes the artifacts root');
  }

  await fs.mkdir(getTicketArtifactsDir(ticketId), { recursive: true });
  const bytes = Buffer.byteLength(html, 'utf-8');
  await fs.writeFile(filePath, html, 'utf-8');

  const revision: ArtifactRevision = {
    rev,
    createdAt: new Date().toISOString(),
    bytes,
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.note ? { note: meta.note } : {}),
  };
  const priorRevisions = Array.isArray(existing?.revisions) ? existing!.revisions : [];
  const pointer: ArtifactPointer = { latest: rev, revisions: [...priorRevisions, revision] };
  return { rev, pointer, bytes };
}

/**
 * Read a revision's HTML. `rev` may be a concrete number or `'latest'`. When `'latest'`, prefer the
 * pointer's `latest` but fall back to the highest revision actually present on disk if that file is
 * missing (pointer drift). Returns null when nothing resolves / the file is absent. Path-guarded.
 */
export async function readArtifactRevision(
  ticketId: string,
  rev: number | 'latest',
  pointer: ArtifactPointer | undefined,
): Promise<{ rev: number; html: string } | null> {
  if (!isSafeTicketId(ticketId)) return null;

  let resolved: number | null;
  if (rev === 'latest') {
    const onDisk = await listArtifactRevisionsOnDisk(ticketId);
    const maxOnDisk = onDisk.length > 0 ? onDisk[onDisk.length - 1]! : null;
    resolved = pointer?.latest ?? maxOnDisk;
    if (resolved != null) {
      const probe = getArtifactFilePath(ticketId, resolved);
      // Pointer claims a revision that is gone from disk → fall back to the newest file present.
      if (!isPathInsideRoot(getArtifactsRoot(), probe)) return null;
      try {
        await fs.access(probe);
      } catch {
        resolved = maxOnDisk;
      }
    }
  } else {
    resolved = rev;
  }

  if (resolved == null) return null;
  const filePath = getArtifactFilePath(ticketId, resolved);
  if (!isPathInsideRoot(getArtifactsRoot(), filePath)) return null;
  try {
    const html = await fs.readFile(filePath, 'utf-8');
    return { rev: resolved, html };
  } catch {
    return null;
  }
}

/**
 * FLUX-874 / FLUX-875 (Tier 2/3) — in-iframe annotation UI injected into the served artifact HTML.
 *
 * Runs INSIDE the sandboxed, opaque-origin iframe (the stored file stays pristine — injection is at
 * serve time only). The **entire** annotation UX lives here, all DOM + one `postMessage` on send,
 * never network or storage:
 *   1. On a text selection, it opens a **floating composer popover at the selection** (not a card at
 *      the bottom of the panel) with the quoted excerpt + a note field. **Right-clicking any element**
 *      (FLUX-892) does the same for non-text controls — toggles, SVG bars, buttons — anchoring to the
 *      element's CSS path with no text selection; the native context menu is suppressed and a brief
 *      `[data-eh-ui]` highlight (zero layout impact) shows which element was captured.
 *   2. "Add note" drops a numbered **pin** anchored to the content (scrolls with the document).
 *      Clicking a pin re-opens the composer to view/edit that note (Remove is explicit) — never a
 *      bare delete.
 *   3. FLUX-1362: the annotation set is mirrored to the host **LIVE on every add/edit/remove** (not
 *      only on a Send) as `{ns:'eh-artifact', type:'annotations', items:[…]}`, each item carrying its
 *      stable pin `id`. The host owns the unified, editable list (the floating "N changes" pill) and
 *      composes the chat message; the iframe no longer renders its own tray/Send. Host→iframe
 *      `remove-pin`/`update-pin` messages round-trip a host-side edit/removal back to the pin.
 *
 * Living in-iframe is what makes the pins follow the iframe's internal scroll for free — a host
 * overlay can't, short of streaming scroll offsets every frame. Each annotation still carries a
 * **stable anchor** (CSS path + selected text) so the agent knows which region the note is about.
 *
 * The CSP already permits inline `<style>`/`<script>`, so injection needs no header change. Because
 * the iframe has an opaque origin, it posts to `'*'`; the **host** is the trust boundary — it
 * validates `event.source === <our iframe>.contentWindow` and the `ns`/`type` allowlist (see
 * ArtifactPanel), never trusting `event.origin` (the string `"null"`). All injected UI is tagged
 * `data-eh-ui` so the layout-audit gate skips it, and the composer ignores selections inside itself.
 *
 * Authored with String.raw so the regexes/backslashes survive verbatim into the emitted JS.
 */
export const ARTIFACT_ANNOTATOR_SCRIPT = String.raw`
(function () {
  'use strict';
  var NS = 'eh-artifact';
  function post(msg) { try { (window.parent || window.top).postMessage(msg, '*'); } catch (e) {} }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  // A CSS path from <body> down to el, using ids where present (and short-circuiting on them) and
  // nth-of-type to disambiguate siblings — a stable-enough anchor for the agent to find the region.
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(sel + '#' + cssEscape(node.id)); break; }
      var parent = node.parentNode;
      if (parent && parent.children) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(' > ');
  }
  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    e.setAttribute('data-eh-ui', '');
    return e;
  }
  function inUi(node) { return !!(node && node.closest && node.closest('[data-eh-ui]')); }

  var annotations = [];   // { id, kind, selector, text, containerText, label, note, docX, docY }
  var seq = 0;
  var composer = null, highlight = null;

  function ensureStyle() {
    if (document.getElementById('eh-anno-style')) return;
    var s = document.createElement('style');
    s.id = 'eh-anno-style';
    s.setAttribute('data-eh-ui', '');
    s.textContent = [
      '[data-eh-ui]{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}',
      '.eh-anno-composer{position:fixed;z-index:2147483600;width:280px;max-width:92vw;background:#0b1220;color:#e5e7eb;border:1px solid #334155;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:10px;font-size:12px;}',
      '.eh-anno-quote{max-height:56px;overflow:auto;border-left:2px solid #f59e0b;padding-left:8px;margin-bottom:8px;color:#cbd5e1;font-style:italic;}',
      '.eh-anno-composer textarea{width:100%;resize:vertical;min-height:46px;background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:6px;padding:6px;font-size:12px;}',
      '.eh-anno-row{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;}',
      '.eh-anno-btn{cursor:pointer;border:none;border-radius:6px;padding:5px 10px;font-size:11px;font-weight:600;}',
      '.eh-anno-btn-primary{background:#6366f1;color:#fff;}',
      '.eh-anno-btn-ghost{background:transparent;color:#94a3b8;}',
      '.eh-anno-pin{position:absolute;z-index:2147483500;transform:translate(-50%,-50%);width:20px;height:20px;border-radius:50%;background:#f59e0b;color:#1f2937;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:pointer;border:2px solid #fff;}',
      '.eh-anno-highlight{position:fixed;z-index:2147483500;pointer-events:none;border:2px solid #6366f1;border-radius:4px;background:rgba(99,102,241,.12);box-shadow:0 0 0 1px rgba(255,255,255,.45);}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function clearComposer() {
    if (composer && composer.parentNode) composer.parentNode.removeChild(composer);
    composer = null;
    clearHighlight();
  }
  function clearHighlight() {
    if (highlight && highlight.parentNode) highlight.parentNode.removeChild(highlight);
    highlight = null;
  }
  // Draw a zero-footprint box over the element the right-click will capture: position:fixed +
  // pointer-events:none + [data-eh-ui], so it never shifts the artifact's own layout or intercepts
  // events. Removed when the composer clears (extend of clearComposer).
  function drawHighlight(target) {
    ensureStyle();
    clearHighlight();
    if (!target || target.nodeType !== 1) return;
    var r = target.getBoundingClientRect();
    highlight = el('div', 'eh-anno-highlight');
    highlight.style.left = r.left + 'px';
    highlight.style.top = r.top + 'px';
    highlight.style.width = Math.max(0, r.width) + 'px';
    highlight.style.height = Math.max(0, r.height) + 'px';
    document.body.appendChild(highlight);
  }

  // Position a fixed node near a viewport point, clamped on-screen; flips above if no room below.
  function placeFixed(node, vx, vyBelow, vyAbove) {
    var w = node.offsetWidth || 280, h = node.offsetHeight || 150;
    var maxX = Math.max(8, window.innerWidth - w - 8);
    var maxY = Math.max(8, window.innerHeight - h - 8);
    var x = Math.max(8, Math.min(vx, maxX));
    var y = vyBelow;
    if (y > maxY) y = Math.max(8, vyAbove - h);
    y = Math.max(8, Math.min(y, maxY));
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  }

  function selectionInfo() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var text = norm(sel.toString());
    if (!text) return null;
    var range = sel.getRangeAt(0);
    var container = range.commonAncestorContainer;
    if (container && container.nodeType !== 1) container = container.parentElement;
    if (!container || inUi(container)) return null;
    var rect = range.getBoundingClientRect();
    var sx = window.scrollX || window.pageXOffset || 0;
    var sy = window.scrollY || window.pageYOffset || 0;
    return {
      kind: 'text',
      selector: cssPath(container),
      text: text.slice(0, 300),
      containerText: norm(container.textContent).slice(0, 600),
      label: '',
      rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
      docX: rect.left + sx,
      docY: rect.top + sy
    };
  }

  // FLUX-1440: best-effort value capture for form controls (INPUT/SELECT/TEXTAREA) or a custom
  // control opted in via data-eh-value — most elements have neither, so this stays undefined
  // (never thrown, never coerced to a misleading "undefined" string).
  function readValue(target) {
    if (!target || target.nodeType !== 1) return undefined;
    var tag = target.tagName ? target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      var v = target.value;
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
    if (target.hasAttribute && target.hasAttribute('data-eh-value')) {
      return target.getAttribute('data-eh-value');
    }
    return undefined;
  }

  // Mirrors selectionInfo()'s shape for a right-click on ANY element (no text selection). The anchor
  // is the element's CSS path; 'label' is a short human descriptor (tag + a trimmed textContent
  // snippet) so the agent has context without a quoted excerpt. Returns null for our own UI / non-elements.
  function elementInfo(target) {
    if (!target || target.nodeType !== 1 || inUi(target)) return null;
    var tag = target.tagName ? target.tagName.toLowerCase() : 'node';
    var snippet = norm(target.textContent).slice(0, 80);
    var label = snippet ? tag + ' "' + snippet + '"' : tag;
    var rect = target.getBoundingClientRect();
    var sx = window.scrollX || window.pageXOffset || 0;
    var sy = window.scrollY || window.pageYOffset || 0;
    return {
      kind: 'element',
      selector: cssPath(target),
      text: '',
      containerText: norm(target.textContent).slice(0, 600),
      label: label,
      value: readValue(target),
      rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
      docX: rect.left + sx,
      docY: rect.top + sy
    };
  }

  // FLUX-1362: the host owns the unified, editable annotation list (the floating "N changes" pill),
  // so the iframe no longer renders a tray. It mirrors the current annotation set to the host LIVE on
  // every add / edit / remove (not just on a Send), and accepts host→iframe pin edits/removals. Each
  // item carries its stable pin id so a host-side edit/remove round-trips back to the right pin.
  function postLive() {
    post({ ns: NS, type: 'annotations', items: annotations.map(function (a) {
      return { id: a.id, kind: a.kind || 'text', selector: a.selector, text: a.text, containerText: a.containerText, label: a.label || '', note: a.note, value: a.value };
    }) });
  }
  function findAnn(id) {
    for (var i = 0; i < annotations.length; i++) { if (annotations[i].id === id) return annotations[i]; }
    return null;
  }

  // The composer captures a NEW annotation (info has no existingId) or edits an EXISTING one (pin
  // click, info.existingId set) — an edit surfaces Remove + Save, a capture surfaces Add note.
  function openComposer(info) {
    ensureStyle();
    clearComposer();
    var editing = info.existingId != null;
    composer = el('div', 'eh-anno-composer');
    var q = el('div', 'eh-anno-quote');
    if (info.kind === 'element') {
      q.textContent = '⊙ ' + (info.label || 'element');
    } else {
      q.textContent = '"' + (info.text || '').slice(0, 200) + ((info.text || '').length > 200 ? '…' : '') + '"';
    }
    composer.appendChild(q);
    var ta = el('textarea');
    ta.placeholder = 'What should change about this region? (optional)';
    if (editing) ta.value = info.note || '';
    composer.appendChild(ta);
    var row = el('div', 'eh-anno-row');
    var cancel = el('button', 'eh-anno-btn eh-anno-btn-ghost'); cancel.textContent = 'Cancel';
    cancel.addEventListener('click', clearComposer);
    row.appendChild(cancel);
    if (editing) {
      var remove = el('button', 'eh-anno-btn eh-anno-btn-ghost'); remove.textContent = 'Remove';
      remove.addEventListener('click', function () { removeAnnotation(info.existingId); clearComposer(); });
      row.appendChild(remove);
      var save = el('button', 'eh-anno-btn eh-anno-btn-primary'); save.textContent = 'Save';
      save.addEventListener('click', function () { updateAnnotation(info.existingId, ta.value); clearComposer(); });
      row.appendChild(save);
    } else {
      var add = el('button', 'eh-anno-btn eh-anno-btn-primary'); add.textContent = 'Add note';
      add.addEventListener('click', function () { addAnnotation(info, ta.value); clearComposer(); });
      row.appendChild(add);
    }
    composer.appendChild(row);
    document.body.appendChild(composer);
    placeFixed(composer, info.rect.left, info.rect.bottom + 8, info.rect.top - 8);
    try { ta.focus(); } catch (e) {}
  }

  function addAnnotation(info, note) {
    seq++;
    annotations.push({ id: seq, kind: info.kind || 'text', selector: info.selector, text: info.text, containerText: info.containerText, label: info.label || '', note: norm(note), value: info.value, docX: info.docX, docY: info.docY });
    dropPin(seq, info.docX, info.docY, note);
    postLive();
  }

  function updateAnnotation(id, note) {
    var a = findAnn(id);
    if (a) a.note = norm(note);
    var p = document.querySelector('[data-eh-pin="' + id + '"]');
    if (p) p.title = 'Annotation ' + id + (norm(note) ? ': ' + norm(note) : '') + ' (click to edit)';
    postLive();
  }

  // Clicking a numbered pin re-opens the composer to VIEW/EDIT its note (never a bare delete) —
  // removal is explicit, via the composer's Remove button (or the host-side pill).
  function dropPin(id, docX, docY, note) {
    ensureStyle();
    var pin = el('div', 'eh-anno-pin');
    pin.textContent = String(id);
    pin.setAttribute('data-eh-pin', String(id));
    pin.style.left = docX + 'px';
    pin.style.top = docY + 'px';
    pin.title = 'Annotation ' + id + (norm(note) ? ': ' + norm(note) : '') + ' (click to edit)';
    pin.addEventListener('click', function () {
      var a = findAnn(id);
      if (!a) return;
      var r = pin.getBoundingClientRect();
      openComposer({ existingId: id, kind: a.kind, text: a.text, label: a.label, note: a.note, rect: { left: r.left, top: r.top, bottom: r.bottom } });
    });
    document.body.appendChild(pin);
  }

  function removeAnnotation(id) {
    annotations = annotations.filter(function (a) { return a.id !== id; });
    var p = document.querySelector('[data-eh-pin="' + id + '"]');
    if (p && p.parentNode) p.parentNode.removeChild(p);
    postLive();
  }

  // FLUX-1440: guided controls. A groomer marks up plain HTML with data-eh-feel / data-eh-decision
  // so interacting with the control auto-stages an annotation into the SAME annotations[]/postLive()
  // transport used by selection/right-click — no composer, no second message channel. Re-interacting
  // with a control restages IN PLACE (one annotation per control) by keying off a stable
  // data-eh-anno-id the control remembers after its first stage, mirroring updateAnnotation()'s
  // find-and-update rather than pushing a growing pile.
  function ensureGuidedStyle() {
    if (document.getElementById('eh-guided-style')) return;
    var s = document.createElement('style');
    s.id = 'eh-guided-style';
    s.setAttribute('data-eh-ui', '');
    s.textContent = [
      '.eh-guided-feel{display:flex;align-items:center;gap:8px;margin-top:6px;}',
      '.eh-guided-feel input[type=range]{flex:1;accent-color:#6366f1;}',
      '.eh-guided-readout{min-width:44px;text-align:right;font-size:11px;color:#94a3b8;}',
      '.eh-guided-card{background:#0b1220;color:#e5e7eb;border:1px solid #334155;border-radius:10px;padding:10px;font-size:12px;max-width:320px;}',
      '.eh-guided-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;}',
      '.eh-guided-idx{color:#94a3b8;font-size:11px;white-space:nowrap;}',
      '.eh-guided-opts{display:flex;flex-wrap:wrap;gap:6px;}',
      '.eh-guided-opt{cursor:pointer;border:1px solid #334155;border-radius:6px;padding:5px 10px;font-size:11px;background:transparent;color:#e5e7eb;}',
      '.eh-guided-opt.eh-guided-selected{background:#6366f1;border-color:#6366f1;color:#fff;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  // Stage (create or, on a second interaction with the same control, in-place update) ONE annotation
  // for a guided control. Never opens the composer — guided controls auto-stage, they don't collect a
  // free-text note (out of scope here; sending stays an explicit host-side action).
  function stageGuided(control, kind, selector, label, value) {
    var existingId = control && control.getAttribute ? control.getAttribute('data-eh-anno-id') : null;
    var a = existingId ? findAnn(Number(existingId)) : null;
    if (a) {
      a.kind = kind;
      a.selector = selector;
      a.label = label;
      a.value = value;
    } else {
      seq++;
      a = { id: seq, kind: kind, selector: selector, text: '', containerText: '', label: label, note: '', value: value };
      annotations.push(a);
      if (control && control.setAttribute) control.setAttribute('data-eh-anno-id', String(a.id));
    }
    postLive();
  }

  // [data-eh-feel]: upgrades to a labeled range slider (reusing an author-nested <input type=range>
  // if present) with a live readout. Settling on a value (change, not every drag tick) stages a
  // kind:'feel' annotation. Malformed/missing min/max/step/default fall back to sane defaults.
  function upgradeFeelControls() {
    var hosts = document.querySelectorAll('[data-eh-feel]');
    if (!hosts.length) return;
    ensureGuidedStyle();
    for (var i = 0; i < hosts.length; i++) {
      (function (host) {
        var input = host.querySelector('input[type=range]');
        var created = false;
        if (!input) { input = el('input'); input.type = 'range'; created = true; }
        var min = parseFloat(host.getAttribute('data-eh-min'));
        var max = parseFloat(host.getAttribute('data-eh-max'));
        var step = parseFloat(host.getAttribute('data-eh-step'));
        var def = parseFloat(host.getAttribute('data-eh-default'));
        if (isNaN(min)) min = 0;
        if (isNaN(max) || max <= min) max = 100;
        if (isNaN(step) || step <= 0) step = 1;
        if (isNaN(def)) def = min;
        var label = host.getAttribute('data-eh-label') || 'Feel';
        var unit = host.getAttribute('data-eh-unit') || '';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        if (input.value === '' || input.value == null) input.value = String(def);
        var readout = el('span', 'eh-guided-readout');
        readout.textContent = input.value + unit;
        if (created) {
          var wrap = el('div', 'eh-guided-feel');
          wrap.appendChild(input);
          wrap.appendChild(readout);
          host.appendChild(wrap);
        } else if (input.parentNode) {
          input.parentNode.insertBefore(readout, input.nextSibling);
        } else {
          host.appendChild(readout);
        }
        input.addEventListener('input', function () { readout.textContent = input.value + unit; });
        input.addEventListener('change', function () {
          readout.textContent = input.value + unit;
          stageGuided(host, 'feel', cssPath(host), label, input.value + unit);
        });
      })(hosts[i]);
    }
  }

  // [data-eh-decision]: upgrades to a small decision card (question + optional index/of tag + the
  // child data-eh-opt elements rendered as selectable chips, replacing their raw markup). Picking an
  // option stages a kind:'decision' annotation; picking a different option restages the SAME record.
  function upgradeDecisionControls() {
    var hosts = document.querySelectorAll('[data-eh-decision]');
    if (!hosts.length) return;
    ensureGuidedStyle();
    for (var i = 0; i < hosts.length; i++) {
      (function (host) {
        var question = host.getAttribute('data-eh-question') || 'Decision';
        var idx = host.getAttribute('data-eh-index');
        var of = host.getAttribute('data-eh-of');
        var defOpt = host.getAttribute('data-eh-default');
        var optSrcs = host.querySelectorAll('[data-eh-opt]');
        var card = el('div', 'eh-guided-card');
        var head = el('div', 'eh-guided-head');
        var q = el('span'); q.textContent = question;
        head.appendChild(q);
        if (idx && of) {
          var tag = el('span', 'eh-guided-idx'); tag.textContent = idx + ' / ' + of;
          head.appendChild(tag);
        }
        card.appendChild(head);
        var opts = el('div', 'eh-guided-opts');
        for (var j = 0; j < optSrcs.length; j++) {
          (function (optSrc) {
            var attr = optSrc.getAttribute('data-eh-opt');
            var value = (attr && norm(attr)) || norm(optSrc.textContent) || 'Option';
            optSrc.style.display = 'none';
            var chip = el('button', 'eh-guided-opt');
            chip.type = 'button';
            chip.textContent = value;
            if (defOpt && norm(defOpt) === value) chip.className += ' eh-guided-selected';
            chip.addEventListener('click', function () {
              var siblings = opts.querySelectorAll('.eh-guided-opt');
              for (var k = 0; k < siblings.length; k++) siblings[k].className = 'eh-guided-opt';
              chip.className = 'eh-guided-opt eh-guided-selected';
              stageGuided(host, 'decision', cssPath(host), question, value);
            });
            opts.appendChild(chip);
          })(optSrcs[j]);
        }
        card.appendChild(opts);
        host.appendChild(card);
      })(hosts[i]);
    }
  }

  function upgradeGuidedControls() {
    upgradeFeelControls();
    upgradeDecisionControls();
  }

  document.addEventListener('mouseup', function (e) {
    if (e && e.target && inUi(e.target)) return; // don't hijack clicks inside our own UI
    setTimeout(function () { var info = selectionInfo(); if (info) openComposer(info); }, 0);
  });
  // Right-click any element to anchor an annotation to it (no text selection required). Suppress the
  // native context menu only when we actually capture an element; right-clicks on our own UI pass
  // through untouched. No chrome is injected into the artifact — only the [data-eh-ui] overlay nodes.
  document.addEventListener('contextmenu', function (e) {
    if (e && e.target && inUi(e.target)) return; // ignore our own UI — let the native menu pass
    var target = (e && e.target && e.target.nodeType === 1) ? e.target
      : (document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null);
    var info = elementInfo(target);
    if (!info) return;
    e.preventDefault();
    drawHighlight(target);
    openComposer(info);
  });
  // FLUX-1314: once the user clicks into this sandboxed iframe, keydown dispatches here — a
  // separate browsing context — and never reaches the host window's Escape listener, so Esc
  // silently stopped exiting full-screen. Close our own composer first (nearest overlay wins,
  // mirroring the host's LIFO Escape stack); otherwise forward the press up so the host pops
  // its own stack (e.g. exit full-screen).
  document.addEventListener('keydown', function (e) {
    if (!e || e.key !== 'Escape') return;
    if (composer) { clearComposer(); return; }
    post({ ns: NS, type: 'escape' });
  });
  // FLUX-1362: host->iframe reverse-sync. When the user edits/removes an annotation from the host's
  // unified list (the "N changes" pill), the host posts the intent down so the matching pin's note
  // (tooltip) updates or the pin is removed. Both re-post the live set, which the host ingests
  // idempotently (the sets already match), so there is no feedback loop.
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object' || d.ns !== NS) return;
    if (d.type === 'remove-pin') removeAnnotation(d.id);
    else if (d.type === 'update-pin') updateAnnotation(d.id, d.note);
  });
  upgradeGuidedControls();
  var hasGuidedControls = document.querySelectorAll('[data-eh-feel],[data-eh-decision]').length > 0;
  post({ ns: NS, type: 'ready', hasGuidedControls: hasGuidedControls });
})();
`;

/**
 * FLUX-875 (Tier 3) — open-time layout-audit gate (logic ported from Lavish's idea, reimplemented
 * against our sandboxed iframe; no Lavish code reused).
 *
 * Runs INSIDE the sandboxed, opaque-origin iframe once layout has settled and reports a small list
 * of layout warnings up to the host over `postMessage` ({ns:'eh-artifact', type:'layout-audit', …}).
 * The host **masks the artifact until the audit reports clean** and offers to round-trip the
 * warnings into the ticket chat so the grooming agent fixes them and re-publishes (graceful: a
 * "Show anyway" override always lets the user reveal a flagged artifact, since heuristics can
 * false-positive). Three conservative, low-false-positive checks — all pure DOM measurement, never
 * network or storage:
 *   1. **overflow-x** — the page is wider than the viewport (a horizontal scrollbar appears).
 *   2. **off-canvas** — a visible element spills past the left/right viewport edge (the usual
 *      culprit behind overflow-x); the few worst offenders are named.
 *   3. **clipped** — an `overflow:hidden|clip` element is cutting off real (text) content.
 *   4. **overlap** — two non-positioned, text-bearing sibling blocks substantially overlap
 *      (text-on-text breakage); decorative absolutely/fixed-positioned overlays are skipped so
 *      intentional stacking never trips the gate.
 *
 * It re-runs on a host `request-audit` message (e.g. after the user reveals + the layout reflows).
 * The CSP already permits inline `<script>`; injection needs no header change. Authored with
 * String.raw so regexes/backslashes survive verbatim into the emitted JS.
 */
export const ARTIFACT_LAYOUT_AUDIT_SCRIPT = String.raw`
(function () {
  'use strict';
  var NS = 'eh-artifact';
  var TOL = 2;            // px slack — ignore sub-pixel rounding
  var MAX_NODES = 4000;   // cap the scan on huge documents
  var MAX_WARNINGS = 12;
  function post(msg) { try { (window.parent || window.top).postMessage(msg, '*'); } catch (e) {} }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function visible(el, cs) {
    if (!cs) cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }
  function positioned(cs) { return cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky'; }
  function shortSel(el) {
    if (!el || el.nodeType !== 1) return '(node)';
    var s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    var cls = (el.className && el.className.baseVal != null) ? el.className.baseVal : el.className;
    if (cls && typeof cls === 'string') {
      var first = cls.split(/\s+/).filter(Boolean)[0];
      if (first) s += '.' + first;
    }
    return s;
  }
  function hasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && norm(n.nodeValue)) return true;
    }
    return false;
  }
  function audit() {
    var warnings = [];
    var docEl = document.documentElement;
    var vw = docEl.clientWidth;
    var overshoot = docEl.scrollWidth - docEl.clientWidth;
    if (overshoot > TOL) {
      warnings.push({ kind: 'overflow-x', selector: '(page)',
        detail: 'Page content is ' + Math.round(overshoot) + 'px wider than the ' + vw + 'px viewport (horizontal scrollbar).' });
    }
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    var n = Math.min(all.length, MAX_NODES);
    var offCanvas = 0, clipped = 0, textBlocks = [];
    for (var i = 0; i < n; i++) {
      var el = all[i];
      if (el.closest && el.closest('[data-eh-ui]')) continue; // skip the injected annotation UI
      var cs = window.getComputedStyle(el);
      if (!visible(el, cs)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      // (2) off-canvas — element narrower than the viewport but pushed past an edge.
      if ((r.right - vw > TOL || r.left < -TOL) && r.width <= vw + 1) {
        offCanvas++;
        if (offCanvas <= 6) warnings.push({ kind: 'off-canvas', selector: shortSel(el),
          detail: 'Element extends ' + Math.round(Math.max(r.right - vw, -r.left)) + 'px past the viewport edge.' });
      }
      // (3) clipped — overflow:hidden|clip actually cutting content off. Exclude two *intentional*
      // clip patterns that legitimately leave scrollWidth/Height > client and would false-positive
      // (the ticket promotes Tailwind prototypes, so these are common):
      //   - Tailwind 'truncate' (white-space:nowrap + text-overflow:ellipsis) — a deliberate one-line
      //     ellipsis, not a layout bug; and
      //   - screen-reader-only boxes ('sr-only': a ~1px overflow:hidden box holding real text).
      var clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      var clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      var ellipsisTruncate = cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis';
      var tinyBox = el.clientWidth <= 1 || el.clientHeight <= 1;
      if (clipped < 6 && hasOwnText(el) && !tinyBox) {
        if (clipsX && !ellipsisTruncate && el.scrollWidth - el.clientWidth > TOL) {
          clipped++;
          warnings.push({ kind: 'clipped', selector: shortSel(el),
            detail: 'Text is clipped horizontally (' + Math.round(el.scrollWidth - el.clientWidth) + 'px hidden by overflow).' });
        } else if (clipsY && el.scrollHeight - el.clientHeight > TOL) {
          clipped++;
          warnings.push({ kind: 'clipped', selector: shortSel(el),
            detail: 'Text is clipped vertically (' + Math.round(el.scrollHeight - el.clientHeight) + 'px hidden by overflow).' });
        }
      }
      // Collect non-positioned text blocks for the conservative overlap pass.
      if (!positioned(cs) && hasOwnText(el) && textBlocks.length < 250) {
        textBlocks.push({ el: el, r: r });
      }
    }
    // (4) overlap — only non-positioned, text-bearing blocks that substantially cover each other.
    var overlaps = 0;
    for (var a = 0; a < textBlocks.length && overlaps < 4; a++) {
      for (var b = a + 1; b < textBlocks.length && overlaps < 4; b++) {
        var ra = textBlocks[a].r, rb = textBlocks[b].r;
        var ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        var iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ix <= 4 || iy <= 8) continue;
        // Only pay for the O(depth) ancestor check once the rects actually overlap — nesting is the
        // common reason an overlapping pair is NOT a real text-on-text collision, so test it last.
        if (textBlocks[a].el.contains(textBlocks[b].el) || textBlocks[b].el.contains(textBlocks[a].el)) continue;
        var minH = Math.min(ra.height, rb.height);
        if (minH > 0 && iy >= 0.25 * minH) {
          overlaps++;
          warnings.push({ kind: 'overlap', selector: shortSel(textBlocks[a].el) + ' × ' + shortSel(textBlocks[b].el),
            detail: 'Two text blocks overlap by ' + Math.round(ix) + '×' + Math.round(iy) + 'px (text on top of text).' });
        }
      }
    }
    return warnings;
  }
  function run() {
    var warnings;
    try { warnings = audit(); } catch (e) { warnings = []; }
    post({ ns: NS, type: 'layout-audit', ok: warnings.length === 0, warnings: warnings.slice(0, MAX_WARNINGS) });
  }
  var ran = false;
  function runOnce() { if (ran) return; ran = true; run(); }
  if (document.readyState === 'complete') { setTimeout(runOnce, 60); }
  else { window.addEventListener('load', function () { setTimeout(runOnce, 60); }); }
  try { if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(runOnce); } catch (e) {}
  setTimeout(runOnce, 1400); // hard fallback if load/fonts never settle

  // Re-audit once late async content settles. Mermaid/D2 render their SVG, the Tailwind CDN restyles,
  // and images/fonts load — all AFTER 'load'. Without this the gate measures a transient pre-render
  // layout (e.g. an un-rendered <pre class="mermaid"> that overflows) and masks the finished artifact,
  // i.e. it masks the very diagram feature this tier ships. A MutationObserver debounces a re-run until
  // the DOM stops changing, then self-disconnects after a settle window so animated/looping content
  // can't re-trigger the audit forever. The host upgrades a 'warnings' state to 'clean' on a later
  // clean re-audit, and never re-masks once the user has revealed (or we failed open to 'skipped').
  var settleTimer = null, observer = null;
  function reaudit() { ran = true; run(); }
  function bumpSettle() { if (settleTimer) clearTimeout(settleTimer); settleTimer = setTimeout(reaudit, 300); }
  function startObserver() {
    if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
    observer = new MutationObserver(bumpSettle);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    setTimeout(function () {
      if (observer) { observer.disconnect(); observer = null; }
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; reaudit(); } // capture final state once
    }, 5000);
  }
  if (document.body) startObserver();
  else window.addEventListener('DOMContentLoaded', startObserver);

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || d.ns !== NS) return;
    if (d.type === 'request-audit') { ran = true; run(); }
  });
})();
`;

/** Place a `<script>…</script>` tag just before `</body>` (so it runs after the document parses),
 * falling back to `</html>` then a plain append for fragment-ish HTML. Case-insensitive. */
function placeScriptTag(html: string, tag: string): string {
  // Function replacers so `$`-sequences inside the injected script (e.g. the annotator's `'\\$&'`
  // cssEscape fallback) are emitted verbatim — a string replacement would expand `$&` to the matched
  // close tag, silently corrupting the script. (Not a breakout — agent HTML is the subject, not the
  // replacement — but the function form removes the footgun entirely.) The match `m` is re-emitted so
  // the close tag keeps the document's original casing.
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, (m) => `${tag}${m}`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, (m) => `${tag}${m}`);
  return html + tag;
}

/**
 * Inject {@link ARTIFACT_ANNOTATOR_SCRIPT} into a served artifact document so every artifact — no
 * matter what the agent authored — gets the Tier-2 annotation channel. The stored sidecar file is
 * never modified; this is serve-time only (see the REST artifact route).
 */
export function injectAnnotatorScript(html: string): string {
  return placeScriptTag(html, `<script>${ARTIFACT_ANNOTATOR_SCRIPT}</script>`);
}

/**
 * Inject the full serve-time artifact runtime — the Tier-2 annotation channel
 * ({@link ARTIFACT_ANNOTATOR_SCRIPT}) **and** the Tier-3 layout-audit gate
 * ({@link ARTIFACT_LAYOUT_AUDIT_SCRIPT}) — into the served HTML. This is what the REST route uses;
 * the stored sidecar stays pristine. Two separate `<script>` tags so a syntax error in one runtime
 * never disables the other.
 */
export function injectArtifactScripts(html: string): string {
  const tag = `<script>${ARTIFACT_ANNOTATOR_SCRIPT}</script><script>${ARTIFACT_LAYOUT_AUDIT_SCRIPT}</script>`;
  return placeScriptTag(html, tag);
}
