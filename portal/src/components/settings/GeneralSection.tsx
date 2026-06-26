import { useDesktopNotifications } from '../../hooks/useDesktopNotifications';
import { useNotificationPrefs } from '../../hooks/useNotificationPrefs';
import { SettingToggleCard } from './shared';

/**
 * FLUX-695: toggle for OS notifications on turn completion in an unfocused chat. Self-contained —
 * backed by `localStorage` + browser permission via `useDesktopNotifications` (a client/browser
 * concern, not server config), so it stays an instant action rather than joining the Save bar.
 */
function DesktopNotificationsCard() {
  const { enabled, permission, supported, native, enable, disable } = useDesktopNotifications();
  const blocked = !native && supported && permission === 'denied';
  const unsupported = !native && !supported;
  const description = unsupported
    ? 'Your browser does not support desktop notifications.'
    : blocked
      ? 'Notifications are blocked for this site. Allow them in your browser settings, then re-enable here.'
      : 'Get an OS notification when an agent finishes a turn in a chat you are not currently looking at. Requires one-time browser permission. Inside the VS Code extension, the native notification surface is used automatically.';
  return (
    <SettingToggleCard
      title="Desktop Notifications on Turn Completion"
      description={description}
      checked={enabled}
      onChange={(v) => {
        if (v) void enable();
        else disable();
      }}
    />
  );
}

/**
 * FLUX-726: which in-app "Updates" appear in the notification panel + bell counter. Only the
 * low-priority Update types are toggleable — Action-needed (Require Input, errors) can never be
 * muted (that would reintroduce the "missed on the board" failure mode, FLUX-570/651). Client-side
 * localStorage prefs (instant, not part of the Save bar).
 */
function NotificationsCard() {
  const { prefs, setShowCompletion, setShowInfo } = useNotificationPrefs();
  return (
    <>
      <SettingToggleCard
        title="Show “Done” updates"
        description="Notify when a ticket is completed. Action-needed notifications (questions, errors) are always shown."
        checked={prefs.showCompletion}
        onChange={setShowCompletion}
      />
      <SettingToggleCard
        title="Show info updates"
        description="Lower-priority FYI notifications, like an available app update."
        checked={prefs.showInfo}
        onChange={setShowInfo}
      />
    </>
  );
}

interface GeneralSectionProps {
  /** Global (cross-workspace) settings, lifted into the parent so they save through the one
   *  unified Save bar alongside workspace config (no separate "Save Global Settings" button). */
  defaultUser: string;
  setDefaultUser: (v: string) => void;
  preferredFramework: string;
  setPreferredFramework: (v: string) => void;
  port: number;
  setPort: (v: number) => void;
  globalLoading: boolean;
  globalError: string | null;
  migratedFrom?: string;
}

export function GeneralSection({
  defaultUser,
  setDefaultUser,
  preferredFramework,
  setPreferredFramework,
  port,
  setPort,
  globalLoading,
  globalError,
  migratedFrom,
}: GeneralSectionProps) {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Global Preferences</h3>
          <p className="text-xs text-gray-500 mb-5">These settings apply across all workspaces and are stored in your system's app data directory. They save with the same Save bar as everything else.</p>

          {migratedFrom && (
            <div className="mb-4 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-500/20 p-3">
              <p className="text-xs text-blue-700 dark:text-blue-400">
                Migrated from: <code className="rounded bg-blue-100 dark:bg-blue-900/30 px-1">{migratedFrom}</code>
              </p>
            </div>
          )}

          {globalLoading ? (
            <p className="text-sm text-gray-500">Loading global settings…</p>
          ) : (
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Default User</label>
                <input
                  type="text"
                  value={defaultUser}
                  onChange={(e) => setDefaultUser(e.target.value)}
                  placeholder="Your name"
                  className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <p className="mt-1 text-[11px] text-gray-500">Used as the default assignee when creating tickets.</p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Preferred Framework</label>
                <select
                  value={preferredFramework}
                  onChange={(e) => setPreferredFramework(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                >
                  <option value="">Auto-detect</option>
                  <option value="claude">Claude Code</option>
                  <option value="copilot">GitHub Copilot</option>
                  <option value="cursor">Cursor</option>
                  <option value="cline">Cline</option>
                  <option value="windsurf">Windsurf</option>
                  <option value="gemini">Gemini CLI</option>
                  <option value="generic">Generic</option>
                </select>
                <p className="mt-1 text-[11px] text-gray-500">Used when bootstrapping new workspaces.</p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Engine Port</label>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(parseInt(e.target.value, 10) || 3067)}
                  className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <p className="mt-1 text-[11px] text-gray-500">Takes effect on next restart.</p>
              </div>
            </div>
          )}

          {globalError && <p className="mt-4 text-xs text-red-500">{globalError}</p>}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Notifications</h3>
          <p className="text-xs text-gray-500 mb-2 text-balance">In-app and OS notifications. Applied instantly — these aren't part of the Save bar.</p>
        </div>
        <NotificationsCard />
        <DesktopNotificationsCard />
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Maintenance</h3>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Restart Onboarding Wizard</span>
              <span className="text-xs text-gray-500">Re-run the first-time setup wizard on next page reload.</span>
            </div>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem('eh-onboarding-complete');
                window.location.reload();
              }}
              className="shrink-0 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
            >
              Restart Setup
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
