import rawFlow from './onboardingFlow.json';
import type { FeaturePanel } from './onboardingFeatures';

/**
 * Data-driven onboarding flow config (FLUX-756 Phase 1).
 *
 * This is a SEPARATE committed config from onboardingFeatures.json — it does NOT
 * overload the {version,features} feature-panel seed (the FLUX-755 editor/engine
 * route keep owning that file unchanged). The flow's features page references the
 * existing panels via `features.ref: 'onboardingFeatures'`, so there is zero data
 * duplication and zero migration of the feature seed.
 *
 * Phase 1 PARSES and CARRIES every field below; it only ACTS on the marked subset
 * (kind, widget, title/subtitle/body copy, icon, ctas, features.layout==='grid',
 * and the functional-step rails system/required/locked/dependsOn). image[],
 * conditions[], mandatory, hidden, and features.layout==='pages' are carried inert
 * for Phases 2-4 — see the field comments.
 */

/** 'widget' = system/functional step with real side effects + dependency rules; 'content' = free copy/cards page. */
export type OnboardingPageKind = 'widget' | 'content';

/**
 * The ONLY ids the runtime WIDGET_RENDERERS registry resolves. Adding/removing one
 * is a CODE change, never an editor action. The final "You're all set!" page is
 * modeled as a SYSTEM widget 'completion' (it runs complete()/notifyWorkspaceSet) so
 * the editor can never delete the terminal page.
 */
export type OnboardingWidgetId =
  | 'pick-folder'
  | 'storage-mode'
  | 'pick-assistant'
  | 'install-skill'
  | 'bootstrap'
  | 'path-setup'
  | 'completion';

/** Phase 4: evaluated against wizard shared state. Phase 1: parsed & carried, NEVER evaluated (every page renders). */
export interface OnboardingCondition {
  field: string;
  op: 'eq' | 'neq' | 'truthy' | 'falsy';
  value?: string | number | boolean;
}

/** Phase 3: upload/serving. Phase 1: carried only; renderer ignores (src:'' = none). */
export interface OnboardingImage {
  src: string;
  alt?: string;
}

/**
 * A content page may render the feature card-grid. `ref` reuses the existing
 * onboardingFeatures seed (zero duplication); `layout:'pages'` (feature-per-page)
 * is Phase 3+ — Phase 1 honors 'grid' only (default grid).
 */
export interface OnboardingFeaturesRef {
  ref?: 'onboardingFeatures';
  inline?: FeaturePanel[];
  layout?: 'grid' | 'pages';
}

/**
 * content-page button(s); `action` keys a tiny content-action registry
 * (advance=onAdvance; open-docs=complete()+setView('docs');
 * first-ticket=complete(); open-group=setItem(COMPLETE_KEY,'1')+setView('settings')).
 */
export interface OnboardingCta {
  label: string;
  action?: 'advance' | 'open-docs' | 'first-ticket' | 'open-group';
}

export interface OnboardingPage {
  /** stable slug, React key + editor dnd id (e.g. 'welcome','features','docs') */
  id: string;
  kind: OnboardingPageKind;
  /** REQUIRED when kind==='widget'; absent for content */
  widget?: OnboardingWidgetId;
  title: string;
  /** the gray sub-paragraph under the heading */
  subtitle?: string;
  /** content-page free copy (Phase 2 rich edit); Phase 1 renders as a paragraph if present */
  body?: string;
  /** lucide PascalCase NAME, resolved via existing resolveFeatureIcon() (guaranteed fallback) */
  icon?: string;
  /** content-page buttons in order. widget pages ignore. */
  ctas?: OnboardingCta[];
  /** Phase 3 (carried only) */
  image?: OnboardingImage;
  /** a content page may render the feature grid */
  features?: OnboardingFeaturesRef;
  /** Phase 4 (carried only) */
  conditions?: OnboardingCondition[];
  // ---- functional-constraint model (Phase 1 MODELS; Phase 2 enforces in editor UI) ----
  /** true for widget pages: editor may NOT delete/convert them */
  system?: boolean;
  /** must remain in the flow (pick-folder, storage-mode, completion) */
  required?: boolean;
  /** fixed relative order — cannot be dragged past its dependency band */
  locked?: boolean;
  /** Phase 4: user cannot skip (no Skip control); carried only */
  mandatory?: boolean;
  /** Phase 4: page exists but is not rendered; carried only (Phase 1 ALWAYS renders) */
  hidden?: boolean;
  /** hard prerequisites */
  dependsOn?: OnboardingWidgetId[];
}

