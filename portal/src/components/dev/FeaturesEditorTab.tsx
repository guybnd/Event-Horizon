import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, Save, RotateCcw, Sparkles } from 'lucide-react';
import type { FeaturePanel, OnboardingFeaturesConfig } from '../../config/onboardingFeatures';
import { validateFeatures } from '../../config/onboardingFeatures';
import { FeatureHighlights } from '../onboarding/FeatureHighlights';
import { saveOnboardingFeaturesDraft, fetchOnboardingFeaturesDraft } from '../../api';
import { IconGlyph, IconPicker, FALLBACK_ICON_NAME } from './IconPicker';
import { ImageUploadField } from './ImageUploadField';

/**
 * The Features tab of the Onboarding Studio (FLUX-759) — the dev-only editor for
 * the onboarding wizard's "What you can do" feature panels, EXTRACTED VERBATIM
 * from the former OnboardingEditorScreen (FLUX-755). Behavior is byte-identical:
 * the same draft/save lifecycle, dnd-kit reorder, icon picker, and live
 * PreviewFrame. Reachable ONLY via the import.meta.env.DEV Studio chunk, so it
 * is dead-code-eliminated from the production bundle.
 *
 * LEFT  — a live panel editor: dnd-kit reorder (keyed by the stable slug id),
 *         per-row icon picker + title/desc inputs, add/remove, and preview-frame
 *         controls (step / theme / width) that drive ONLY the preview chrome.
 * RIGHT — a faithful inline reproduction of the wizard's step-7 chrome wrapping the
 *         SHARED <FeatureHighlights features={draft} />, so the preview is
 *         pixel-identical to production and updates optimistically as you edit.
 *
 * The draft is hydrated from the engine GET (the live file) — not the static JSON
 * import — so unsaved edits show in the preview and post-save state matches. The
 * imported FEATURE_PANELS is only the fallback when the engine call fails.
 */

const VERSION = 1;

type PreviewTheme = 'light' | 'dark';
type PreviewWidth = 'narrow' | 'default' | 'wide';

const WIDTH_CLASS: Record<PreviewWidth, string> = {
  narrow: 'max-w-sm',
  default: 'max-w-lg',
  wide: 'max-w-2xl',
};

