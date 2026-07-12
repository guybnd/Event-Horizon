import { useEffect, useState } from 'react';
import { fetchSkillStatus } from '../../api';

export interface SkillStatusState {
  loading: boolean;
  workflowInstalled: boolean;
  skillInstalled: boolean;
  skillSourcePaths: string[];
  skillInstalledPath: string;
  instructionsInstalled: boolean;
  instructionsSourcePath: string;
  instructionsInstalledPath: string;
  /** Re-fetch after an install (the install POST already returns fresh paths for immediate
   *  display; this brings `workflowInstalled`/`skillInstalled` in the OTHER consumer up to date). */
  refresh: () => void;
}

/** FLUX-1373: single fetch shared by AgentDefaultsSection (install-status badge) and
 *  AgentWorkflowSection (install mechanics) — call this ONCE per render tree (in Settings.tsx)
 *  and pass the result down as a prop so the two cards don't each fetch independently. */
export function useSkillStatus(framework: string): SkillStatusState {
  const [loading, setLoading] = useState(true);
  const [workflowInstalled, setWorkflowInstalled] = useState(false);
  const [skillInstalled, setSkillInstalled] = useState(false);
  const [skillSourcePaths, setSkillSourcePaths] = useState<string[]>([]);
  const [skillInstalledPath, setSkillInstalledPath] = useState('');
  const [instructionsInstalled, setInstructionsInstalled] = useState(false);
  const [instructionsSourcePath, setInstructionsSourcePath] = useState('');
  const [instructionsInstalledPath, setInstructionsInstalledPath] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSkillStatus(framework)
      .then((status) => {
        if (cancelled) return;
        setWorkflowInstalled(status.workflowInstalled);
        setSkillInstalled(status.skillInstalled);
        setSkillSourcePaths(status.skillSourcePaths ?? (status.skillSourcePath ? [status.skillSourcePath] : []));
        setSkillInstalledPath(status.skillInstalledPath);
        setInstructionsInstalled(status.instructionsInstalled);
        setInstructionsSourcePath(status.instructionsSourcePath || '');
        setInstructionsInstalledPath(status.instructionsInstalledPath || '');
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [framework, nonce]);

  return {
    loading,
    workflowInstalled,
    skillInstalled,
    skillSourcePaths,
    skillInstalledPath,
    instructionsInstalled,
    instructionsSourcePath,
    instructionsInstalledPath,
    refresh: () => setNonce((n) => n + 1),
  };
}
