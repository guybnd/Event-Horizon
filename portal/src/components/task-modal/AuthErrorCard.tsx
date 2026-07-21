import { AlertTriangle, RefreshCw } from 'lucide-react';
import { CopyButton } from '../CopyButton';
import { describeAuthRemedy } from '../../lib/authRemedy';
import type { AuthDiagnosis } from '../../types';

/**
 * FLUX-1601: replaces the raw provider 401 string in chat with an actionable card — a verdict-
 * specific headline + remedy (from the engine's self-diagnosis, FLUX-1599) instead of "Failed to
 * authenticate. API Error: 401 API key is invalid.". Shared with the Furnace halt banner
 * (FurnaceReportModal) via `describeAuthRemedy` so both surfaces say the same thing.
 */
export function AuthErrorCard({
  diagnosis,
  recovering = false,
}: {
  diagnosis?: AuthDiagnosis | null;
  /** True once the engine has broadcast that credentials changed and the turn is auto-retrying. */
  recovering?: boolean;
}) {
  const remedy = describeAuthRemedy(diagnosis);
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-[11px]"
      style={{ borderColor: 'rgba(239,68,68,.35)', background: 'rgba(239,68,68,.08)' }}
    >
      <div className="flex items-center gap-1.5 font-semibold text-red-500">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
        {remedy.headline}
      </div>
      <p className="text-[var(--eh-text-secondary)]">{remedy.detail}</p>
      {remedy.command && (
        <div className="flex items-center gap-1.5">
          <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/10">{remedy.command}</code>
          <CopyButton
            getText={() => remedy.command!}
            title="Copy command"
            className="rounded p-1 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
          />
        </div>
      )}
      {recovering && (
        <p className="flex items-center gap-1.5 font-medium text-emerald-500">
          <RefreshCw className="h-3 w-3 flex-shrink-0 animate-spin" />
          Credentials updated — retrying…
        </p>
      )}
    </div>
  );
}
