import { useState, useEffect } from 'react';
import { fetchSkillStatus, installWorkspaceSkill } from '../../api';
import type { AppView } from '../../AppContext';

interface AgentSectionProps {
  effortLevel: string;
  setEffortLevel: (v: string) => void;
  groomingModel: string;
  setGroomingModel: (v: string) => void;
  implementationModel: string;
  setImplementationModel: (v: string) => void;
  geminiGroomingModel: string;
  setGeminiGroomingModel: (v: string) => void;
  geminiImplementationModel: string;
  setGeminiImplementationModel: (v: string) => void;
  workspacePath: string | null;
  setView: (view: AppView) => void;
}

export function AgentSection({
  effortLevel,
  setEffortLevel,
  groomingModel,
  setGroomingModel,
  implementationModel,
  setImplementationModel,
  geminiGroomingModel,
  setGeminiGroomingModel,
  geminiImplementationModel,
  setGeminiImplementationModel,
  workspacePath,
  setView,
}: AgentSectionProps) {
  const [workflowInstalled, setWorkflowInstalled] = useState(false);
  const [skillInstalled, setSkillInstalled] = useState(false);
  const [skillSourcePaths, setSkillSourcePaths] = useState<string[]>([]);
  const [skillInstalledPath, setSkillInstalledPath] = useState('');
  const [instructionsInstalled, setInstructionsInstalled] = useState(false);
  const [instructionsSourcePath, setInstructionsSourcePath] = useState('');
  const [instructionsInstalledPath, setInstructionsInstalledPath] = useState('');
  const [skillLoading, setSkillLoading] = useState(true);
  const [skillInstalling, setSkillInstalling] = useState(false);
  const [targetFramework, setTargetFramework] = useState('auto');

  useEffect(() => {
    setSkillLoading(true);
    fetchSkillStatus(targetFramework)
      .then((status) => {
        setWorkflowInstalled(status.workflowInstalled);
        setSkillInstalled(status.skillInstalled);
        setSkillSourcePaths(status.skillSourcePaths ?? (status.skillSourcePath ? [status.skillSourcePath] : []));
        setSkillInstalledPath(status.skillInstalledPath);
        setInstructionsInstalled(status.instructionsInstalled);
        setInstructionsSourcePath(status.instructionsSourcePath || '');
        setInstructionsInstalledPath(status.instructionsInstalledPath || '');
      })
      .catch(console.error)
      .finally(() => setSkillLoading(false));
  }, [targetFramework]);

  const handleInstallSkill = async () => {
    setSkillInstalling(true);
    try {
      const result = await installWorkspaceSkill(targetFramework);
      setWorkflowInstalled(true);
      setSkillInstalled(true);
      setInstructionsInstalled(Boolean(result.instructionsInstalledPath));
      setSkillInstalledPath(result.skillInstalledPath);
      setInstructionsInstalledPath(result.instructionsInstalledPath || '');
      alert(`Installed Event Horizon workflow to ${result.skillInstalledPath}${result.instructionsInstalledPath ? `\nPatched instructions at ${result.instructionsInstalledPath}` : ''}`);
    } catch (error) {
      console.error(error);
      alert('Failed to install Event Horizon workflow');
    } finally {
      setSkillInstalling(false);
    }
  };

  const handleCopyInstallCommand = async () => {
    const targetPath = workspacePath ?? '/path/to/workspace';
    const command = `npm run install-skill -- --target "${targetPath}" --framework ${targetFramework}`;
    try {
      await navigator.clipboard.writeText(command);
      alert('Copied skill install command to clipboard');
    } catch (error) {
      console.error(error);
      alert(command);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Workflow</h3>
      <p className="text-xs text-gray-500 mb-4">Install and refresh the Event Horizon skill plus the always-on Copilot instructions for this workspace.</p>
      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Target Framework</div>
              <div className="mt-1">
                <select
                  value={targetFramework}
                  onChange={(e) => setTargetFramework(e.target.value)}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                >
                  <option value="auto">Auto-Detect</option>
                  <option value="copilot">GitHub Copilot</option>
                  <option value="cursor">Cursor</option>
                  <option value="cline">Cline</option>
                  <option value="windsurf">Windsurf</option>
                  <option value="claude">Claude Code</option>
                  <option value="antigravity">Antigravity</option>
                  <option value="gemini">Gemini CLI</option>
                  <option value="generic">Generic / Other</option>
                </select>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Status</div>
              <div className="mt-1 font-medium">{skillLoading ? 'Checking…' : workflowInstalled ? 'Installed in this repo' : 'Not fully installed in this repo'}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Source Skills</div>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Edit these files to customise the agent workflow; re-run Install to propagate.</p>
              <div className="mt-2 space-y-1.5">
                {(skillSourcePaths.length > 0 ? skillSourcePaths : [
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
            {instructionsSourcePath && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Instructions Source</div>
                <div className="mt-1 break-all">{instructionsSourcePath}</div>
              </div>
            )}
            {instructionsInstalledPath && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Instructions Path</div>
                <div className="mt-1 break-all">{instructionsInstalledPath}</div>
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-1 text-xs font-medium">
              <span className={`rounded-full px-2.5 py-1 ${skillInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                Skill: {skillInstalled ? 'Installed' : 'Missing'}
              </span>
              {(instructionsSourcePath || instructionsInstalledPath) && (
                <span className={`rounded-full px-2.5 py-1 ${instructionsInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                  Instructions: {instructionsInstalled ? 'Installed' : 'Missing/Unpatched'}
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
              {skillInstalling ? 'Installing…' : workflowInstalled ? 'Reinstall Workflow' : 'Install Workflow'}
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

      <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
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

      {(targetFramework === 'claude' || targetFramework === 'auto') && (
        <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Claude Code Models</h3>
          <p className="text-xs text-gray-500 mb-4">Model IDs passed via <code className="text-xs font-mono">--model</code> when launching sessions. Grooming-phase tickets use the grooming model; all others use the implementation model.</p>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Grooming model
              </label>
              <input
                type="text"
                value={groomingModel}
                onChange={(e) => setGroomingModel(e.target.value)}
                placeholder="Leave blank to use Claude Code default"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-mono outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Implementation model
              </label>
              <input
                type="text"
                value={implementationModel}
                onChange={(e) => setImplementationModel(e.target.value)}
                placeholder="Leave blank to use Claude Code default"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-mono outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
              />
            </div>
          </div>
        </div>
      )}

      {(targetFramework === 'gemini' || targetFramework === 'auto') && (
        <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Gemini CLI Models</h3>
          <p className="text-xs text-gray-500 mb-4">Model IDs passed via <code className="text-xs font-mono">--model</code> when launching sessions. Grooming-phase tickets use the grooming model; all others use the implementation model.</p>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Grooming model
              </label>
              <input
                type="text"
                value={geminiGroomingModel}
                onChange={(e) => setGeminiGroomingModel(e.target.value)}
                placeholder="Leave blank to use Gemini CLI default"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-mono outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Implementation model
              </label>
              <input
                type="text"
                value={geminiImplementationModel}
                onChange={(e) => setGeminiImplementationModel(e.target.value)}
                placeholder="Leave blank to use Gemini CLI default"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-mono outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