/** version: 2 (features-config is v1). A draft/publish split is Phase 4 — NOT built now. */
export interface OnboardingFlowConfig {
  version: number;
  pages: OnboardingPage[];
}

/**
 * The SINGLE source of truth for the functional-step rails. This table is
 * hardcoded (NOT config-editable): validateFlow MERGES the matching row onto every
 * kind:'widget' page, so a hand-edit can never strip required/locked/dependsOn/system.
 */
export const SYSTEM_PAGE_SPECS: Record<
  OnboardingWidgetId,
  { system: true; required: boolean; locked: boolean; dependsOn: OnboardingWidgetId[] }
> = {
  'pick-folder': { system: true, required: true, locked: true, dependsOn: [] },
  'storage-mode': { system: true, required: true, locked: true, dependsOn: ['pick-folder'] },
  'pick-assistant': { system: true, required: true, locked: true, dependsOn: ['pick-folder'] },
  'install-skill': { system: true, required: false, locked: true, dependsOn: ['pick-folder', 'pick-assistant'] },
  'bootstrap': { system: true, required: false, locked: true, dependsOn: ['pick-folder'] },
  'path-setup': { system: true, required: false, locked: true, dependsOn: ['pick-folder'] },
  'completion': { system: true, required: true, locked: true, dependsOn: ['pick-folder'] },
};

const WIDGET_IDS = Object.keys(SYSTEM_PAGE_SPECS) as OnboardingWidgetId[];

