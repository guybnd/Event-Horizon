import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Workflow,
  Sparkles,
  UploadCloud,
  Download,
  Upload,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { FlowEditorTab } from './FlowEditorTab';
import { FeaturesEditorTab } from './FeaturesEditorTab';
import {
  fetchOnboardingFlow,
  fetchOnboardingFeatures,
  fetchOnboardingFlowDraft,
  fetchOnboardingFeaturesDraft,
  saveOnboardingFlowDraft,
  saveOnboardingFeaturesDraft,
  publishOnboarding,
  discardOnboardingDraft,
  OnboardingPublishError,
} from '../../api';
import { FLOW, validateFlow } from '../../config/onboardingFlow';
import type { OnboardingFlowConfig } from '../../config/onboardingFlow';
import {
  FEATURE_PANELS,
  validateFeatures,
} from '../../config/onboardingFeatures';
import type { FeaturePanel, OnboardingFeaturesConfig } from '../../config/onboardingFeatures';
import { validateOnboarding } from '../../config/onboardingValidate';
import type { ValidationIssue } from '../../config/onboardingValidate';

/**
 * FLUX-759 + FLUX-763 (Phase 4) — the dev-only "Onboarding Studio" SHELL.
 *
 * Phase 4 turns the Studio from a committed-file editor into a DRAFT→PUBLISH system.
 * The shell now OWNS both tab drafts (flow + features) so Publish / Export / Import
 * operate on them together:
 *  - both drafts hydrate from the gitignored DRAFT files (engine seeds them from the
 *    committed configs on first read);
 *  - each tab's Save writes ONLY the gitignored draft — using the Studio leaves
 *    `git status` clean and never blocks `git pull` (THE HEADLINE FIX);
 *  - a single explicit PUBLISH (validated client-side, re-checked server-side) is the
 *    ONLY path that writes the committed onboardingFlow.json / onboardingFeatures.json;
 *  - an "Unpublished changes" badge diffs the live drafts against the committed
 *    snapshot so the author knows the wizard still shows the published version;
 *  - Export downloads / Import loads the WHOLE draft bundle (flow + features).
 *
 * Everything here is reachable ONLY via the import.meta.env.DEV lazy chunk (App.tsx),
 * so the whole Studio — shell, tabs, preview, validator, draft/publish api fns — is
 * dead-code-eliminated from the production bundle. The wizard keeps statically
 * importing only the committed JSON, so drafts never enter the prod bundle.
 */

type StudioTab = 'flow' | 'features';

const FEATURES_VERSION = 1;

/** Export-bundle shape — flow + features travel together so a round-trip is lossless. */
interface OnboardingBundle {
  kind: 'onboarding-bundle';
  version: 1;
  exportedAt: string;
  flow: OnboardingFlowConfig;
  features: OnboardingFeaturesConfig;
}

