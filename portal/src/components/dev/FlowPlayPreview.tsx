import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { resolveFeatureIcon } from '../../config/featureIcons';
import { FEATURE_PANELS } from '../../config/onboardingFeatures';
import { OnboardingContentPage } from '../onboarding/OnboardingContentPage';
import { validateFlow, evaluatePageVisible } from '../../config/onboardingFlow';
import type {
  OnboardingFlowConfig,
  OnboardingPage,
  ConditionContext,
} from '../../config/onboardingFlow';

/**
 * The neutral preview context — every condition PASSES (all pages visible) so the
 * author always SEES every page in the preview even when a condition would hide it
 * in real onboarding. A condition-skipped page is then MARKED (banner) rather than
 * dropped. Toggling the row below lets the author simulate a specific ctx.
 */
const NEUTRAL_CTX: ConditionContext = {
  storageMode: 'in-repo',
  assistant: 'claude',
  platform: 'win',
  workspaceConfigured: true,
};

/**
 * FLUX-759 — the Onboarding Studio's PLAY preview pane.
 *
 * SHARED RENDERER (FLUX-760): the content-page body is rendered through the SHARED
 * OnboardingContentPage (the SAME component the real wizard uses), so the preview is
 * pixel-identical to production by construction — there is no longer a verbatim copy
 * to drift. The earlier FLUX-758 "MUST NOT import OnboardingWizard" constraint is moot
 * post-merge: the shared render markup lives in OnboardingContentPage, not in the
 * wizard, so importing it is the correct single-source path. The preview still owns its
 * own StepDots replica and the SystemSandboxCard sandbox boundary (below).
 *
 * SANDBOX GUARANTEE (the safety boundary): widget/system pages are rendered as
 * INERT labeled sandbox cards — pure markup that mounts NO widget renderer and
 * fires NO real onboarding side effect (no folder pick, no skill install, no
 * storage migration, no setWorkspace / completion). Content-page CTAs are no-ops.
 * Because OnboardingWizard is never imported and the cards are markup-only, the
 * dev preview PHYSICALLY CANNOT trigger a real onboarding side effect on the
 * user's workspace. The whole file is reachable ONLY through the
 * import.meta.env.DEV Studio lazy chunk, so it is stripped from the prod bundle.
 */

type PreviewTheme = 'light' | 'dark';
type PreviewWidth = 'narrow' | 'default' | 'wide';

const WIDTH_CLASS: Record<PreviewWidth, string> = {
  narrow: 'max-w-sm',
  default: 'max-w-lg',
  wide: 'max-w-2xl',
};

/**
 * The PLAY preview: walks the (validated) draft flow Next/Back over a local cursor.
 * The flow is run through validateFlow so the preview reflects the enforced/
 * normalized order (reorders/edits show optimistically). `version` is unused at
 * render time but carried so the prop shape matches the persisted config.
 */