function isWidgetId(value: unknown): value is OnboardingWidgetId {
  return typeof value === 'string' && (WIDGET_IDS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CONDITIONS / HIDDEN (FLUX-763 Phase 4) — pure, zero-React evaluators so the
// wizard AND the dev Studio preview share ONE implementation. These live here
// (NOT in onboardingValidate.ts) precisely because the wizard imports them; the
// publish-only validateOnboarding stays in the separate module so it tree-shakes
// out of the prod wizard graph.
// ---------------------------------------------------------------------------

/**
 * The ONLY fields a page.condition may reference. Every entry is sourced from
 * EXISTING wizard state — nothing new is collected. validateOnboarding flags any
 * condition referencing a field outside this list (the runtime fails open).
 */
export const ONBOARDING_CONDITION_FIELDS = [
  'storageMode',
  'assistant',
  'platform',
  'workspaceConfigured',
] as const;
export type OnboardingConditionField = (typeof ONBOARDING_CONDITION_FIELDS)[number];

/**
 * The runtime context conditions evaluate against. Every field is derived from
 * state the wizard already tracks (selectedMode, selectedFramework, pathInfo /
 * navigator.platform, folderPath) — see OnboardingWizard's ctx useMemo.
 */
export interface ConditionContext {
  storageMode: 'in-repo' | 'orphan';
  assistant: string;
  platform: string;
  workspaceConfigured: boolean;
}

function isConditionField(field: string): field is OnboardingConditionField {
  return (ONBOARDING_CONDITION_FIELDS as readonly string[]).includes(field);
}

/**
 * Evaluate a page's conditions[] against the runtime context.
 *  - No conditions (undefined/empty) => true (SAFE DEFAULT — never hide a page
 *    that opted out of conditioning).
 *  - 'truthy'/'falsy' test Boolean(ctx[field]); 'eq'/'neq' string-coerce both
 *    sides so JSON values (numbers/booleans) match.
 *  - Unknown field (not in ONBOARDING_CONDITION_FIELDS) => that single condition
 *    PASSES (FAIL-OPEN: a typo'd field never silently hides a page;
 *    validateOnboarding surfaces it pre-publish so the author fixes it).
 *  - Multiple conditions are AND-combined; returns false only if a KNOWN-field
 *    condition evaluates false.
 */
export function evaluatePageVisible(page: OnboardingPage, ctx: ConditionContext): boolean {
  const conditions = page.conditions;
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => {
    // Fail-open on an unknown field — never hide on an authoring typo.
    if (!isConditionField(c.field)) return true;
    const actual = ctx[c.field];
    switch (c.op) {
      case 'truthy':
        return Boolean(actual);
      case 'falsy':
        return !actual;
      case 'eq':
        return String(actual) === String(c.value);
      case 'neq':
        return String(actual) !== String(c.value);
      default:
        // Unknown op — fail open (validateOnboarding blocks it pre-publish).
        return true;
    }
  });
}

/**
 * A required system page — resolved from the authoritative SYSTEM_PAGE_SPECS
 * table (NOT the page's own flag, which a hand-edit could weaken). This is the
 * runtime guard that conditions/hidden can NEVER drop a required system page.
 */
export function isRequiredSystemPage(p: OnboardingPage): boolean {
  return p.kind === 'widget' && !!p.widget && SYSTEM_PAGE_SPECS[p.widget].required === true;
}

/**
 * Build the wizard's VISIBLE page sequence from the full page list + context:
 *  - a required system page (pick-folder/storage-mode/pick-assistant/completion)
 *    is ALWAYS kept, regardless of hidden/conditions — guaranteeing the runtime
 *    can never produce a setup missing folder/storage/assistant/completion;
 *  - every other page is kept only when it is not hidden AND its conditions pass.
 * install-skill/bootstrap/path-setup are required:false, so they MAY be
 * hidden/conditioned out; the four required rails can NOT.
 */
export function visiblePages(pages: OnboardingPage[], ctx: ConditionContext): OnboardingPage[] {
  return pages.filter(
    (p) => isRequiredSystemPage(p) || (!p.hidden && evaluatePageVisible(p, ctx)),
  );
}

/**
 * The shipped seed flow — a 1:1 transcription of today's 9 wizard steps, copy and
 * behavior verbatim. Mirrors onboardingFlow.json so a missing/garbage file yields
 * identical behavior. Widget pages carry their SYSTEM_PAGE_SPECS flags inline (and
 * validateFlow re-derives them on load regardless).
 */
export const DEFAULT_FLOW: OnboardingFlowConfig = {
  version: 2,
  pages: [
    {
      id: 'welcome',
      kind: 'widget',
      widget: 'pick-folder',
      icon: 'FolderOpen',
      title: 'Welcome to Event Horizon',
      subtitle:
        "Let's get you set up. First, pick the project folder you want to track. The wizard will create a .flux/ (or .flux-store/) directory automatically if it doesn't exist. You can also run event-horizon init manually as an alternative.",
      system: true,
      required: true,
      locked: true,
      dependsOn: [],
    },
    {
      id: 'storage-mode',
      kind: 'widget',
      widget: 'storage-mode',
      icon: 'HardDrive',
      title: 'Choose your storage mode',
      subtitle: 'Pick how Event Horizon stores your tickets. You can change this later in Settings.',
      system: true,
      required: true,
      locked: true,
      dependsOn: ['pick-folder'],
    },
    {
      id: 'pick-assistant',
      kind: 'widget',
      widget: 'pick-assistant',
      icon: 'Terminal',
      title: 'Pick your AI assistant',
      subtitle:
        'Event Horizon installs a workflow skill into your AI coding assistant so it can manage tickets automatically.',
      system: true,
      required: true,
      locked: true,
      dependsOn: ['pick-folder'],
    },
    {
      id: 'install-skill',
      kind: 'widget',
      widget: 'install-skill',
      icon: 'Rocket',
      title: 'Install the integration',
      subtitle:
        'This copies the Event Horizon workflow skill into your workspace so the agent knows how to manage your tickets.',
      system: true,
      required: false,
      locked: true,
      dependsOn: ['pick-folder', 'pick-assistant'],
    },
    {
      id: 'bootstrap',
      kind: 'widget',
      widget: 'bootstrap',
      icon: 'Package',
      title: 'Import from your project',
      subtitle: "Let's check if your project has docs or tasks we can import.",
      system: true,
      required: false,
      locked: true,
      dependsOn: ['pick-folder'],
    },
    {
      id: 'path-setup',
      kind: 'widget',
      widget: 'path-setup',
      icon: 'Terminal',
      title: 'Add to PATH',
      subtitle: 'Run event-horizon from any terminal without typing its full path.',
      system: true,
      required: false,
      locked: true,
      dependsOn: ['pick-folder'],
    },
    {
      id: 'features',
      kind: 'content',
      icon: 'Sparkles',
      title: 'What you can do',
      subtitle: 'A quick tour of what Event Horizon brings to your workflow.',
      features: { ref: 'onboardingFeatures', layout: 'grid' },
      ctas: [{ label: 'Continue →', action: 'advance' }],
    },
    {
      id: 'docs',
      kind: 'content',
      icon: 'BookOpen',
      title: 'Explore the docs',
      subtitle:
        'Event Horizon ships with built-in documentation covering workflow setup, ticket management, and the agent integration. Worth a quick look before diving in.',
      ctas: [
        { label: 'Open the docs', action: 'open-docs' },
        { label: "I'll check later", action: 'advance' },
      ],
    },
    {
      id: 'all-set',
      kind: 'widget',
      widget: 'completion',
      icon: 'PartyPopper',
      title: "You're all set!",
      subtitle:
        'Your workspace is ready. Create your first ticket, assign it to your AI assistant, and watch it take off.',
      ctas: [{ label: 'Try your first ticket', action: 'first-ticket' }],
      system: true,
      required: true,
      locked: true,
      dependsOn: ['pick-folder'],
    },
  ],
};

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function asOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  return String(value);
}

