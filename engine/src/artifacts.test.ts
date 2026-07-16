import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import {
  ARTIFACT_CSP,
  ARTIFACT_ANNOTATOR_SCRIPT,
  ARTIFACT_LAYOUT_AUDIT_SCRIPT,
  injectAnnotatorScript,
  injectArtifactScripts,
  isSafeTicketId,
  parseRevParam,
  writeArtifactRevision,
  readArtifactRevision,
  listArtifactRevisionsOnDisk,
  getArtifactFilePath,
} from './artifacts.js';

/**
 * FLUX-873 (Tier 1) — grooming-artifact storage. Locks the security-critical parsing
 * (rev / ticket-id guards), the revision-keeping invariant (every publish is a NEW revision,
 * never an overwrite), and latest-resolution incl. pointer-drift fallback.
 */
describe('grooming artifacts (FLUX-873)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-artifacts-'));
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  describe('parseRevParam', () => {
    it('treats missing / empty / "latest" as the latest sentinel', () => {
      expect(parseRevParam(undefined)).toBe('latest');
      expect(parseRevParam('')).toBe('latest');
      expect(parseRevParam('latest')).toBe('latest');
    });
    it('accepts positive integers', () => {
      expect(parseRevParam('1')).toBe(1);
      expect(parseRevParam('42')).toBe(42);
      expect(parseRevParam(3)).toBe(3);
    });
    it('rejects zero, negatives, and non-integers', () => {
      expect(parseRevParam('0')).toBeNull();
      expect(parseRevParam('-1')).toBeNull();
      expect(parseRevParam('1.5')).toBeNull();
      expect(parseRevParam('abc')).toBeNull();
      expect(parseRevParam('1; rm -rf')).toBeNull();
    });
  });

  describe('isSafeTicketId', () => {
    it('accepts normal ticket ids', () => {
      expect(isSafeTicketId('FLUX-873')).toBe(true);
      expect(isSafeTicketId('PROJ_1.2-3')).toBe(true);
    });
    it('rejects traversal / separators / empties', () => {
      expect(isSafeTicketId('..')).toBe(false);
      expect(isSafeTicketId('.')).toBe(false);
      expect(isSafeTicketId('a/b')).toBe(false);
      expect(isSafeTicketId('a\\b')).toBe(false);
      expect(isSafeTicketId('../etc/passwd')).toBe(false);
      expect(isSafeTicketId('')).toBe(false);
      expect(isSafeTicketId(42)).toBe(false);
    });
  });

  it('ARTIFACT_CSP locks down the dangerous surfaces', () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).toContain("frame-ancestors 'self'");
    expect(ARTIFACT_CSP).toContain("form-action 'none'");
    expect(ARTIFACT_CSP).toContain("base-uri 'none'");
  });

  it('keeps history: each publish is a new revision, never an overwrite', async () => {
    const id = 'FLUX-873';
    const a = await writeArtifactRevision(id, '<h1>rev one</h1>', { title: 'First' }, undefined);
    expect(a.rev).toBe(1);
    expect(a.pointer.latest).toBe(1);

    const b = await writeArtifactRevision(id, '<h1>rev two</h1>', { note: 'changed' }, a.pointer);
    expect(b.rev).toBe(2);
    expect(b.pointer.latest).toBe(2);
    expect(b.pointer.revisions.map((r) => r.rev)).toEqual([1, 2]);

    // Both files still on disk — rev 1 is not destroyed.
    expect(await listArtifactRevisionsOnDisk(id)).toEqual([1, 2]);
    const rev1 = await fs.readFile(getArtifactFilePath(id, 1), 'utf-8');
    expect(rev1).toBe('<h1>rev one</h1>');
  });

  it('reads a specific revision and resolves "latest"', async () => {
    const id = 'FLUX-873';
    const a = await writeArtifactRevision(id, '<p>one</p>', {}, undefined);
    const b = await writeArtifactRevision(id, '<p>two</p>', {}, a.pointer);

    const r1 = await readArtifactRevision(id, 1, b.pointer);
    expect(r1).toEqual({ rev: 1, html: '<p>one</p>' });

    const latest = await readArtifactRevision(id, 'latest', b.pointer);
    expect(latest).toEqual({ rev: 2, html: '<p>two</p>' });
  });

  it('falls back to the newest file on disk when the pointer points at a missing revision', async () => {
    const id = 'FLUX-873';
    const a = await writeArtifactRevision(id, '<p>one</p>', {}, undefined);
    const b = await writeArtifactRevision(id, '<p>two</p>', {}, a.pointer);
    // Simulate a pointer that claims rev 3 exists when only 1 and 2 are on disk.
    const driftedPointer = { latest: 3, revisions: b.pointer.revisions };

    const latest = await readArtifactRevision(id, 'latest', driftedPointer);
    expect(latest).toEqual({ rev: 2, html: '<p>two</p>' });
  });

  it('returns null for an absent revision / unsafe id', async () => {
    expect(await readArtifactRevision('FLUX-999', 7, undefined)).toBeNull();
    expect(await readArtifactRevision('../escape', 'latest', undefined)).toBeNull();
    await expect(writeArtifactRevision('../escape', '<h1>x</h1>', {}, undefined)).rejects.toThrow();
  });

  // FLUX-874 (Tier 2): the annotation/anchor-capture script is injected at serve time.
  describe('injectAnnotatorScript (FLUX-874)', () => {
    it('injects the capture script just before </body>', () => {
      const out = injectAnnotatorScript('<html><body><h1>hi</h1></body></html>');
      expect(out).toContain('<script>');
      expect(out).toContain("ns: NS, type: 'ready'");
      // Script lands inside the body, before its close tag.
      expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</body>'));
      expect(out).toContain('<h1>hi</h1>');
    });

    it('falls back to </html> then plain append for fragment-ish HTML', () => {
      expect(injectAnnotatorScript('<html><h1>no body</h1></html>')).toMatch(/<\/script><\/html>$/);
      expect(injectAnnotatorScript('<h1>bare fragment</h1>')).toMatch(/<h1>bare fragment<\/h1><script>/);
    });

    it('is case-insensitive about the closing body tag', () => {
      const out = injectAnnotatorScript('<HTML><BODY>X</BODY></HTML>');
      expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</BODY>'));
    });

    it('emits the regexes/backslashes verbatim (String.raw guard) and never a nested </script>', () => {
      // A literal </script> in the payload would prematurely close the injected tag.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).not.toContain('</script>');
      // String.raw must have preserved the whitespace-normalizing regex (would be mangled to \s→s
      // if a plain template literal had processed the escape).
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('\\s+');
      // The postMessage trust contract markers the host validates against: ready + the batch send.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("type: 'ready'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("type: 'annotations'");
    });

    it('tags its injected UI so the layout audit skips it', () => {
      // All injected nodes carry data-eh-ui; the audit skips [data-eh-ui], the composer ignores
      // selections inside itself.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('data-eh-ui');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain("closest('[data-eh-ui]')");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('annotations.push');
    });

    // FLUX-1362: the host owns the unified list — the iframe mirrors the set LIVE (on every add/edit/
    // remove, each item carrying its pin id) instead of a one-shot Send tray, and accepts host→iframe
    // pin edits/removals for reverse-sync.
    it('mirrors annotations live (with ids) and accepts host→iframe remove/update — no tray/Send', () => {
      // Live mirror on every change via a single post helper; each item carries its stable pin id.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function postLive');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('id: a.id');
      // Add / edit / remove all re-post the current set.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function addAnnotation');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function updateAnnotation');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function removeAnnotation');
      // Host→iframe reverse-sync handlers.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("d.type === 'remove-pin'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("d.type === 'update-pin'");
      // The in-iframe tray + Send button are gone (management moved host-side).
      expect(ARTIFACT_ANNOTATOR_SCRIPT).not.toContain('function sendBatch');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).not.toContain('function renderTray');
      // Clicking a pin re-opens the composer to edit (never a bare delete).
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('existingId');
    });

    // FLUX-892: right-click element picking for non-text controls (toggles, SVG bars, buttons).
    it('wires a contextmenu element-picker path (preventDefault + cssPath + kind/label) alongside the text path', () => {
      // The right-click path: a contextmenu listener that suppresses the native menu and anchors via cssPath.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("addEventListener('contextmenu'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('preventDefault');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function elementInfo');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('cssPath(target)');
      // The kind/label discriminator is threaded through capture → tray → batch send.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("kind: 'element'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("kind: 'text'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('label:');
      // The zero-footprint active highlight (fixed + pointer-events:none + data-eh-ui).
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function drawHighlight');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('eh-anno-highlight');
      // The original text-selection path is still present (byte-for-byte unchanged behavior).
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("addEventListener('mouseup'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function selectionInfo');
    });

    // FLUX-1314: focus lives in-iframe once the user clicks the artifact, so the host's window
    // listener never sees the Escape keydown — the annotator must forward it up.
    it('forwards Escape to the host, closing its own composer first (FLUX-1314)', () => {
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("addEventListener('keydown'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("type: 'escape'");
      // Nearest overlay first: an open composer is closed locally and the press is NOT forwarded;
      // only a composer-less Escape reaches the host (which then pops its own LIFO stack).
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('if (composer) { clearComposer(); return; }');
    });

    // FLUX-1440: declarative data-eh-feel / data-eh-decision markup upgrades into guided controls
    // that auto-stage an annotation on interaction, via the SAME annotations[]/postLive() transport.
    it('wires the guided-controls upgrader (data-eh-feel / data-eh-decision) into the same transport', () => {
      // Both selectors are queried — the upgraders no-op cleanly when neither is present.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("querySelectorAll('[data-eh-feel]')");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("querySelectorAll('[data-eh-decision]')");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function upgradeGuidedControls');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function upgradeFeelControls');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function upgradeDecisionControls');
      // Guided interactions stage into the SAME array/transport — no second message channel.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function stageGuided');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("stageGuided(host, 'feel'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("stageGuided(host, 'decision'");
      // Restaging in place keys off a stable per-control annotation id, not a fresh push each time.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('data-eh-anno-id');
    });

    // FLUX-1440: raw right-click on a slider/input previously carried no value — elementInfo() now
    // captures .value (or an opt-in data-eh-value) and threads it through add/update/live-mirror.
    it('captures a control value (.value or data-eh-value) and threads it through the annotation record', () => {
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('function readValue');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('data-eh-value');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('value: readValue(target)');
      // Threaded into the pushed annotation record and the live-mirrored item shape.
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('value: info.value');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('value: a.value');
    });

    // FLUX-1440: the host learns up front (a single boolean on the existing 'ready' post, not a new
    // message type) whether this artifact has any guided controls to render chrome around.
    it('signals hasGuidedControls as a single boolean on the existing ready post', () => {
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain("type: 'ready'");
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain('hasGuidedControls: hasGuidedControls');
      expect(ARTIFACT_ANNOTATOR_SCRIPT).toContain(
        "querySelectorAll('[data-eh-feel],[data-eh-decision]')"
      );
      // Still one, single ready post — no new message type/channel introduced for this signal.
      expect((ARTIFACT_ANNOTATOR_SCRIPT.match(/type: 'ready'/g) || []).length).toBe(1);
    });
  });

  // FLUX-875 (Tier 3): the open-time layout-audit gate is injected alongside the annotator.
  describe('layout-audit gate (FLUX-875)', () => {
    it('audit script posts the layout-audit message and never closes the injected tag', () => {
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).not.toContain('</script>');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain("type: 'layout-audit'");
      // String.raw guard — the whitespace-normalizing regex must survive verbatim.
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('\\s+');
      // The four conservative checks the gate runs.
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('overflow-x');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('off-canvas');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('clipped');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('overlap');
      // Re-run hook for the host's request-audit.
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain("type === 'request-audit'");
    });

    it('excludes intentional clipping (Tailwind truncate / sr-only) from the clipped check', () => {
      // truncate = white-space:nowrap + text-overflow:ellipsis; sr-only = a ~1px overflow:hidden box.
      // Both legitimately leave scrollWidth/Height > client and must NOT trip the gate.
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain("cs.whiteSpace === 'nowrap'");
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain("cs.textOverflow === 'ellipsis'");
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('ellipsisTruncate');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('tinyBox');
    });

    it('re-audits after late async content (Mermaid/Tailwind) settles via a MutationObserver', () => {
      // The audit must not be a one-shot at load+60ms — Mermaid/D2 render their SVG after 'load', so a
      // debounced, self-disconnecting MutationObserver re-runs it once the DOM stops changing.
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('MutationObserver');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('observer.disconnect()');
      expect(ARTIFACT_LAYOUT_AUDIT_SCRIPT).toContain('function reaudit');
    });

    it('injectArtifactScripts injects BOTH the annotator and the audit runtimes before </body>', () => {
      const out = injectArtifactScripts('<html><body><h1>hi</h1></body></html>');
      expect(out).toContain("ns: NS, type: 'ready'");        // annotator present
      expect(out).toContain("type: 'layout-audit'");          // audit present
      expect(out).toContain('<h1>hi</h1>');
      // Two separate tags so one runtime's syntax error can't disable the other.
      expect((out.match(/<script>/g) || []).length).toBe(2);
      expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</body>'));
    });

    it('injectArtifactScripts falls back to </html> then plain append for fragment-ish HTML', () => {
      expect(injectArtifactScripts('<html><h1>no body</h1></html>')).toMatch(/<\/script><\/html>$/);
      expect(injectArtifactScripts('<h1>bare</h1>')).toMatch(/<h1>bare<\/h1><script>/);
    });
  });
});