/** Generate a slug id not already present in `taken`. */
function nextFeatureId(taken: Set<string>): string {
  let n = taken.size;
  let id = `feature-${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `feature-${n}`;
  }
  return id;
}

/**
 * FLUX-763 Phase 4 — the Features tab is now a CONTROLLED component: the
 * OnboardingStudio shell owns `draft` + `setDraft` so Publish / Export / Import act on
 * flow + features together. The tab keeps its OWN lastSaved / saving / toast for the
 * per-tab Save affordance, and Save now writes the gitignored DRAFT
 * (saveOnboardingFeaturesDraft) instead of the committed file.
 */
export function FeaturesEditorTab({
  draft,
  setDraft,
  loading,
}: {
  draft: FeaturePanel[];
  setDraft: (next: FeaturePanel[] | ((prev: FeaturePanel[]) => FeaturePanel[])) => void;
  loading: boolean;
}) {
  // lastSaved tracks the DRAFT-file state (the per-tab "Unsaved changes" affordance).
  const [lastSaved, setLastSaved] = useState<FeaturePanel[]>(draft);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [syncedBaseline, setSyncedBaseline] = useState(false);

  // Preview-frame controls — drive ONLY the preview chrome, never the draft.
  const [previewStep, setPreviewStep] = useState(7);
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>('light');
  const [previewWidth, setPreviewWidth] = useState<PreviewWidth>('default');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // The shell hydrates the draft from the draft GET; once that lands, adopt it as the
  // saved baseline ONCE so the per-tab dirty flag starts clean.
  useEffect(() => {
    if (!loading && !syncedBaseline) {
      setLastSaved(draft);
      setSyncedBaseline(true);
    }
  }, [loading, syncedBaseline, draft]);

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(lastSaved),
    [draft, lastSaved],
  );

  function patchPanel(id: string, patch: Partial<FeaturePanel>) {
    setDraft((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removePanel(id: string) {
    setDraft((prev) => prev.filter((p) => p.id !== id));
  }

  function addPanel() {
    setDraft((prev) => {
      const taken = new Set(prev.map((p) => p.id));
      return [...prev, { id: nextFeatureId(taken), icon: FALLBACK_ICON_NAME, title: 'New feature', desc: 'Describe this feature…' }];
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setDraft((prev) => {
      const oldIndex = prev.findIndex((p) => p.id === active.id);
      const newIndex = prev.findIndex((p) => p.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }

  async function handleLoad() {
    setToast(null);
    try {
      // Reload from the DRAFT (engine seeds it from committed on first read).
      const cfg = await fetchOnboardingFeaturesDraft();
      const features = validateFeatures(cfg);
      setDraft(features);
      setLastSaved(features);
      setToast({ kind: 'ok', text: 'Reloaded the draft from the engine.' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Load failed.' });
    }
  }

  async function handleSave() {
    setSaving(true);
    setToast(null);
    const payload: OnboardingFeaturesConfig = { version: VERSION, features: draft };
    try {
      // THE HEADLINE FIX: Save writes the gitignored DRAFT, never the committed file.
      const saved = await saveOnboardingFeaturesDraft(payload);
      const validated = validateFeatures(saved);
      const features = validated.length ? validated : draft;
      setDraft(features);
      setLastSaved(features);
      setToast({
        kind: 'ok',
        text: 'Saved to the draft (gitignored). Use Publish to write the committed config.',
      });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold tracking-tight">Onboarding feature panels</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-400">
            dev only
          </span>
        </div>
        {isDirty && (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
            Unsaved changes
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={addPanel}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            <Plus className="h-4 w-4" /> Add panel
          </button>
          <button
            onClick={handleLoad}
            disabled={loading || saving}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            <RotateCcw className="h-4 w-4" /> Load
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {toast && (
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            toast.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Two-column body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-2">
        {/* LEFT — editor */}
        <div className="min-h-0 overflow-y-auto rounded-2xl border border-gray-200 bg-gray-50/60 p-4 dark:border-white/10 dark:bg-white/[0.02]">
          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : draft.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No panels. Use <span className="font-semibold">Add panel</span> to create one.
            </p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={draft.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-3">
                  {draft.map((panel) => (
                    <PanelRow
                      key={panel.id}
                      panel={panel}
                      onChange={(patch) => patchPanel(panel.id, patch)}
                      onRemove={() => removePanel(panel.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* RIGHT — live preview */}
        <div className="flex min-h-0 flex-col gap-3">
          <PreviewControls
            step={previewStep}
            onStep={setPreviewStep}
            theme={previewTheme}
            onTheme={setPreviewTheme}
            width={previewWidth}
            onWidth={setPreviewWidth}
          />
          {/* FLUX-762: the shared FeatureHighlights renderer makes the hover panel
              live-previewable here for free — just hover/focus a card. */}
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Hover or focus a card to preview its tutorial panel.
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-gray-200 dark:border-white/10">
            <PreviewFrame theme={previewTheme} width={previewWidth} step={previewStep} features={draft} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One editable feature row: drag handle + icon picker + title/desc + delete. */
function PanelRow({
  panel,
  onChange,
  onRemove,
}: {
  panel: FeaturePanel;
  onChange: (patch: Partial<FeaturePanel>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 20 : undefined,
  };
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-white/5"
    >
      <div className="flex items-start gap-2">
        <button
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          className="mt-1 cursor-grab touch-none rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 active:cursor-grabbing dark:hover:bg-white/10"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <button
          onClick={() => setPickerOpen((o) => !o)}
          title={`Icon: ${panel.icon || FALLBACK_ICON_NAME}`}
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        >
          <IconGlyph name={panel.icon} className="h-4 w-4" />
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <input
            type="text"
            value={panel.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Title"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
          />
          <textarea
            value={panel.desc}
            onChange={(e) => onChange({ desc: e.target.value })}
            placeholder="Description"
            rows={2}
            className="w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs leading-relaxed text-gray-700 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
          />
          {/* FLUX-762: extended copy shown in the hover/focus tutorial panel (the
              card itself keeps the short `desc`). Omit-when-blank mirrors the
              ImageUploadField alt-text pattern so an empty value drops the field. */}
          <textarea
            value={panel.details ?? ''}
            onChange={(e) => onChange({ details: e.target.value || undefined })}
            placeholder="Extended details (shown in the hover tutorial panel)"
            rows={3}
            className="w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs leading-relaxed text-gray-700 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
          />
          <ImageUploadField
            kind="feature"
            id={panel.id}
            value={panel.image}
            onChange={(image) => onChange({ image })}
          />
          <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500">id: {panel.id}</span>
        </div>

        <button
          onClick={onRemove}
          aria-label="Remove panel"
          className="mt-0.5 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-400/10"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {pickerOpen && (
        <IconPicker
          current={panel.icon}
          onPick={(name) => {
            onChange({ icon: name });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

/** Preview-frame controls — drive ONLY the preview chrome, not the draft. */
function PreviewControls({
  step,
  onStep,
  theme,
  onTheme,
  width,
  onWidth,
}: {
  step: number;
  onStep: (s: number) => void;
  theme: PreviewTheme;
  onTheme: (t: PreviewTheme) => void;
  width: PreviewWidth;
  onWidth: (w: PreviewWidth) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <label className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-gray-300">
        Step
        <select
          value={step}
          onChange={(e) => onStep(Number(e.target.value))}
          className="rounded-md border border-gray-200 bg-white px-2 py-1 dark:border-white/10 dark:bg-white/5"
        >
          {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 7 ? ' (features)' : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-white/10">
        {(['light', 'dark'] as PreviewTheme[]).map((t) => (
          <button
            key={t}
            onClick={() => onTheme(t)}
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
            onClick={() => onWidth(w)}
            className={`px-2.5 py-1 font-medium capitalize transition-colors ${
              width === w ? 'bg-primary text-white' : 'bg-white text-gray-600 dark:bg-white/5 dark:text-gray-300'
            }`}
          >
            {w}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Faithful inline reproduction of the wizard's step-7 chrome wrapping the SHARED
 * FeatureHighlights — so the preview is pixel-identical to production. The
 * heading + StepDots-style dots + a DISABLED no-op Continue button are copied from
 * the wizard (lines for the step-7 block); NO OnboardingWizard instance is mounted,
 * so zero wizard side-effects run. Non-feature steps render a simple placeholder —
 * the editor's purpose is the feature step.
 */
function PreviewFrame({
  theme,
  width,
  step,
  features,
}: {
  theme: PreviewTheme;
  width: PreviewWidth;
  step: number;
  features: FeaturePanel[];
}) {
  return (
    <div className={theme === 'dark' ? 'dark' : ''}>
      <div className="flex min-h-full items-center justify-center bg-gray-50 p-8 dark:bg-bg-dark">
        <div className={`w-full ${WIDTH_CLASS[width]}`}>
          {/* StepDots replica (current = selected step, total = 9). */}
          <div className="mb-8 flex items-center justify-center gap-2">
            {Array.from({ length: 9 }, (_, i) => (
              <span
                key={i}
                className={`block rounded-full transition-all ${
                  i + 1 === step
                    ? 'h-2 w-6 bg-primary'
                    : i + 1 < step
                      ? 'h-2 w-2 bg-primary/40'
                      : 'h-2 w-2 bg-gray-200 dark:bg-white/15'
                }`}
              />
            ))}
          </div>

          {step === 7 ? (
            <div>
              <div className="mb-8 flex flex-col items-center gap-3 text-center">
                <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
                  <Sparkles className="h-8 w-8 text-primary" />
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                  What you can do
                </h1>
                <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
                  A quick tour of what Event Horizon brings to your workflow.
                </p>
              </div>

              <FeatureHighlights features={features} />

              {/* DISABLED no-op Continue — a copy of the wizard's Continue chrome, onClick removed. */}
              <button
                type="button"
                disabled
                className="flex h-11 w-full cursor-not-allowed items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white opacity-70 shadow-sm"
              >
                Continue →
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Step {step}
              </h1>
              <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
                This editor previews the feature step. Select <span className="font-semibold">Step 7
                (features)</span> to edit and preview the “What you can do” panels.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