export function FlowPlayPreview({ draft }: { draft: OnboardingFlowConfig }) {
  const [cursor, setCursor] = useState(0);
  const [theme, setTheme] = useState<PreviewTheme>('light');
  const [width, setWidth] = useState<PreviewWidth>('default');
  // The author-driven condition context. Defaults to a neutral all-visible ctx so
  // every page is shown; toggling it simulates a specific runtime (e.g. orphan
  // storage) to see which conditioned pages would drop in real onboarding.
  const [ctx, setCtx] = useState<ConditionContext>(NEUTRAL_CTX);

  // Run the draft through validateFlow so the previewed order matches what the
  // real wizard would render (SYSTEM_PAGE_SPECS merged, required re-injected,
  // canonical order re-derived). Edits/reorders flow through optimistically.
  const flow = useMemo(() => validateFlow(draft), [draft]);
  const pages = flow.pages;

  // Clamp the cursor whenever the page count shrinks (e.g. a content page removed).
  const total = pages.length;
  const index = Math.min(cursor, Math.max(0, total - 1));
  const page: OnboardingPage | undefined = pages[index];

  const atFirst = index <= 0;
  const atLast = index >= total - 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Walker + theme/width controls */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="inline-flex items-center gap-1.5">
          <button
            onClick={() => setCursor((c) => Math.max(0, Math.min(c, total - 1) - 1))}
            disabled={atFirst}
            className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Back
          </button>
          <button
            onClick={() => setCursor((c) => Math.min(total - 1, Math.min(c, total - 1) + 1))}
            disabled={atLast}
            className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Page jump-list (by id) for convenience. */}
        <label className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-gray-300">
          Page
          <select
            value={index}
            onChange={(e) => setCursor(Number(e.target.value))}
            className="max-w-[12rem] rounded-md border border-gray-200 bg-white px-2 py-1 dark:border-white/10 dark:bg-white/5"
          >
            {pages.map((p, i) => (
              <option key={p.id} value={i}>
                {i + 1}. {p.id}
                {p.kind === 'widget' ? ' (system)' : ''}
              </option>
            ))}
          </select>
        </label>

        <span className="text-gray-400 dark:text-gray-500">
          {total > 0 ? `${index + 1} / ${total}` : '0 / 0'}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-white/10">
            {(['light', 'dark'] as PreviewTheme[]).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`px-2.5 py-1 font-medium capitalize transition-colors ${
                  theme === t ? 'bg-primary text-white' : 'bg-white text-gray-600 dark:bg-white/5 dark:text-gray-300'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-white/10">
            {(['narrow', 'default', 'wide'] as PreviewWidth[]).map((w) => (
              <button
                key={w}
                onClick={() => setWidth(w)}
                className={`px-2.5 py-1 font-medium capitalize transition-colors ${
                  width === w ? 'bg-primary text-white' : 'bg-white text-gray-600 dark:bg-white/5 dark:text-gray-300'
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Condition context toggles — simulate the runtime ctx so the author can see
          which conditioned pages would drop in real onboarding. Defaults all-visible. */}
      <CtxToggleRow ctx={ctx} onChange={setCtx} />

      {/* Play surface */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-gray-200 dark:border-white/10">
        <div className={theme === 'dark' ? 'dark' : ''}>
          {/* min-h-full (not min-h-screen) so it fits the preview pane — mirrors the old PreviewFrame. */}
          <div className="flex min-h-full items-center justify-center bg-gray-50 p-8 dark:bg-bg-dark">
            <div className={`w-full ${WIDTH_CLASS[width]}`}>
              {/* StepDots replica — current = cursor+1, total = pages.length, so the dot
                  count tracks the edited flow live (inserted/removed content pages included). */}
              <StepDots current={index + 1} total={total} />

              {page ? (
                <div>
                  {page.hidden && (
                    <div className="mb-4 rounded-lg bg-violet-100 px-3 py-1.5 text-center text-[11px] font-semibold text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
                      (hidden — Phase 4: not shown in real onboarding)
                    </div>
                  )}
                  {/* Condition-skipped marker: a page whose conditions FAIL for the
                      current ctx would not appear in real onboarding. We still SHOW it
                      here (neutral/toggled ctx) but flag it so the author understands. */}
                  {!page.hidden && !evaluatePageVisible(page, ctx) && (
                    <div className="mb-4 rounded-lg bg-amber-100 px-3 py-1.5 text-center text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
                      (condition-skipped — not shown for the current preview context)
                    </div>
                  )}
                  {page.kind === 'widget'
                    ? <SystemSandboxCard page={page} />
                    : (
                      <div>
                        {/* SHARED renderer — pixel-identical to the real wizard. CTAs are
                            INERT in preview (no-op onCta); navigation is Back/Next only. */}
                        <OnboardingContentPage page={page} features={FEATURE_PANELS} onCta={() => {}} />
                        <p className="mt-4 text-center text-[11px] text-gray-400 dark:text-gray-500">
                          (no-op in preview — buttons don't fire actions)
                        </p>
                      </div>
                    )}
                </div>
              ) : (
                <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                  No pages to preview.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The condition-context toggle row — lets the author simulate the runtime ctx
 * (storageMode / assistant / platform / workspaceConfigured) the wizard derives from
 * its live state, so a page conditioned on e.g. storageMode==='orphan' can be SEEN
 * flagged as condition-skipped under a different ctx. Defaults to the neutral
 * all-visible ctx (NEUTRAL_CTX) so nothing is hidden until the author opts in.
 */
function CtxToggleRow({
  ctx,
  onChange,
}: {
  ctx: ConditionContext;
  onChange: (next: ConditionContext) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-[11px] dark:border-white/10 dark:bg-white/[0.02]">
      <span className="font-semibold uppercase tracking-wide text-gray-400">Condition ctx</span>

      <label className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-gray-300">
        storageMode
        <select
          value={ctx.storageMode}
          onChange={(e) => onChange({ ...ctx, storageMode: e.target.value as ConditionContext['storageMode'] })}
          className="rounded-md border border-gray-200 bg-white px-1.5 py-0.5 dark:border-white/10 dark:bg-white/5"
        >
          <option value="in-repo">in-repo</option>
          <option value="orphan">orphan</option>
        </select>
      </label>

      <label className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-gray-300">
        assistant
        <select
          value={ctx.assistant}
          onChange={(e) => onChange({ ...ctx, assistant: e.target.value })}
          className="rounded-md border border-gray-200 bg-white px-1.5 py-0.5 dark:border-white/10 dark:bg-white/5"
        >
          {['claude', 'copilot', 'cursor', 'cline', 'windsurf', 'gemini', 'generic'].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-gray-300">
        platform
        <select
          value={ctx.platform}
          onChange={(e) => onChange({ ...ctx, platform: e.target.value })}
          className="rounded-md border border-gray-200 bg-white px-1.5 py-0.5 dark:border-white/10 dark:bg-white/5"
        >
          {['win', 'mac', 'linux'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-gray-300">
        <input
          type="checkbox"
          checked={ctx.workspaceConfigured}
          onChange={(e) => onChange({ ...ctx, workspaceConfigured: e.target.checked })}
          className="rounded border-gray-300"
        />
        workspaceConfigured
      </label>
    </div>
  );
}

/** StepDots — reimplemented inline from OnboardingWizard.tsx:39-56 (do NOT import the wizard's). */
function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`block rounded-full transition-all ${
            i + 1 === current
              ? 'w-6 h-2 bg-primary'
              : i + 1 < current
              ? 'w-2 h-2 bg-primary/40'
              : 'w-2 h-2 bg-gray-200 dark:bg-white/15'
          }`}
        />
      ))}
    </div>
  );
}

/**
 * SystemSandboxCard — the safety boundary. A widget/system page is rendered
 * EXCLUSIVELY as this inert, visually-distinct (dashed border + amber tint) card.
 * It imports NO WIDGET_RENDERERS registry, mounts NO widget component, and calls
 * NONE of the real onboarding side-effect functions (no folder pick, no skill
 * install, no storage migration, no setWorkspace/notifyWorkspaceSet, no
 * complete()/completion). Pure presentational markup — that is the structural
 * guarantee the dev preview can never mutate the user's real workspace.
 */
function SystemSandboxCard({ page }: { page: OnboardingPage }) {
  const Icon = resolveFeatureIcon(page.icon ?? 'Sparkles');
  return (
    <div className="rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50 p-6 dark:border-amber-400/40 dark:bg-amber-400/[0.07]">
      <div className="mb-4 flex flex-col items-center gap-3 text-center">
        <div className="flex items-center justify-center rounded-2xl bg-amber-100 p-4 dark:bg-amber-400/15">
          <Icon className="h-8 w-8 text-amber-600 dark:text-amber-400" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          {page.title}
        </h1>
        {page.subtitle && (
          <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">{page.subtitle}</p>
        )}
      </div>

      {/* The literal sandbox banner — monospace, names the widget. */}
      <div className="mb-4 rounded-lg bg-amber-100 px-3 py-2 text-center font-mono text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">
        [system step: {page.widget} — runs live in real onboarding]
      </div>

      {/* DISABLED Continue — pure markup, fires nothing. */}
      <button
        type="button"
        disabled
        className="flex h-11 w-full cursor-not-allowed items-center justify-center rounded-2xl bg-amber-500/70 px-6 text-sm font-semibold text-white opacity-70 shadow-sm"
      >
        Continue →
      </button>

      <p className="mt-3 text-center text-[11px] text-amber-700/80 dark:text-amber-300/70">
        Sandbox — this system step is mounted as inert markup; no side effects run in preview.
      </p>
    </div>
  );
}
