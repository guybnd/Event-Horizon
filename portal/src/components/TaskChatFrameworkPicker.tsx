import { useCallback } from 'react';
import { FrameworkSelector, type ExtendedFramework } from './FrameworkSelector';
import { runtimeFrameworks, resolveEffectiveAgent } from '../utils';
import { useConfirm } from '../hooks/useConfirm';
import { stopTaskCliSession } from '../api';
import type { CliSessionSummary, Config } from '../types';
import type { ComposerSelections } from './DockProvider';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'waiting-input']);

export interface TaskChatFrameworkPickerProps {
  taskId: string;
  config: Config | null | undefined;
  /** The task's live CLI session (if any) — used to detect an active turn to confirm-stop, and to
   *  show what's actually running when the chat has no sticky override yet. */
  session?: CliSessionSummary | null;
  /** This chat window's persisted composer selections (model/effort/permission/framework). */
  selections?: ComposerSelections;
  onSelectionsChange: (selections: ComposerSelections) => void;
  /** The workspace's configured default agent — the floor when neither an override nor a live
   *  session says otherwise. */
  defaultFramework?: string;
}

/**
 * FLUX-1706: a per-task-chat CLI switcher scoped to THIS floating chat window only — picking a
 * framework here never touches the workspace's default agent (`config.defaultFramework`). Reuses
 * `FrameworkSelector`, restricted to `runtimeFrameworks` so install-only frameworks (cursor/cline/
 * windsurf/antigravity/generic) never appear as choices.
 *
 * The chosen value is a STICKY override persisted in the dock's per-conversation
 * `selections.framework` (see `ComposerSelections`) — `useChatSession` reads it and applies it only
 * to the NEXT fresh session start (`startTaskCliSessionEx`); an already-running process is never
 * retargeted. If a session is currently active, switching requires confirmation and stops that
 * session first — a failed stop leaves the picker showing the previous selection instead of
 * silently flipping to a value that never actually took effect.
 */
export function TaskChatFrameworkPicker({
  taskId,
  config,
  session,
  selections,
  onSelectionsChange,
  defaultFramework,
}: TaskChatFrameworkPickerProps) {
  const confirm = useConfirm();
  const allowed = runtimeFrameworks(config) as ExtendedFramework[];
  // The sticky override wins once set (reflects the user's intent immediately, even before the
  // next session starts); otherwise show what's actually running/last ran, then the workspace
  // default via resolveEffectiveAgent (the engine-resolved default — no framework hardcoded here).
  const current = resolveEffectiveAgent(selections?.framework || session?.framework, defaultFramework);
  const sessionActive = !!session && ACTIVE_STATUSES.has(session.status);

  const handleChange = useCallback(
    async (next: string) => {
      if (next === current) return;
      if (sessionActive) {
        const ok = await confirm({
          title: "Switch this chat's CLI?",
          body: "The active session stops now. Your chat history stays — the next message starts a fresh turn under the newly selected CLI.",
          confirmLabel: 'Stop & switch',
        });
        if (!ok) return;
        try {
          await stopTaskCliSession(taskId);
        } catch {
          // Stop failed — leave the picker showing the previous selection rather than displaying
          // a choice that never actually took effect.
          return;
        }
      }
      onSelectionsChange({ ...selections, framework: next });
    },
    [current, sessionActive, confirm, taskId, selections, onSelectionsChange],
  );

  return (
    <div
      className="w-32 shrink-0 text-xs"
      onPointerDown={(e) => e.stopPropagation()}
      title="This chat's CLI — doesn't change the workspace default"
    >
      <FrameworkSelector value={current} onChange={(v) => void handleChange(v)} allowedFrameworks={allowed} />
    </div>
  );
}