/** Coerce a raw ctas array, dropping non-objects; only known actions survive. */
function coerceCtas(value: unknown): OnboardingCta[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: OnboardingCta[] = [];
  value.forEach((entry) => {
    if (entry == null || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const action = e.action;
    const validAction =
      action === 'advance' || action === 'open-docs' || action === 'first-ticket' || action === 'open-group'
        ? action
        : undefined;
    out.push({ label: asString(e.label), action: validAction });
  });
  return out.length ? out : undefined;
}

/** Coerce a raw features ref; carried for the renderer (Phase 1 honors layout:'grid'). */
function coerceFeatures(value: unknown): OnboardingFeaturesRef | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const e = value as Record<string, unknown>;
  const ref = e.ref === 'onboardingFeatures' ? 'onboardingFeatures' : undefined;
  const layout = e.layout === 'grid' || e.layout === 'pages' ? e.layout : undefined;
  const out: OnboardingFeaturesRef = {};
  if (ref) out.ref = ref;
  if (layout) out.layout = layout;
  // inline is carried as-is when an array (Phase 3+); not validated deeply here.
  if (Array.isArray(e.inline)) out.inline = e.inline as FeaturePanel[];
  return out;
}

/** Coerce a raw image; carried only in Phase 1. */
function coerceImage(value: unknown): OnboardingImage | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const e = value as Record<string, unknown>;
  return { src: asString(e.src), alt: asOptionalString(e.alt) };
}

/** Coerce a raw conditions array; carried only in Phase 1. */
function coerceConditions(value: unknown): OnboardingCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: OnboardingCondition[] = [];
  value.forEach((entry) => {
    if (entry == null || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const op = e.op;
    const validOp = op === 'eq' || op === 'neq' || op === 'truthy' || op === 'falsy' ? op : 'truthy';
    out.push({
      field: asString(e.field),
      op: validOp,
      value: e.value as string | number | boolean | undefined,
    });
  });
  return out.length ? out : undefined;
}

function coerceDependsOn(value: unknown): OnboardingWidgetId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(isWidgetId);
  return out.length ? out : undefined;
}

/**
 * Defensive coercion of a single raw page entry into the shape we render from.
 * Mirrors validateFeatures' posture: never throws on a malformed entry. `kind`
 * defaults to 'content' when widget is absent/unknown. Returns null for a
 * non-object entry (caller drops it).
 */
function coercePage(entry: unknown): OnboardingPage | null {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;

  const widget = isWidgetId(e.widget) ? e.widget : undefined;
  const kind: OnboardingPageKind = e.kind === 'widget' && widget ? 'widget' : 'content';

  const page: OnboardingPage = {
    id: asString(e.id).trim(),
    kind,
    title: asString(e.title),
  };

  if (kind === 'widget') page.widget = widget;

  const subtitle = asOptionalString(e.subtitle);
  if (subtitle !== undefined) page.subtitle = subtitle;
  const body = asOptionalString(e.body);
  if (body !== undefined) page.body = body;
  const icon = asOptionalString(e.icon);
  if (icon !== undefined) page.icon = icon;

  const ctas = coerceCtas(e.ctas);
  if (ctas) page.ctas = ctas;
  const image = coerceImage(e.image);
  if (image) page.image = image;
  const features = coerceFeatures(e.features);
  if (features) page.features = features;
  const conditions = coerceConditions(e.conditions);
  if (conditions) page.conditions = conditions;

  // Constraint flags are carried for content pages but authoritatively overwritten
  // for widget pages by the SYSTEM_PAGE_SPECS merge below.
  if (typeof e.system === 'boolean') page.system = e.system;
  if (typeof e.required === 'boolean') page.required = e.required;
  if (typeof e.locked === 'boolean') page.locked = e.locked;
  if (typeof e.mandatory === 'boolean') page.mandatory = e.mandatory;
  if (typeof e.hidden === 'boolean') page.hidden = e.hidden;
  const dependsOn = coerceDependsOn(e.dependsOn);
  if (dependsOn) page.dependsOn = dependsOn;

  return page;
}

