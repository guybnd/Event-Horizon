import type { CompletionPayload } from '../types';

/**
 * True when a completion payload has at least one populated field. An explicit `{}` (or one
 * carrying only empty arrays) must render nothing extra — this is the pure gate `CompletionSummary`
 * defers to, kept in its own module (not co-exported from the component file) so it stays fast-
 * refresh-clean and testable without mounting React.
 */
export function hasCompletionContent(completion: CompletionPayload | null | undefined): boolean {
  if (!completion) return false;
  return Boolean(
    (completion.changedFiles && completion.changedFiles.length > 0) ||
    (completion.validation && completion.validation.length > 0) ||
    (completion.decisions && completion.decisions.length > 0) ||
    (completion.residualRisk && completion.residualRisk.length > 0) ||
    (Array.isArray(completion.docsUpdated) ? completion.docsUpdated.length > 0 : completion.docsUpdated !== undefined),
  );
}
