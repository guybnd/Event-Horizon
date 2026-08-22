import type { OnboardingPage, OnboardingWidgetId } from './onboardingFlow';

/**
 * Client-only bookkeeping for FLUX-1684 (per-step skip so global "Skip setup" can't
 * silently bypass CLI setup). No React import — consumed by both OnboardingWizard.tsx
 * and GeneralSection.tsx. Every localStorage access is wrapped in try/catch, mirroring
 * AppContext.tsx's CURRENT_USER_KEY handling, so a locked-down/unavailable localStorage
 * degrades to "nothing skipped" / "no resume" rather than throwing.
 */

const SKIPPED_KEY = 'eh-onboarding-skipped';
const RESUME_KEY = 'eh-onboarding-resume';
const ASSISTANT_KEY = 'eh-onboarding-assistant';

/** Anything that isn't an array of strings reads as "nothing skipped" — never throws. */
export function readSkippedSteps(): string[] {
  try {
    const raw = localStorage.getItem(SKIPPED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeSkippedSteps(ids: string[]): void {
  try {
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

/** Union the given ids into the recorded set (de-duped). */
export function recordSkippedSteps(ids: string[]): void {
  if (ids.length === 0) return;
  const existing = new Set(readSkippedSteps());
  ids.forEach((id) => existing.add(id));
  writeSkippedSteps(Array.from(existing));
}

/** Remove a single id from the recorded set — a step finished normally after being skipped. */
export function clearSkippedStep(id: string): void {
  const existing = readSkippedSteps();
  if (!existing.includes(id)) return;
  writeSkippedSteps(existing.filter((v) => v !== id));
}

export function clearSkippedSteps(): void {
  try {
    localStorage.removeItem(SKIPPED_KEY);
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

export function readResumeStep(): string | null {
  try {
    return localStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}

export function setResumeStep(id: string): void {
  try {
    localStorage.setItem(RESUME_KEY, id);
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

export function clearResumeStep(): void {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

export function readAssistant(): string | null {
  try {
    return localStorage.getItem(ASSISTANT_KEY);
  } catch {
    return null;
  }
}

export function setAssistant(id: string): void {
  try {
    localStorage.setItem(ASSISTANT_KEY, id);
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

/**
 * The ONLY definition of "a step worth recording, listing, counting or resuming at":
 * widget pages only (content pages carry their own advance cta and aren't setup),
 * excluding the terminal `completion` widget and the final entry of `pages` (whichever
 * page that is) — skipping-all can never be asked to "finish" the last screen. Callers
 * (OnboardingWizard's record/un-record, skip-all panel + count, GeneralSection's Finish
 * setup card) all route through this so they can't disagree.
 */
export function actionableSteps(pages: OnboardingPage[], fromIndex = 0): OnboardingPage[] {
  const sliced = pages.slice(fromIndex);
  return sliced.filter(
    (p, i) => p.kind === 'widget' && p.widget !== 'completion' && fromIndex + i !== pages.length - 1,
  );
}

/**
 * Which control(s) a skippable widget page offers. A total Record over
 * OnboardingWidgetId — adding a widget to SYSTEM_PAGE_SPECS fails typecheck until its
 * skip ownership is declared here, so the "a skippable step has a step-scoped skip"
 * invariant can't regress silently (the guard test in onboardingSkips.test.ts covers
 * the semantic half). 'never' and 'footer' are behaviourally identical today — only
 * 'own' is tested by pageOwnsSkip — kept distinct because it documents intent.
 */
export const WIDGET_SKIP: Record<OnboardingWidgetId, 'own' | 'footer' | 'never'> = {
  'pick-folder': 'never',
  'storage-mode': 'never',
  'pick-assistant': 'never',
  'github-cli': 'own',
  'install-skill': 'own',
  'bootstrap': 'own',
  'path-setup': 'own',
  'completion': 'never',
};

/** Does the page render its OWN inline skip/advance control already? If so a generic
 *  footer skip control must not duplicate it. */
export function pageOwnsSkip(p: OnboardingPage): boolean {
  if (p.kind === 'widget' && p.widget) return WIDGET_SKIP[p.widget] === 'own';
  return p.kind === 'content' && !!p.ctas?.some((c) => c.action === 'advance');
}
