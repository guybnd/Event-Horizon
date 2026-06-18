import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Settings2 } from 'lucide-react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Picker for the "acting as" identity. It only ever SELECTS among the users
// configured for the workspace (Settings → Workspace → Users & Agents); it does
// not create them. Managing the roster is a deliberate workspace setting.
export function UserMenu() {
  const { setCurrentUser, setView, setSettingsTab } = useAppActions();
  const currentUser = useAppSelector(s => s.currentUser);
  const config = useAppSelector(s => s.config);
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const users = config?.users ?? [];

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isOpen]);

  const pickUser = (name: string) => {
    setCurrentUser(name);
    setIsOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        title={`Acting as ${currentUser}`}
        className={`group flex items-center gap-2 rounded-xl border py-1 pl-1 pr-2.5 transition-all cursor-pointer ${
          isOpen
            ? 'border-primary/50 bg-primary/10 shadow-sm'
            : 'border-primary/20 bg-primary/[0.06] hover:border-primary/40 hover:bg-primary/10 hover:shadow-sm'
        }`}
      >
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[11px] font-bold uppercase text-white shadow-sm ring-1 ring-white/25"
          style={{ background: 'linear-gradient(135deg, var(--eh-accent), var(--eh-accent-hover))' }}
        >
          {initialsFor(currentUser)}
        </span>
        <span className="flex flex-col items-start leading-none">
          <span className="text-[8px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--eh-text-muted)' }}>Acting as</span>
          <span className="mt-0.5 max-w-[120px] truncate text-xs font-bold text-gray-800 dark:text-gray-100">{currentUser}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-180 text-primary' : 'text-gray-400 group-hover:text-primary'}`} />
      </button>

      {isOpen && (
        <div className="eh-dropdown absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border shadow-xl">
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--eh-text-muted)' }}>
            Acting as
          </div>
          <div className="max-h-64 overflow-y-auto">
            {users.length === 0 ? (
              <div className="px-3 pb-2 text-xs" style={{ color: 'var(--eh-text-muted)' }}>
                No users configured for this workspace yet.
              </div>
            ) : (
              users.map((u) => {
                const active = u.name === currentUser;
                return (
                  <button
                    key={u.name}
                    onClick={() => pickUser(u.name)}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors ${active ? 'text-[var(--eh-accent)]' : 'hover:bg-[var(--eh-column-bg)]'}`}
                    style={active ? { background: 'var(--eh-accent-glow)' } : { color: 'var(--eh-text-secondary)' }}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-[10px] font-bold uppercase text-primary">
                      {initialsFor(u.name)}
                    </span>
                    <span className="flex-1 truncate text-left">{u.name}</span>
                    {active && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          <div className="border-t" style={{ borderColor: 'var(--eh-border)' }}>
            <button
              onClick={() => { setSettingsTab('workspace'); setView('settings'); setIsOpen(false); }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--eh-column-bg)]"
              style={{ color: 'var(--eh-text-secondary)' }}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-dashed" style={{ borderColor: 'var(--eh-border)' }}>
                <Settings2 className="h-3.5 w-3.5" style={{ color: 'var(--eh-text-muted)' }} />
              </span>
              Manage users
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
