import { useState } from 'react';
import { installWorkspaceSkill } from '../../api';
import type { AppView } from '../../AppContext';
import type { SkillStatusState } from './useSkillStatus';
import { useNotify } from '../../hooks/useNotify';

interface AgentWorkflowSectionProps {
  targetFramework: string;
  workspacePath: string | null;
  setView: (view: AppView) => void;
  skillStatus: SkillStatusState;
}

/** FLUX-1373: install mechanics only (source paths, install button) — the target-framework picker
 *  and install-status badge moved up to `AgentDefaultsSection`. One-time setup, rarely revisited,
 *  so it lives at the bottom of the Agents tab. Shares `skillStatus` (see `useSkillStatus`) rather
 *  than re-fetching. */
export function AgentWorkflowSection({ targetFramework, workspacePath, setView, skillStatus }: AgentWorkflowSectionProps) {
  const [skillInstalling, setSkillInstalling] = useState(false);
  const [installOverride, setInstallOverride] = useState<{ skillInstalledPath: string; instructionsInstalledPath: string } | null>(null);
  const notify = useNotify();

  const handleInstallSkill = async () => {
    setSkillInstalling(true);
    try {
      const result = await installWorkspaceSkill(targetFramework);
      setInstallOverride({ skillInstalledPath: result.skillInstalledPath, instructionsInstalledPath: result.instructionsInstalledPath || '' });
      skillStatus.refresh();
      notify.success(`Installed Event Horizon workflow to ${result.skillInstalledPath}${result.instructionsInstalledPath ? `\nPatched instructions at ${result.instructionsInstalledPath}` : ''}`);
    } catch (error) {
      console.error(error);
      notify.error(error instanceof Error ? error.message : 'Failed to install Event Horizon workflow');
    } finally {
      setSkillInstalling(false);
    }
  };

  const handleCopyInstallCommand = async () => {
    const targetPath = workspacePath ?? '/path/to/workspace';
    const command = `npm run install-skill -- --target "${targetPath}" --framework ${targetFramework}`;
    try {
      await navigator.clipboard.writeText(command);
      notify.success('Copied skill install command to clipboard');
    } catch (error) {
      console.error(error);
      notify.info(command);
    }
  };

  const skillInstalledPath = installOverride?.skillInstalledPath || skillStatus.skillInstalledPath;
  const instructionsInstalledPath = installOverride?.instructionsInstalledPath || skillStatus.instructionsInstalledPath;

  return (
    <div className="space-y-4">
      <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Workflow</h3>
      <p className="text-xs text-gray-500 mb-4">Install and refresh the Event Horizon skill plus the always-on Copilot instructions for this workspace. Change the target framework in Session Defaults above.</p>
      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300 min-w-0 flex-1">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Status</div>
              <div className="mt-1 font-medium">{skillStatus.loading ? 'Checking…' : skillStatus.workflowInstalled ? 'Installed in this repo' : 'Not fully installed in this repo'}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Source Skills</div>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Edit these files to customise the agent workflow; re-run Install to propagate.</p>
              <div className="mt-2 space-y-1.5">
                {(skillStatus.skillSourcePaths.length > 0 ? skillStatus.skillSourcePaths : [
                  '.docs/skills/event-horizon-orchestrator.md',
                  '.docs/skills/event-horizon-grooming.md',
                  '.docs/skills/event-horizon-implementation.md',
                  '.docs/skills/event-horizon-release.md',
                ]).map((p) => {
                  const basename = p.split('/').pop()?.replace('.md', '') ?? p;
                  const normalized = p.replace(/\\/g, '/');
                  const docsIdx = normalized.indexOf('/.docs/');
                  const docsRelative = docsIdx !== -1 ? normalized.slice(docsIdx + 7) : (normalized.split('/').pop() ?? p);
                  const docParam = docsRelative.replace(/\.md$/, '');
                  return (
                    <button
                      key={p}
                      type="button"
                      title={p}
                      onClick={() => {
                        const url = new URL(window.location.href);
                        url.pathname = '/docs';
                        url.searchParams.set('doc', docParam);
                        window.history.pushState({}, '', url.toString());
                        window.dispatchEvent(new CustomEvent('flux:navigate'));
                        setView('docs');
                      }}
                      className="flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:border-primary/40 hover:bg-primary/5 dark:border-white/10 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-white/5"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{basename}</span>
                      <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Workspace Skill Path</div>
              <div className="mt-1 break-all">{skillInstalledPath || '.github/skills/event-horizon/orchestrator.md'}</div>
            </div>
            {skillStatus.instructionsSourcePath && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Instructions Source</div>
                <div className="mt-1 break-all">{skillStatus.instructionsSourcePath}</div>
              </div>
            )}
            {instructionsInstalledPath && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Instructions Path</div>
                <div className="mt-1 break-all">{instructionsInstalledPath}</div>
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-1 text-xs font-medium">
              <span className={`rounded-full px-2.5 py-1 ${skillStatus.skillInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                Skill: {skillStatus.skillInstalled ? 'Installed' : 'Missing'}
              </span>
              {(skillStatus.instructionsSourcePath || instructionsInstalledPath) && (
                <span className={`rounded-full px-2.5 py-1 ${skillStatus.instructionsInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                  Instructions: {skillStatus.instructionsInstalled ? 'Installed' : 'Missing/Unpatched'}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-3">
            <button
              onClick={handleInstallSkill}
              disabled={skillInstalling}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${skillInstalling ? 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500' : 'bg-primary text-white hover:bg-primary-hover'}`}
            >
              {skillInstalling ? 'Installing…' : skillStatus.workflowInstalled ? `Update ${targetFramework === 'auto' ? 'Agent' : targetFramework} Skill` : `Install ${targetFramework === 'auto' ? 'Agent' : targetFramework} Skill`}
            </button>
            <button
              onClick={handleCopyInstallCommand}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              Copy Install Command
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
