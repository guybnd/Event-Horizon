import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { FrameworkSelector } from '../FrameworkSelector';
import type { SkillStatusState } from './useSkillStatus';

interface AgentDefaultsSectionProps {
  effortLevel: string;
  setEffortLevel: (v: string) => void;
  targetFramework: string;
  setTargetFramework: (v: string) => void;
  boardPermissionDefault: 'gated' | 'skip';
  setBoardPermissionDefault: (v: 'gated' | 'skip') => void;
  ticketPermissionDefault: 'gated' | 'skip';
  setTicketPermissionDefault: (v: 'gated' | 'skip') => void;
  skillStatus: SkillStatusState;
}

/** FLUX-1373: default-agent picker + effort + permission risk tolerance — the frequently-visited
 *  session defaults, split out of the old grab-bag `AgentSection`. Carries the install-status
 *  warning badge next to the picker (previously buried in the bottom install card). */
export function AgentDefaultsSection({
  effortLevel,
  setEffortLevel,
  targetFramework,
  setTargetFramework,
  boardPermissionDefault,
  setBoardPermissionDefault,
  ticketPermissionDefault,
  setTicketPermissionDefault,
  skillStatus,
}: AgentDefaultsSectionProps) {
  return (
    <div id="agent-session-defaults" className="space-y-4">
      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Session Defaults</h3>
        <p className="text-xs text-gray-500 mb-4">The CLI that launches sessions when a ticket doesn&apos;t specify one.</p>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Default agent</div>
          <div className="flex items-center gap-2">
            <div className="w-64">
              <FrameworkSelector value={targetFramework} onChange={setTargetFramework} showAuto />
            </div>
            {!skillStatus.loading && !skillStatus.workflowInstalled && (
              <span
                title="The Event Horizon skill isn't installed for this framework yet — see Agent workflow install below."
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
              >
                <AlertTriangle className="h-3 w-3" /> Not installed
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Session Cost Controls</h3>
        <p className="text-xs text-gray-500 mb-4">Controls the effort level passed to Claude Code sessions via <code className="text-xs font-mono">--effort</code>. Lower effort = faster and cheaper. Other providers ignore this flag.</p>
        <div>
          <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
            Default effort level
          </label>
          <select
            value={effortLevel}
            onChange={(e) => setEffortLevel(e.target.value)}
            className="w-40 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <div className="flex items-center gap-2 mb-1">
          <ShieldAlert className="h-5 w-5 text-amber-500" />
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200">Permission Risk Tolerance</h3>
        </div>
        <p className="text-xs text-gray-500 mb-4 ml-7">
          Default permission mode per session surface. <strong>Gated</strong> routes destructive
          ops (status changes, deletes, branch ops, <code className="text-xs font-mono">Bash</code>)
          through a human Allow/Deny prompt via <code className="text-xs font-mono">--permission-prompt-tool</code>;
          <strong> Skip</strong> runs ungated (<code className="text-xs font-mono">--dangerously-skip-permissions</code>).
          The per-chat <strong>Perms</strong> picker inherits these when left on “Default”.
        </p>
        <div className="ml-7 flex flex-wrap gap-6">
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              Orchestrator (board) sessions
            </label>
            <select
              value={boardPermissionDefault}
              onChange={(e) => setBoardPermissionDefault(e.target.value as 'gated' | 'skip')}
              className="w-48 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
            >
              <option value="gated">Gated (ask to approve)</option>
              <option value="skip">Skip (no prompt)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              Per-ticket sessions
            </label>
            <select
              value={ticketPermissionDefault}
              onChange={(e) => setTicketPermissionDefault(e.target.value as 'gated' | 'skip')}
              className="w-48 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
            >
              <option value="gated">Gated (ask to approve)</option>
              <option value="skip">Skip (no prompt)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
