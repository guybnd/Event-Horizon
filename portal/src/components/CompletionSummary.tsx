import { CheckCircle2, XCircle, FileText, AlertTriangle, ListChecks } from 'lucide-react';
import type { CompletionPayload } from '../types';
import { hasCompletionContent } from '../lib/completionSummary';

interface CompletionSummaryProps {
  completion: CompletionPayload | null | undefined;
}

/**
 * FLUX-1147: structured rendering of a `completion` payload attached to a `comment` history entry
 * (changed files, validation pass/fail, decisions, residual risk, docs updated) — the reviewer /
 * next implementer reads fields instead of the author dumping raw JSON into the comment prose.
 * Styling mirrors `DiffSummaryPanel`'s compact bordered-list treatment. Renders nothing when there
 * is nothing to show (see `hasCompletionContent`).
 */
export function CompletionSummary({ completion }: CompletionSummaryProps) {
  if (!hasCompletionContent(completion)) return null;
  const c = completion as CompletionPayload;

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-gray-100 bg-white/60 p-2.5 text-xs dark:border-white/5 dark:bg-black/10">
      {c.changedFiles && c.changedFiles.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
            <FileText className="h-3 w-3" /> Changed files ({c.changedFiles.length})
          </p>
          <ul className="space-y-0.5">
            {c.changedFiles.map((f) => (
              <li key={f} className="truncate font-mono text-[11px] text-gray-600 dark:text-gray-400">{f}</li>
            ))}
          </ul>
        </div>
      )}

      {c.validation && c.validation.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
            <ListChecks className="h-3 w-3" /> Validation
          </p>
          <ul className="space-y-0.5">
            {c.validation.map((v, i) => (
              <li key={`${v.command}-${i}`} className="flex items-center gap-1.5">
                {v.passed
                  ? <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                  : <XCircle className="h-3 w-3 shrink-0 text-red-500" />}
                <span className="truncate font-mono text-[11px] text-gray-600 dark:text-gray-400">{v.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.decisions && c.decisions.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Decisions</p>
          <ul className="list-disc space-y-0.5 pl-4 text-gray-600 dark:text-gray-400">
            {c.decisions.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </div>
      )}

      {c.residualRisk && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-500">
            <AlertTriangle className="h-3 w-3" /> Residual risk
          </p>
          <p className="text-gray-600 dark:text-gray-400">{c.residualRisk}</p>
        </div>
      )}

      {c.docsUpdated !== undefined && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          <span className="font-semibold">Docs updated:</span>{' '}
          {Array.isArray(c.docsUpdated)
            ? (c.docsUpdated.length > 0 ? c.docsUpdated.join(', ') : 'none')
            : (c.docsUpdated ? 'yes' : 'no')}
        </div>
      )}
    </div>
  );
}