export function OnboardingStudioScreen() {
  const [tab, setTab] = useState<StudioTab>('flow');

  // ── Lifted drafts (the shell owns both so Publish/Export/Import act on them). ──
  const [flowDraft, setFlowDraft] = useState<OnboardingFlowConfig>(FLOW);
  const [featuresDraft, setFeaturesDraft] = useState<FeaturePanel[]>(FEATURE_PANELS);
  const [loading, setLoading] = useState(true);

  // ── Committed snapshot — the published baseline for the unpublished-diff badge. ──
  const [committedFlow, setCommittedFlow] = useState<OnboardingFlowConfig | null>(null);
  const [committedFeatures, setCommittedFeatures] = useState<FeaturePanel[] | null>(null);

  // ── Publish flow state. ──
  const [publishing, setPublishing] = useState(false);
  const [confirm, setConfirm] = useState<{
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  } | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Hydrate BOTH drafts from the draft GET (engine seeds from committed on first read),
  // plus the committed snapshot for the unpublished-diff badge.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      fetchOnboardingFlowDraft(),
      fetchOnboardingFeaturesDraft(),
      fetchOnboardingFlow(),
      fetchOnboardingFeatures(),
    ])
      .then(([flowD, featD, flowC, featC]) => {
        if (cancelled) return;
        if (flowD.status === 'fulfilled') setFlowDraft(validateFlow(flowD.value));
        if (featD.status === 'fulfilled') {
          const v = validateFeatures(featD.value);
          setFeaturesDraft(v.length ? v : FEATURE_PANELS);
        }
        if (flowC.status === 'fulfilled') setCommittedFlow(validateFlow(flowC.value));
        if (featC.status === 'fulfilled') {
          const v = validateFeatures(featC.value);
          setCommittedFeatures(v.length ? v : FEATURE_PANELS);
        }
        if (flowD.status === 'rejected' || featD.status === 'rejected') {
          setBanner({ kind: 'error', text: 'Could not load drafts from the engine — showing the shipped seed.' });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The features config wrapper the validator/publish surface expect.
  const featuresConfig = useMemo<OnboardingFeaturesConfig>(
    () => ({ version: FEATURES_VERSION, features: featuresDraft }),
    [featuresDraft],
  );

  // Unpublished-diff: drafts differ from the committed snapshot.
  const hasUnpublished = useMemo(() => {
    if (!committedFlow || !committedFeatures) return false;
    const flowDiff = JSON.stringify(flowDraft) !== JSON.stringify(committedFlow);
    const featDiff = JSON.stringify(featuresDraft) !== JSON.stringify(committedFeatures);
    return flowDiff || featDiff;
  }, [flowDraft, featuresDraft, committedFlow, committedFeatures]);

  // ── Publish ────────────────────────────────────────────────────────────────────
  function openPublishConfirm() {
    setBanner(null);
    const { errors, warnings } = validateOnboarding(validateFlow(flowDraft), featuresConfig);
    setConfirm({ errors, warnings });
  }

  async function doPublish() {
    setPublishing(true);
    setBanner(null);
    try {
      const result = await publishOnboarding();
      // Refresh the committed snapshot so the badge clears.
      const [flowC, featC] = await Promise.allSettled([
        fetchOnboardingFlow(),
        fetchOnboardingFeatures(),
      ]);
      if (flowC.status === 'fulfilled') setCommittedFlow(validateFlow(flowC.value));
      if (featC.status === 'fulfilled') {
        const v = validateFeatures(featC.value);
        setCommittedFeatures(v.length ? v : FEATURE_PANELS);
      }
      setConfirm(null);
      setBanner({
        kind: 'ok',
        text: result.warnings.length
          ? `Published to the committed config — with ${result.warnings.length} warning(s).`
          : 'Published to the committed config. The wizard now shows these changes.',
      });
    } catch (err) {
      if (err instanceof OnboardingPublishError) {
        // The server backstop blocked publish — surface its errors in the confirm panel.
        setConfirm((prev) => ({ errors: err.errors, warnings: prev?.warnings ?? [] }));
        setBanner({ kind: 'error', text: 'Publish blocked by the engine — fix the errors and retry.' });
      } else {
        setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Publish failed.' });
      }
    } finally {
      setPublishing(false);
    }
  }

  // ── Discard (revert drafts to committed) ─────────────────────────────────────────
  async function doDiscard() {
    setBanner(null);
    try {
      const { flow, features } = await discardOnboardingDraft();
      setFlowDraft(validateFlow(flow));
      const v = validateFeatures(features);
      setFeaturesDraft(v.length ? v : FEATURE_PANELS);
      setBanner({ kind: 'ok', text: 'Discarded unpublished edits — drafts reset to the published config.' });
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Discard failed.' });
    }
  }

  // ── Export (client-only — no engine round-trip) ──────────────────────────────────
  function doExport() {
    const bundle: OnboardingBundle = {
      kind: 'onboarding-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      flow: validateFlow(flowDraft),
      features: featuresConfig,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `onboarding-bundle-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setBanner({ kind: 'ok', text: 'Exported the current draft bundle (flow + features).' });
  }

  // ── Import (client parse + existing normalizers → both drafts + persist) ──────────
  async function doImport(file: File) {
    setBanner(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setBanner({ kind: 'error', text: 'Import failed — the file is not valid JSON.' });
      return;
    }

    // Sniff the shape by key:
    //  - bundle ({ kind, flow, features }): take obj.flow + obj.features;
    //  - bare flow ({ version, pages }): the object IS the flow;
    //  - bare features ({ version, features }): the object IS the features config.
    // A missing side keeps the current draft for that side.
    const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const isBundle = 'flow' in obj;
    const rawFlow = isBundle ? obj.flow : 'pages' in obj ? obj : undefined;
    const rawFeatures = isBundle ? obj.features : 'features' in obj ? obj : undefined;

    let nextFlow = flowDraft;
    let nextFeatures = featuresDraft;
    let touchedFlow = false;
    let touchedFeatures = false;

    if (rawFlow !== undefined) {
      // validateFlow never throws and is idempotent — self-heals hand-edited JSON.
      nextFlow = validateFlow(rawFlow);
      touchedFlow = true;
    }
    if (rawFeatures !== undefined) {
      const v = validateFeatures(rawFeatures);
      nextFeatures = v.length ? v : featuresDraft;
      touchedFeatures = true;
    }

    if (!touchedFlow && !touchedFeatures) {
      setBanner({ kind: 'error', text: 'Import failed — no recognizable flow or features in the file.' });
      return;
    }

    setFlowDraft(nextFlow);
    setFeaturesDraft(nextFeatures);

    // Persist to the draft files so a reload keeps the import (Import lands in the DRAFT,
    // NEVER committed — a bad import can never dirty/commit anything).
    try {
      const writes: Promise<unknown>[] = [];
      if (touchedFlow) writes.push(saveOnboardingFlowDraft(nextFlow));
      if (touchedFeatures) {
        writes.push(saveOnboardingFeaturesDraft({ version: FEATURES_VERSION, features: nextFeatures }));
      }
      await Promise.all(writes);
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Imported, but saving the draft failed.' });
      return;
    }

    // Surface validation immediately so the author sees errors/warnings before Publish.
    const { errors, warnings } = validateOnboarding(nextFlow, { version: FEATURES_VERSION, features: nextFeatures });
    if (errors.length || warnings.length) {
      setConfirm({ errors, warnings });
    }
    setBanner({
      kind: 'ok',
      text: `Imported into the draft${errors.length ? ` — ${errors.length} error(s) must be fixed before Publish` : ''}.`,
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Shell toolbar — spans BOTH tabs. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold tracking-tight">Onboarding Studio</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-400">
            dev only
          </span>
        </div>
        {hasUnpublished && (
          <span
            title="Your draft edits are saved but not yet published — the real onboarding wizard still shows the published version. Click Publish to write the committed config."
            className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
          >
            <AlertTriangle className="h-3 w-3" /> Unpublished changes
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void doImport(file);
              e.target.value = ''; // allow re-importing the same file
            }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            <Upload className="h-4 w-4" /> Import
          </button>
          <button
            onClick={doExport}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            <Download className="h-4 w-4" /> Export
          </button>
          {hasUnpublished && (
            <button
              onClick={doDiscard}
              title="Revert unpublished edits — reset both drafts to the published config."
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
            >
              <RotateCcw className="h-4 w-4" /> Discard
            </button>
          )}
          <button
            onClick={openPublishConfirm}
            disabled={publishing || loading}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            <UploadCloud className="h-4 w-4" /> {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
            banner.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300'
          }`}
        >
          {banner.kind === 'ok' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          <span className="flex-1">{banner.text}</span>
          <button onClick={() => setBanner(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-gray-200 dark:border-white/10">
        <TabButton active={tab === 'flow'} onClick={() => setTab('flow')} icon={<Workflow className="h-4 w-4" />}>
          Flow
        </TabButton>
        <TabButton active={tab === 'features'} onClick={() => setTab('features')} icon={<Sparkles className="h-4 w-4" />}>
          Features
        </TabButton>
      </div>

      {/* Active tab — both stay MOUNTED (hidden when inactive) so each keeps its own
          per-tab Save/dirty state while the shell owns the shared draft. */}
      <div className="min-h-0 flex-1">
        <div className={tab === 'flow' ? 'h-full' : 'hidden'}>
          <FlowEditorTab draft={flowDraft} setDraft={setFlowDraft} loading={loading} />
        </div>
        <div className={tab === 'features' ? 'h-full' : 'hidden'}>
          <FeaturesEditorTab draft={featuresDraft} setDraft={setFeaturesDraft} loading={loading} />
        </div>
      </div>

      {confirm && (
        <PublishConfirm
          errors={confirm.errors}
          warnings={confirm.warnings}
          publishing={publishing}
          onCancel={() => setConfirm(null)}
          onConfirm={doPublish}
        />
      )}
    </div>
  );
}

/**
 * The Publish confirmation modal — lists blocking errors (red, disable Publish) and
 * non-blocking warnings (amber, "Publish anyway"). Reuses the Studio's toast palette.
 */
function PublishConfirm({
  errors,
  warnings,
  publishing,
  onCancel,
  onConfirm,
}: {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  publishing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const blocked = errors.length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-bg-dark">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <UploadCloud className="h-5 w-5 text-primary" />
          <h2 className="text-base font-bold tracking-tight">Publish onboarding config</h2>
          <button onClick={onCancel} aria-label="Close" className="ml-auto rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!blocked && warnings.length === 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              No issues found. Publishing writes the committed onboardingFlow.json and
              onboardingFeatures.json — a deliberate, reviewed change.
            </p>
          )}

          {blocked && (
            <div className="mb-3">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                <AlertTriangle className="h-3.5 w-3.5" /> Errors — must fix before publishing
              </h3>
              <ul className="flex flex-col gap-1.5">
                {errors.map((e, i) => (
                  <li
                    key={i}
                    className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-400/10 dark:text-rose-300"
                  >
                    {e.message}
                    {e.pageId && <span className="ml-1 font-mono opacity-70">({e.pageId})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div>
              <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" /> Warnings — you can publish anyway
              </h3>
              <ul className="flex flex-col gap-1.5">
                {warnings.map((w, i) => (
                  <li
                    key={i}
                    className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
                  >
                    {w.message}
                    {w.pageId && <span className="ml-1 font-mono opacity-70">({w.pageId})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-white/10">
          <button
            onClick={onCancel}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={blocked || publishing}
            title={blocked ? 'Fix the errors above to enable Publish.' : undefined}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {publishing ? 'Publishing…' : warnings.length ? 'Publish anyway' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