/** Merge the SYSTEM_PAGE_SPECS row onto a widget page so a hand-edit can't weaken it. */
function applySystemSpec(page: OnboardingPage): OnboardingPage {
  if (page.kind !== 'widget' || !page.widget) return page;
  const spec = SYSTEM_PAGE_SPECS[page.widget];
  return {
    ...page,
    system: spec.system,
    required: spec.required,
    locked: spec.locked,
    dependsOn: [...spec.dependsOn],
  };
}

/** Guarantee a non-blank, unique id (mirrors validateFeatures' uniqueness loop). */
function ensureUniqueId(id: string, idx: number, seen: Set<string>): string {
  let candidate = id;
  if (candidate === '' || seen.has(candidate)) candidate = `page-${idx}`;
  let unique = candidate;
  let bump = idx;
  while (seen.has(unique)) {
    unique = `page-${++bump}`;
  }
  return unique;
}

/**
 * True when, for every widget page, all of its dependsOn predecessors appear at an
 * EARLIER index in pages[]. A false result means the authored order is invalid and
 * the system ordering must be re-derived.
 */
export function isTopologicallyValid(pages: OnboardingPage[]): boolean {
  const indexByWidget = new Map<OnboardingWidgetId, number>();
  pages.forEach((p, i) => {
    if (p.kind === 'widget' && p.widget) indexByWidget.set(p.widget, i);
  });
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.kind !== 'widget' || !p.widget) continue;
    for (const dep of p.dependsOn ?? []) {
      const depIdx = indexByWidget.get(dep);
      // A present prerequisite must appear earlier. (A missing one is handled by the
      // required-system re-injection step, not here.)
      if (depIdx !== undefined && depIdx >= i) return false;
    }
  }
  return true;
}

/**
 * When the authored order is topologically invalid, re-derive the canonical SYSTEM
 * ordering (the order the widgets appear in SYSTEM_PAGE_SPECS / DEFAULT_FLOW) while
 * keeping content pages in their authored slots. Content pages keep their relative
 * positions; system pages are slotted back in canonical order into the system slots.
 */
