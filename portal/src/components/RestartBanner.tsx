import { useState } from 'react';
import { useApp } from '../AppContext';
import { API_URL } from '../api';

export function RestartBanner() {
  const { restartPending } = useApp();
  const [restarting, setRestarting] = useState(false);

  if (!restartPending && !restarting) return null;

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await fetch(`${API_URL}/restart`, { method: 'POST' });
    } catch {
      // Engine will drop the connection on restart — expected
    }
  };

  return (
    <div className="w-full bg-amber-500/90 text-white px-4 py-2 flex items-center justify-between text-sm font-medium z-50">
      <span>
        {restarting
          ? 'Restarting...'
          : 'Engine files changed — restart pending. Active sessions will finish first.'}
      </span>
      {!restarting && (
        <button
          onClick={handleRestart}
          className="ml-4 px-3 py-1 rounded bg-white/20 hover:bg-white/30 text-white text-xs font-semibold transition-colors"
        >
          Restart Now
        </button>
      )}
    </div>
  );
}
