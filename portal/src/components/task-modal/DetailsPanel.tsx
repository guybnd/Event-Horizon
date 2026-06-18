import { Trash2 } from 'lucide-react';
import { CliSessionPanel } from './CliSessionPanel';
import { RunView } from './RunView';
import type { TaskModalController } from '../../hooks/useTaskModalController';

type DetailsPanelProps = Pick<TaskModalController,
  | 'modalTask'
  | 'currentUser'
  | 'createdAt'
  | 'updatedAt'
  | 'effort'
  | 'implementationLink'
  | 'activeRunGroup'
  | 'config'
  | 'cliSession'
  | 'cliSessionBusy'
  | 'cliSessionError'
  | 'selectedCliFramework'
  | 'setSelectedCliFramework'
  | 'skipPermissions'
  | 'setSkipPermissions'
  | 'sessionIsActive'
  | 'liveOutputRef'
  | 'saveConfig'
  | 'stopSession'
  | 'stopGroup'
  | 'handleLaunchWithBranchCheck'
  | 'setConfirmDelete'
>;

export function DetailsPanel({
  modalTask,
  currentUser,
  createdAt,
  updatedAt,
  effort,
  implementationLink,
  activeRunGroup,
  config,
  cliSession,
  cliSessionBusy,
  cliSessionError,
  selectedCliFramework,
  setSelectedCliFramework,
  skipPermissions,
  setSkipPermissions,
  sessionIsActive,
  liveOutputRef,
  saveConfig,
  stopSession,
  stopGroup,
  handleLaunchWithBranchCheck,
  setConfirmDelete,
}: DetailsPanelProps) {
  return (
    <div className="space-y-4 rounded-xl border border-gray-100 bg-white/70 p-4 dark:border-white/5 dark:bg-white/5">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Ticket</p>
        <p className="mt-1 text-sm font-semibold text-gray-800 dark:text-gray-200">{modalTask?.id || 'New Task'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Created By</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{modalTask?.createdBy || currentUser}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Updated By</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{modalTask?.updatedBy || currentUser}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Created</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{createdAt ? new Date(createdAt).toLocaleString() : 'Not recorded'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Last Activity</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{updatedAt ? new Date(updatedAt).toLocaleString() : 'Not recorded'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Effort</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{effort && effort !== 'None' ? effort : 'Not set'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Implementation Link</p>
        {implementationLink.trim() ? (
          implementationLink.trim().startsWith('https://github.com') ? (
            <a
              href={implementationLink.trim()}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20"
            >
              View PR ↗
            </a>
          ) : (
            <a
              href={implementationLink.trim()}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-all font-mono text-xs text-primary underline underline-offset-2"
            >
              {implementationLink.trim()}
            </a>
          )
        ) : (
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">Not set</p>
        )}
      </div>
      {modalTask?.id && (
        activeRunGroup ? (
          <RunView
            group={activeRunGroup}
            config={config}
            busy={cliSessionBusy}
            onStopSession={(sessionId) => void stopSession(sessionId)}
            onStopAll={() => void stopGroup(activeRunGroup.groupId)}
          />
        ) : (
        <CliSessionPanel
          cliSession={cliSession}
          cliSessionBusy={cliSessionBusy}
          cliSessionError={cliSessionError}
          selectedCliFramework={selectedCliFramework}
          setSelectedCliFramework={setSelectedCliFramework}
          skipPermissions={skipPermissions}
          setSkipPermissions={setSkipPermissions}
          sessionIsActive={sessionIsActive}
          liveOutputRef={liveOutputRef}
          config={config}
          tokenMetadata={modalTask.tokenMetadata}
          onLaunch={handleLaunchWithBranchCheck}
          onStop={stopSession}
          onToggleDisplayMode={config ? () => void saveConfig({ ...config, tokenDisplayMode: config.tokenDisplayMode === 'tokens' ? 'cost' : 'tokens' }) : undefined}
        />
        )
      )}
      {modalTask?.id && (
        <button
          onClick={() => setConfirmDelete(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" />
          Delete Task
        </button>
      )}
    </div>
  );
}
