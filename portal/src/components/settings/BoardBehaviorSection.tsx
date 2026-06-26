import type { BoardCardOpenMode } from '../../types';
import { SettingToggleCard } from './shared';

interface BoardBehaviorSectionProps {
  boardCardOpenMode: BoardCardOpenMode;
  setBoardCardOpenMode: (v: BoardCardOpenMode) => void;
  requireComment: boolean;
  setRequireComment: (v: boolean) => void;
  enableBacklog: boolean;
  setEnableBacklog: (v: boolean) => void;
  hoverPopupsEnabled: boolean;
  setHoverPopupsEnabled: (v: boolean) => void;
  hoverPopupDelay: number;
  setHoverPopupDelay: (v: number) => void;
  commentHoverPreviewEnabled: boolean;
  setCommentHoverPreviewEnabled: (v: boolean) => void;
}

export function BoardBehaviorSection({
  boardCardOpenMode,
  setBoardCardOpenMode,
  requireComment,
  setRequireComment,
  enableBacklog,
  setEnableBacklog,
  hoverPopupsEnabled,
  setHoverPopupsEnabled,
  hoverPopupDelay,
  setHoverPopupDelay,
  commentHoverPreviewEnabled,
  setCommentHoverPreviewEnabled,
}: BoardBehaviorSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Board Behavior</h3>
        <p className="text-xs text-gray-500 mb-2 text-balance">How the board reacts when you open cards, move tickets, and hover.</p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Card Click Behavior</span>
            <span className="text-xs text-gray-500">Choose what opening a ticket (board card, search, notifications, links) does: the chat-aligned view with the ticket panel, the full ticket view, or the popup editor. The default is chat view.</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-black/20">
            {(['chat', 'full', 'popup'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBoardCardOpenMode(mode)}
                className={`rounded-lg px-3 py-2 text-sm font-medium capitalize transition-colors ${boardCardOpenMode === mode ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
              >
                {mode} View
              </button>
            ))}
          </div>
        </div>
      </div>

      <SettingToggleCard
        title="Require Comment on Status Change"
        description="Prompt for a comment pop-up when dragging a task to a new column on the board."
        checked={requireComment}
        onChange={setRequireComment}
      />

      <SettingToggleCard
        title="Enable Backlog Screen"
        description="If disabled, the backlog will simply appear as a normal column on the board (if not listed in Hidden Statuses)."
        checked={enableBacklog}
        onChange={setEnableBacklog}
      />

      <SettingToggleCard
        title="Card Hover Preview"
        description="Show full description popup on hover. Optionally configure the delay in ms."
        checked={hoverPopupsEnabled}
        onChange={setHoverPopupsEnabled}
      >
        {hoverPopupsEnabled && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">Delay (ms)</span>
            <input
              type="number"
              value={hoverPopupDelay}
              onChange={(e) => setHoverPopupDelay(Number(e.target.value) || 1500)}
              className="w-20 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
              min="0"
              step="100"
            />
          </div>
        )}
      </SettingToggleCard>

      <SettingToggleCard
        title="Comment Hover Preview"
        description="Open a card's comment popover when you hover its comment badge. Off by default — clicking the badge always opens it."
        checked={commentHoverPreviewEnabled}
        onChange={setCommentHoverPreviewEnabled}
      />
    </div>
  );
}