function reDeriveSystemOrder(pages: OnboardingPage[]): OnboardingPage[] {
  const canonicalWidgetOrder = DEFAULT_FLOW.pages
    .filter((p) => p.kind === 'widget' && p.widget)
    .map((p) => p.widget as OnboardingWidgetId);

  const systemPages = pages.filter((p) => p.kind === 'widget' && p.widget);
  systemPages.sort(
    (a, b) =>
      canonicalWidgetOrder.indexOf(a.widget as OnboardingWidgetId) -
      canonicalWidgetOrder.indexOf(b.widget as OnboardingWidgetId),
  );

  const sysQueue = [...systemPages];
  const out: OnboardingPage[] = [];
  for (const p of pages) {
    if (p.kind === 'widget' && p.widget) {
      // Fill each system slot with the next canonical-ordered system page.
      const next = sysQueue.shift();
      if (next) out.push(next);
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Re-inject any required system page that is missing from the flow, sourced from
 * DEFAULT_FLOW, inserted at its canonical slot so the topological invariant holds.
 */
function ensureRequiredSystemPages(pages: OnboardingPage[]): OnboardingPage[] {
  const present = new Set(
    pages.filter((p) => p.kind === 'widget' && p.widget).map((p) => p.widget as OnboardingWidgetId),
  );
  const missingRequired = WIDGET_IDS.filter((id) => SYSTEM_PAGE_SPECS[id].required && !present.has(id));
  if (missingRequired.length === 0) return pages;

  // Rebuild from DEFAULT_FLOW order: take each default page; if it's a present
  // (authored) widget, keep the authored one; if it's a missing-required widget,
  // inject the default. Then append any authored content pages not already placed.
  const authoredByWidget = new Map<OnboardingWidgetId, OnboardingPage>();
  pages.forEach((p) => {
    if (p.kind === 'widget' && p.widget) authoredByWidget.set(p.widget, p);
  });
  const placedContentIds = new Set<string>();

  const result: OnboardingPage[] = [];
  for (const dp of DEFAULT_FLOW.pages) {
    if (dp.kind === 'widget' && dp.widget) {
      const authored = authoredByWidget.get(dp.widget);
      if (authored) {
        result.push(authored);
      } else if (SYSTEM_PAGE_SPECS[dp.widget].required) {
        result.push(applySystemSpec(coercePage(dp)!));
      }
      // non-required & absent widget: leave it out (authored flow chose to drop it).
    } else {
      // anchor content pages from the authored set by matching id when possible.
      result.push(dp);
      placedContentIds.add(dp.id);
    }
  }

  // Replace default content anchors with authored content pages of the same id, and
  // append any authored content pages not represented in DEFAULT_FLOW.
  const authoredContent = pages.filter((p) => p.kind === 'content');
  const byId = new Map(authoredContent.map((p) => [p.id, p] as const));
  const merged = result.map((p) => (p.kind === 'content' && byId.has(p.id) ? byId.get(p.id)! : p));
  authoredContent.forEach((p) => {
    if (!placedContentIds.has(p.id) && !merged.some((m) => m.id === p.id)) merged.push(p);
  });
  return merged;
}

/**
 * Validate + normalize a raw flow config with the SAME defensive posture as
 * validateFeatures:
 *  - drop non-object pages; coerce id/title to strings;
 *  - auto-fill blank/duplicate ids as page-<idx> (uniqueness guaranteed);
 *  - default kind to 'content' when widget is absent/unknown;
 *  - MERGE SYSTEM_PAGE_SPECS onto kind:'widget' pages (a hand-edit can never strip
 *    required/locked/dependsOn/system);
 *  - topological backstop: every widget page's dependsOn predecessors must appear
 *    earlier — if not, re-derive the canonical SYSTEM ordering (content pages keep
 *    their slots);
 *  - guarantee every required system page is present, re-injecting from DEFAULT_FLOW;
 *  - fall back to DEFAULT_FLOW on a missing/garbage file (incl. a {version,features}
 *    shape with no pages[] array → treated as empty → DEFAULT_FLOW).
 */
export function validateFlow(input: unknown): OnboardingFlowConfig {
  const rawPages =
    input != null && typeof input === 'object' && Array.isArray((input as OnboardingFlowConfig).pages)
      ? (input as OnboardingFlowConfig).pages
      : null;

  // Missing/garbage file (or a legacy {version,features} shape with no pages[]):
  // fall back to the seed so onboarding never crashes.
  if (!rawPages || rawPages.length === 0) {
    return cloneFlow(DEFAULT_FLOW);
  }

  const version =
    input != null && typeof (input as OnboardingFlowConfig).version === 'number'
      ? (input as OnboardingFlowConfig).version
      : DEFAULT_FLOW.version;

  // 1. Coerce + drop non-objects.
  const coerced: OnboardingPage[] = [];
  rawPages.forEach((entry) => {
    const page = coercePage(entry);
    if (page) coerced.push(page);
  });

  // 2. Unique ids.
  const seen = new Set<string>();
  coerced.forEach((page, idx) => {
    page.id = ensureUniqueId(page.id, idx, seen);
    seen.add(page.id);
  });

  // 3. Merge SYSTEM_PAGE_SPECS onto widget pages.
  let pages = coerced.map(applySystemSpec);

  // 4. Re-inject missing required system pages from DEFAULT_FLOW.
  pages = ensureRequiredSystemPages(pages);

  // 5. Topological backstop — re-derive canonical system order if violated.
  if (!isTopologicallyValid(pages)) {
    pages = reDeriveSystemOrder(pages);
  }

  return { version, pages };
}

/** Deep-ish clone of a flow so callers never mutate DEFAULT_FLOW's shared arrays. */
function cloneFlow(flow: OnboardingFlowConfig): OnboardingFlowConfig {
  return {
    version: flow.version,
    pages: flow.pages.map((p) => ({
      ...p,
      ctas: p.ctas ? p.ctas.map((c) => ({ ...c })) : undefined,
      features: p.features ? { ...p.features } : undefined,
      image: p.image ? { ...p.image } : undefined,
      conditions: p.conditions ? p.conditions.map((c) => ({ ...c })) : undefined,
      dependsOn: p.dependsOn ? [...p.dependsOn] : undefined,
    })),
  };
}

/**
 * The shipped flow, statically imported from the committed JSON and defensively
 * validated — mirrors how FEATURE_PANELS consumes onboardingFeatures.json. The
 * wizard renders from this.
 */
export const FLOW: OnboardingFlowConfig = validateFlow(rawFlow);
