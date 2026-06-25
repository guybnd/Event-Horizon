// ─── Onboarding publish validator (FLUX-763 Phase 4) ─────────────────────────
//
// The RICH, author-facing validator surfaced in the Studio BEFORE Publish. It runs
// CLIENT-SIDE: errors disable the Publish button, warnings are shown but allow
// "Publish anyway". The engine publish route runs its OWN small structural backstop
// (validateFlowBody + validateConfigBody + required-system-present + the asset
// fs.access check the server alone can do) using local literals — it does NOT import
// this module, so the package boundary is respected and slight client/server
// divergence is accepted (the client is the richer of the two).
//
// CRITICAL prod-strip invariant: this module is imported ONLY by the dev Studio
// (the Publish UI), NEVER by OnboardingWizard. Keeping it OUT of onboardingFlow.ts
// (where the pure runtime evaluators live, which the wizard DOES import) guarantees
// the publish-only validator tree-shakes out of the production wizard graph.

import {
  ONBOARDING_CONDITION_FIELDS,
  SYSTEM_PAGE_SPECS,
  isTopologicallyValid,
} from './onboardingFlow';
import type {
  OnboardingFlowConfig,
  OnboardingPage,
  OnboardingCondition,
} from './onboardingFlow';
import type { OnboardingFeaturesConfig } from './onboardingFeatures';

