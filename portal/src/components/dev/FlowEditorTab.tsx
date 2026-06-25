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
import {
  GripVertical,
  Plus,
  Trash2,
  Save,
  RotateCcw,
  Workflow,
  Lock,
  Info,
  X,
} from 'lucide-react';
import { fetchOnboardingFlowDraft, saveOnboardingFlowDraft } from '../../api';
import {
  validateFlow,
  isTopologicallyValid,
  ONBOARDING_CONDITION_FIELDS,
} from '../../config/onboardingFlow';
import type {
  OnboardingFlowConfig,
  OnboardingPage,
  OnboardingCta,
  OnboardingCondition,
} from '../../config/onboardingFlow';
import { IconGlyph, IconPicker } from './IconPicker';
import { FlowPlayPreview } from './FlowPlayPreview';
import { ImageUploadField } from './ImageUploadField';

/**
 * FLUX-759 — the Flow tab of the Onboarding Studio. LEFT: a per-page editor with
 * dnd-kit reorder constrained by SYSTEM_PAGE_SPECS (required pages can't be
 * deleted; locked widget pages can't be dragged past their dependency band).
 * RIGHT: the FlowPlayPreview that walks the in-memory draft Next/Back — it NEVER
 * imports OnboardingWizard (FLUX-758 owns it).
 *
 * The client drag/delete guard is UX only; the persistence invariant is the
 * client's pre-save validateFlow PLUS the engine PUT's structural re-validation,
 * so even a buggy drag can never persist an illegal order. Reachable ONLY through
 * the import.meta.env.DEV Studio lazy chunk, so it strips from the prod bundle.
 */

const CONTENT_ACTIONS: NonNullable<OnboardingCta['action']>[] = [
  'advance',
  'open-docs',
  'first-ticket',
  'open-group',
];

/** Human-readable "shown when …" summary of a page's conditions (AND-combined). */
function conditionSummary(conditions: OnboardingCondition[] | undefined): string {
  if (!conditions || conditions.length === 0) return 'always shown';
  const parts = conditions.map((c) => {
    switch (c.op) {
      case 'truthy':
        return `${c.field} is set`;
      case 'falsy':
        return `${c.field} is not set`;
      case 'eq':
        return `${c.field} = ${c.value ?? ''}`;
      case 'neq':
        return `${c.field} ≠ ${c.value ?? ''}`;
      default:
        return `${c.field} ?`;
    }
  });
  return `when ${parts.join(' and ')}`;
}

