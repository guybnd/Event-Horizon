import { useState, useEffect, useCallback } from 'react';
import { fetchGlobalSettings, updateGlobalSettings, type GlobalSettings } from '../../api';

export function GlobalSection() {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [defaultUser, setDefaultUser] = useState('');
  const [preferredFramework, setPreferredFramework] = useState('');
  const [port, setPort] = useState(3067);
  const [boardClickBehavior, setBoardClickBehavior] = useState<'modal' | 'expand'>('modal');

  const load = useCallback(() => {
    setLoading(true);
    fetchGlobalSettings()
      .then((s) => {
        setSettings(s);
        setTheme(s.theme ?? 'system');
        setDefaultUser(s.defaultUser ?? '');
        setPreferredFramework(s.preferredFramework ?? '');
        setPort(s.port ?? 3067);
        setBoardClickBehavior(s.boardClickBehavior ?? 'modal');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateGlobalSettings({
        theme,
        defaultUser: defaultUser || undefined,
        preferredFramework: preferredFramework || undefined,
        port,
        boardClickBehavior,
      });
      setSettings(updated);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save global settings');
    } finally {
      setSaving(false);
    }
  };

  const markDirty = () => setDirty(true);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading global settings…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Global Preferences</h3>
        <p className="text-xs text-gray-500 mb-5">These settings apply across all workspaces and are stored in your system's app data directory.</p>

        {settings?.migratedFrom && (
          <div className="mb-4 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-500/20 p-3">
            <p className="text-xs text-blue-700 dark:text-blue-400">
              Migrated from: <code className="rounded bg-blue-100 dark:bg-blue-900/30 px-1">{settings.migratedFrom}</code>
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Theme</label>
            <select
              value={theme}
              onChange={(e) => { setTheme(e.target.value as 'light' | 'dark' | 'system'); markDirty(); }}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Default User</label>
            <input
              type="text"
              value={defaultUser}
              onChange={(e) => { setDefaultUser(e.target.value); markDirty(); }}
              placeholder="Your name"
              className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <p className="mt-1 text-[11px] text-gray-500">Used as the default assignee when creating tickets.</p>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Preferred Framework</label>
            <select
              value={preferredFramework}
              onChange={(e) => { setPreferredFramework(e.target.value); markDirty(); }}
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
              onChange={(e) => { setPort(parseInt(e.target.value, 10) || 3067); markDirty(); }}
              className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <p className="mt-1 text-[11px] text-gray-500">Takes effect on next restart.</p>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Card Click Behavior</label>
            <select
              value={boardClickBehavior}
              onChange={(e) => { setBoardClickBehavior(e.target.value as 'modal' | 'expand'); markDirty(); }}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            >
              <option value="modal">Open modal</option>
              <option value="expand">Expand inline</option>
            </select>
          </div>
        </div>

        {error && (
          <p className="mt-4 text-xs text-red-500">{error}</p>
        )}

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save Global Settings'}
          </button>
          {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
        </div>
      </div>
    </div>
  );
}