/** One validation/warning entry. `pageId` ties an issue to a specific page when relevant. */
export interface ValidationIssue {
  code: string;
  message: string;
  pageId?: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** The condition ops the runtime evaluator understands; anything else is an authoring error. */
const KNOWN_CONDITION_OPS = new Set<OnboardingCondition['op']>(['eq', 'neq', 'truthy', 'falsy']);

/** Required system widgets, resolved from the authoritative SYSTEM_PAGE_SPECS table. */
const REQUIRED_SYSTEM_WIDGET_IDS = (
  Object.keys(SYSTEM_PAGE_SPECS) as (keyof typeof SYSTEM_PAGE_SPECS)[]
).filter((id) => SYSTEM_PAGE_SPECS[id].required);

/** True when a page resolves to a required system widget (authoritative table, not the page flag). */
function isRequiredSystemPage(p: OnboardingPage): boolean {
  return p.kind === 'widget' && !!p.widget && SYSTEM_PAGE_SPECS[p.widget]?.required === true;
}

/** A content page is "empty" if it has no title and no subtitle/body/features/resolvable image. */
function isEmptyContent(p: OnboardingPage): boolean {
  const hasTitle = !!(p.title && p.title.trim());
  const hasSubtitle = !!(p.subtitle && p.subtitle.trim());
  const hasBody = !!(p.body && p.body.trim());
  const hasFeatures = !!p.features;
  const hasImage = !!(p.image && p.image.src && p.image.src.trim());
  return !hasTitle || !(hasSubtitle || hasBody || hasFeatures || hasImage);
}

/**
 * Validate a flow + features bundle for PUBLISH. Returns blocking `errors` (Publish
 * disabled) and non-blocking `warnings` (Publish allowed with confirm). Pure; never
 * throws. Asset/media existence is checked ONLY server-side (the portal can't stat
 * files), so it does not appear here.
 *
 * BLOCKING (errors):
 *  - every required:true system widget exists in flow.pages;
 *  - the page order is topologically valid (dependsOn precedes);
 *  - 'completion' is the LAST page (no content after "You're all set!");
 *  - every condition references a KNOWN field + KNOWN op (eq/neq carry a value);
 *  - no required system page is hidden or conditioned.
 *
 * WARNING (non-blocking):
 *  - a mandatory page is empty (no title + no body/subtitle/features/image);
 *  - unsatisfiable conditions on a page (two 'eq' on the same field, different values).
 */
export function validateOnboarding(
  flow: OnboardingFlowConfig,
  _features: OnboardingFeaturesConfig,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const pages = Array.isArray(flow?.pages) ? flow.pages : [];

  // ── BLOCKING ────────────────────────────────────────────────────────────────

  // Required system pages present.
  const presentWidgets = new Set<string>();
  for (const p of pages) {
    if (p.kind === 'widget' && p.widget) presentWidgets.add(p.widget);
  }
  for (const required of REQUIRED_SYSTEM_WIDGET_IDS) {
    if (!presentWidgets.has(required)) {
      errors.push({
        code: 'missing-required-system-page',
        message: `Required system page "${required}" is missing from the flow.`,
      });
    }
  }

  // Topologically valid order.
  if (!isTopologicallyValid(pages)) {
    errors.push({
      code: 'topology-invalid',
      message: 'A system step appears before one of its prerequisites — reorder to a valid sequence.',
    });
  }

  // Completion must be the terminal page.
  if (pages.length > 0) {
    const last = pages[pages.length - 1];
    const completionIdx = pages.findIndex((p) => p.kind === 'widget' && p.widget === 'completion');
    if (completionIdx >= 0 && !(last.kind === 'widget' && last.widget === 'completion')) {
      errors.push({
        code: 'completion-not-terminal',
        message: 'The "completion" page must be the LAST page — no page may follow "You\'re all set!".',
        pageId: pages[completionIdx].id,
      });
    }
  }

  // Conditions: known field + known op; eq/neq carry a value.
  const knownFields = new Set<string>(ONBOARDING_CONDITION_FIELDS as readonly string[]);
  for (const p of pages) {
    for (const c of p.conditions ?? []) {
      if (!knownFields.has(c.field)) {
        errors.push({
          code: 'condition-unknown-field',
          message: `Page "${p.id}" has a condition on unknown field "${c.field}". Allowed: ${ONBOARDING_CONDITION_FIELDS.join(', ')}.`,
          pageId: p.id,
        });
      }
      if (!KNOWN_CONDITION_OPS.has(c.op)) {
        errors.push({
          code: 'condition-unknown-op',
          message: `Page "${p.id}" has a condition with unknown operator "${String(c.op)}". Allowed: eq, neq, truthy, falsy.`,
          pageId: p.id,
        });
      }
      if ((c.op === 'eq' || c.op === 'neq') && (c.value === undefined || c.value === null || c.value === '')) {
        errors.push({
          code: 'condition-missing-value',
          message: `Page "${p.id}" has an "${c.op}" condition with no value.`,
          pageId: p.id,
        });
      }
    }
  }

  // No required system page may be hidden or conditioned (the runtime force-keeps them
  // anyway; this keeps editor intent and runtime behavior honest).
  for (const p of pages) {
    if (!isRequiredSystemPage(p)) continue;
    if (p.hidden) {
      errors.push({
        code: 'required-page-hidden',
        message: `Required system page "${p.widget}" is marked hidden — it cannot be hidden.`,
        pageId: p.id,
      });
    }
    if ((p.conditions ?? []).length > 0) {
      errors.push({
        code: 'required-page-conditioned',
        message: `Required system page "${p.widget}" has conditions — it must always show, so remove them.`,
        pageId: p.id,
      });
    }
  }

  // ── WARNING ──────────────────────────────────────────────────────────────────

  // Mandatory page with no content.
  for (const p of pages) {
    if (p.mandatory && p.kind === 'content' && isEmptyContent(p)) {
      warnings.push({
        code: 'mandatory-page-empty',
        message: `Mandatory page "${p.id}" has no title or body — an empty un-skippable page is a dead end.`,
        pageId: p.id,
      });
    }
  }

  // Unsatisfiable conditions (best-effort): two 'eq' on the same field with different values.
  for (const p of pages) {
    const eqByField = new Map<string, Set<string>>();
    for (const c of p.conditions ?? []) {
      if (c.op !== 'eq' || c.value === undefined || c.value === null) continue;
      const set = eqByField.get(c.field) ?? new Set<string>();
      set.add(String(c.value));
      eqByField.set(c.field, set);
    }
    for (const [field, values] of eqByField) {
      if (values.size > 1) {
        warnings.push({
          code: 'condition-unsatisfiable',
          message: `Page "${p.id}" requires "${field}" to equal multiple different values — it can never show.`,
          pageId: p.id,
        });
      }
    }
  }

  return { errors, warnings };
}