/** Generate a page slug id not already present in `taken` (mirrors nextFeatureId). */
function nextPageId(taken: Set<string>): string {
  let n = taken.size;
  let id = `page-${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `page-${n}`;
  }
  return id;
}

/**
 * FLUX-763 Phase 4 — the Flow tab is now a CONTROLLED component: the OnboardingStudio
 * shell owns `draft` + `setDraft` so Publish / Export / Import can operate on
 * flow + features together. The tab keeps its OWN lastSaved / saving / toast for the
 * per-tab Save affordance (FLUX-759's UX), and Save now writes the gitignored DRAFT
 * (saveOnboardingFlowDraft) instead of the committed file — THE HEADLINE FIX.
 */
export function FlowEditorTab({
  draft,
  setDraft,
  loading,
}: {
  draft: OnboardingFlowConfig;
  setDraft: (next: OnboardingFlowConfig | ((prev: OnboardingFlowConfig) => OnboardingFlowConfig)) => void;
  loading: boolean;
}) {
  // lastSaved tracks the DRAFT-file state (not committed) — the per-tab "Unsaved
  // changes" affordance compares against this. The shell owns the committed-diff badge.
  const [lastSaved, setLastSaved] = useState<OnboardingFlowConfig>(draft);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // Transient inline reason surfaced when a drag is rejected by the topo guard.
  const [dragReason, setDragReason] = useState<string | null>(null);
  // Once the shell finishes its first hydration, sync our lastSaved baseline to it.
  const [syncedBaseline, setSyncedBaseline] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // The shell hydrates the draft from the draft GET; once that lands (loading→false),
  // adopt it as our saved baseline ONCE so the per-tab dirty flag starts clean.
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

  function patchPage(id: string, patch: Partial<OnboardingPage>) {
    setDraft((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }

  function removePage(id: string) {
    setDraft((prev) => ({ ...prev, pages: prev.pages.filter((p) => p.id !== id) }));
  }

  function addContentPage() {
    setDraft((prev) => {
      const taken = new Set(prev.pages.map((p) => p.id));
      const page: OnboardingPage = {
        id: nextPageId(taken),
        kind: 'content',
        title: 'New page',
        subtitle: 'Describe this page…',
        ctas: [{ label: 'Continue →', action: 'advance' }],
      };
      return { ...prev, pages: [...prev.pages, page] };
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setDragReason(null);
    if (!over || active.id === over.id) return;
    setDraft((prev) => {
      const oldIndex = prev.pages.findIndex((p) => p.id === active.id);
      const newIndex = prev.pages.findIndex((p) => p.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      const proposed = arrayMove(prev.pages, oldIndex, newIndex);
      // Locked drag band: a widget page can't move past its dependency band.
      // Reuse the EXACT predicate the validator uses so the client guard and the
      // server normalization agree. Reject (snap back) + surface a reason.
      if (!isTopologicallyValid(proposed)) {
        const moved = prev.pages[oldIndex];
        const depList = (moved.dependsOn ?? []).join(', ');
        setDragReason(
          depList
            ? `Can't move '${moved.id}' there — it depends on: ${depList}.`
            : `Can't move '${moved.id}' there — it would break the system step order.`,
        );
        return prev;
      }
      return { ...prev, pages: proposed };
    });
  }

  async function handleLoad() {
    setToast(null);
    try {
      // Reload from the DRAFT (engine seeds it from committed on first read).
      const cfg = await fetchOnboardingFlowDraft();
      const validated = validateFlow(cfg);
      setDraft(validated);
      setLastSaved(validated);
      setToast({ kind: 'ok', text: 'Reloaded the draft from the engine.' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Load failed.' });
    }
  }

  async function handleSave() {
    setSaving(true);
    setToast(null);
    // Pre-save normalization: persist the already-validated JSON (SYSTEM_PAGE_SPECS
    // merged, required re-injected, canonical order re-derived). The engine draft PUT
    // re-validates structurally as the backstop.
    const payload = validateFlow(draft);
    try {
      // THE HEADLINE FIX: Save writes the gitignored DRAFT, never the committed file.
      const saved = await saveOnboardingFlowDraft(payload);
      const validated = validateFlow(saved);
      setDraft(validated);
      setLastSaved(validated);
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
          <Workflow className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold tracking-tight">Onboarding flow</h1>
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
            onClick={addContentPage}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
          >
            <Plus className="h-4 w-4" /> Add content page
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

      {/* Hint: feature cards live on the Features tab (shared FEATURE_PANELS). */}
      <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <Info className="h-3.5 w-3.5" />
        A content page's feature grid renders from the shared feature panels — edit those cards on the
        <span className="font-semibold">Features</span> tab.
      </p>

      {/* Two-column body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-2">
        {/* LEFT — page editor */}
        <div className="min-h-0 overflow-y-auto rounded-2xl border border-gray-200 bg-gray-50/60 p-4 dark:border-white/10 dark:bg-white/[0.02]">
          {dragReason && (
            <div className="mb-3 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">{dragReason}</span>
              <button onClick={() => setDragReason(null)} aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : draft.pages.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No pages.</p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext
                items={draft.pages.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-3">
                  {draft.pages.map((page) => (
                    <FlowPageRow
                      key={page.id}
                      page={page}
                      onChange={(patch) => patchPage(page.id, patch)}
                      onRemove={() => removePage(page.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {/* Adding a system widget page is a CODE change, never an editor action. */}
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500">
            <Info className="h-3 w-3" />
            Adding/removing a system step is a code change (WIDGET_RENDERERS + SYSTEM_PAGE_SPECS) — only
            content pages can be added here.
          </p>
        </div>

        {/* RIGHT — PLAY preview (Next/Back over the validated draft) */}
        <div className="flex min-h-0 flex-col">
          <FlowPlayPreview draft={draft} />
        </div>
      </div>
    </div>
  );
}

/**
 * One editable flow page. Content pages expose title/subtitle/body/icon/ctas/
 * features/mandatory/hidden. Widget pages expose title/subtitle/icon/mandatory/
 * hidden, but the SYSTEM RAILS (kind/widget/system/required/locked/dependsOn) are
 * READ-ONLY chips — SYSTEM_PAGE_SPECS owns them and validateFlow re-derives them on
 * load. Required pages cannot be deleted (lock glyph instead of Trash).
 */
function FlowPageRow({
  page,
  onChange,
  onRemove,
}: {
  page: OnboardingPage;
  onChange: (patch: Partial<OnboardingPage>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 20 : undefined,
  };
  const [pickerOpen, setPickerOpen] = useState(false);

  const isWidget = page.kind === 'widget';
  const isRequired = !!page.required;
  const isLocked = !!page.locked;

  function updateCta(i: number, patch: Partial<OnboardingCta>) {
    const ctas = (page.ctas ?? []).map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    onChange({ ctas });
  }
  function addCta() {
    onChange({ ctas: [...(page.ctas ?? []), { label: 'Continue →', action: 'advance' }] });
  }
  function removeCta(i: number) {
    const ctas = (page.ctas ?? []).filter((_, idx) => idx !== i);
    onChange({ ctas: ctas.length ? ctas : undefined });
  }
  function toggleFeatures(on: boolean) {
    onChange({ features: on ? { ref: 'onboardingFeatures', layout: 'grid' } : undefined });
  }

  // ── Conditions editor (Phase 4) ───────────────────────────────────────────────
  function addCondition() {
    const next: OnboardingCondition = { field: ONBOARDING_CONDITION_FIELDS[0], op: 'truthy' };
    onChange({ conditions: [...(page.conditions ?? []), next] });
  }
  function updateCondition(i: number, patch: Partial<OnboardingCondition>) {
    const conditions = (page.conditions ?? []).map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    onChange({ conditions });
  }
  function removeCondition(i: number) {
    const conditions = (page.conditions ?? []).filter((_, idx) => idx !== i);
    onChange({ conditions: conditions.length ? conditions : undefined });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border bg-white p-3 shadow-sm dark:bg-white/5 ${
        isWidget
          ? 'border-amber-200 dark:border-amber-400/30'
          : 'border-gray-200 dark:border-white/10'
      }`}
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
          title={`Icon: ${page.icon || 'Sparkles'}`}
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        >
          <IconGlyph name={page.icon ?? 'Sparkles'} className="h-4 w-4" />
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* System rail chips (widget pages only) — READ-ONLY. */}
          {isWidget && (
            <div className="flex flex-wrap items-center gap-1">
              <Chip tone="system" label="system" title="This is a system step (kind: widget). SYSTEM_PAGE_SPECS owns its rails; validateFlow re-derives them on load." />
              {isRequired && (
                <Chip tone="required" label="required" title="Required system step — cannot be removed." />
              )}
              {isLocked && (
                <Chip tone="locked" label="locked" title="Locked order — cannot be dragged past its dependency band." />
              )}
              {(page.dependsOn ?? []).length > 0 && (
                <Chip
                  tone="dep"
                  label={`depends on: ${(page.dependsOn ?? []).join(', ')}`}
                  title="Hard prerequisites from SYSTEM_PAGE_SPECS — must appear earlier in the flow."
                />
              )}
            </div>
          )}

          <input
            type="text"
            value={page.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Title"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
          />
          <textarea
            value={page.subtitle ?? ''}
            onChange={(e) => onChange({ subtitle: e.target.value })}
            placeholder="Subtitle"
            rows={2}
            className="w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs leading-relaxed text-gray-700 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
          />

          {/* Body — content pages only (the renderer ignores widget body). */}
          {!isWidget && (
            <textarea
              value={page.body ?? ''}
              onChange={(e) => onChange({ body: e.target.value || undefined })}
              placeholder="Body (optional)"
              rows={2}
              className="w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs leading-relaxed text-gray-700 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
            />
          )}

          {/* Image upload — content pages only (widget pages get NO control). */}
          {!isWidget && (
            <ImageUploadField
              kind="page"
              id={page.id}
              value={page.image}
              onChange={(image) => onChange({ image })}
            />
          )}

          {/* CTAs editor — content pages only. */}
          {!isWidget && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-gray-200 bg-gray-50/60 p-2 dark:border-white/10 dark:bg-white/[0.02]">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Buttons</span>
              {(page.ctas ?? []).map((cta, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={cta.label}
                    onChange={(e) => updateCta(i, { label: e.target.value })}
                    placeholder="Label"
                    className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
                  />
                  <select
                    value={cta.action ?? ''}
                    onChange={(e) =>
                      updateCta(i, {
                        action: (e.target.value || undefined) as OnboardingCta['action'],
                      })
                    }
                    className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs dark:border-white/10 dark:bg-white/5"
                  >
                    <option value="">(none)</option>
                    {CONTENT_ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeCta(i)}
                    aria-label="Remove button"
                    className="rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-400/10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                onClick={addCta}
                className="flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
              >
                <Plus className="h-3 w-3" /> Add button
              </button>
            </div>
          )}

          {/* Feature-grid toggle — content pages only. */}
          {!isWidget && (
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={page.features?.layout === 'grid'}
                onChange={(e) => toggleFeatures(e.target.checked)}
                className="rounded border-gray-300"
              />
              Show feature grid
            </label>
          )}

          {/* Phase-4 carried flags — editable for ALL pages so they round-trip. */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={!!page.mandatory}
                onChange={(e) => onChange({ mandatory: e.target.checked || undefined })}
                className="rounded border-gray-300"
              />
              Mandatory
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={!!page.hidden}
                onChange={(e) => onChange({ hidden: e.target.checked || undefined })}
                className="rounded border-gray-300"
              />
              Hidden
            </label>
          </div>

          {/* Conditions editor (Phase 4) — field/op/value rows. Required system pages
              must always show, so conditioning them is blocked at publish; we warn here. */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-gray-200 bg-gray-50/60 p-2 dark:border-white/10 dark:bg-white/[0.02]">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Show only when
              </span>
              <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
                {conditionSummary(page.conditions)}
              </span>
            </div>
            {isRequired && (page.conditions ?? []).length > 0 && (
              <p className="text-[10px] text-rose-600 dark:text-rose-400">
                Required system page — conditions are ignored at runtime and blocked at publish.
              </p>
            )}
            {(page.conditions ?? []).map((cond, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <select
                  value={cond.field}
                  onChange={(e) => updateCondition(i, { field: e.target.value })}
                  className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs dark:border-white/10 dark:bg-white/5"
                >
                  {ONBOARDING_CONDITION_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                  {/* Preserve an unknown (typo'd) field so editing doesn't silently drop it. */}
                  {!(ONBOARDING_CONDITION_FIELDS as readonly string[]).includes(cond.field) && (
                    <option value={cond.field}>{cond.field} (unknown)</option>
                  )}
                </select>
                <select
                  value={cond.op}
                  onChange={(e) =>
                    updateCondition(i, { op: e.target.value as OnboardingCondition['op'] })
                  }
                  className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs dark:border-white/10 dark:bg-white/5"
                >
                  {(['truthy', 'falsy', 'eq', 'neq'] as OnboardingCondition['op'][]).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                {(cond.op === 'eq' || cond.op === 'neq') && (
                  <input
                    type="text"
                    value={cond.value === undefined ? '' : String(cond.value)}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                    placeholder="value"
                    className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
                  />
                )}
                <button
                  onClick={() => removeCondition(i)}
                  aria-label="Remove condition"
                  className="rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-400/10"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              onClick={addCondition}
              className="flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
            >
              <Plus className="h-3 w-3" /> Add condition
            </button>
          </div>

          <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500">id: {page.id}</span>
        </div>

        {/* Delete (content + non-required widgets) OR a lock glyph (required). */}
        {isRequired ? (
          <span
            title="Required system step — cannot be removed."
            className="mt-0.5 rounded-lg p-1.5 text-amber-500"
          >
            <Lock className="h-4 w-4" />
          </span>
        ) : (
          <button
            onClick={onRemove}
            aria-label="Remove page"
            className="mt-0.5 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-400/10"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {pickerOpen && (
        <IconPicker
          current={page.icon ?? 'Sparkles'}
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

/** A small read-only constraint chip with a tooltip explaining the rail. */
function Chip({
  tone,
  label,
  title,
}: {
  tone: 'system' | 'required' | 'locked' | 'dep';
  label: string;
  title: string;
}) {
  const cls: Record<typeof tone, string> = {
    system: 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
    required: 'bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300',
    locked: 'bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-300',
    dep: 'bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cls[tone]}`}
    >
      {(tone === 'locked' || tone === 'required') && <Lock className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}
