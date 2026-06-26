import { SettingToggleCard } from './shared';
import { WorktreesPanel } from './WorktreesPanel';

interface WorktreeSectionProps {
  worktreeByDefault: boolean;
  setWorktreeByDefault: (v: boolean) => void;
}

export function WorktreeSection({ worktreeByDefault, setWorktreeByDefault }: WorktreeSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Worktrees</h3>
        <p className="text-xs text-gray-500 mb-2 text-balance">Isolated git worktrees keep concurrent task branches from colliding and leave your main branch untouched.</p>
      </div>

      <SettingToggleCard
        title="Dedicated Worktree by Default"
        description="When starting a task with a branch, default the 'dedicated worktree' choice on — the agent runs in an isolated git worktree so master stays put and concurrent tasks never collide. Overridable per launch."
        checked={worktreeByDefault}
        onChange={setWorktreeByDefault}
      />

      <WorktreesPanel />
    </div>
  );
}
