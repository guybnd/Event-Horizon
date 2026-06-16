import { useState } from 'react';
import { Power } from 'lucide-react';
import { useApp } from '../AppContext';

// Stop the local Event Horizon engine. Lives in Settings (top-right, every panel)
// rather than the top bar so the destructive action is deliberate, not one stray click away.
export function StopServiceButton() {
  const { isConnected } = useApp();
  const [isStopping, setIsStopping] = useState(false);

  const handleStop = async () => {
    if (!window.confirm('Stop the Event Horizon service? The portal will disconnect.')) return;
    setIsStopping(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Expected — the server closes the connection as it exits.
    }
  };

  return (
    <button
      onClick={handleStop}
      disabled={isStopping || !isConnected}
      title={isConnected ? 'Stop the Event Horizon service' : 'Engine offline'}
      className="flex shrink-0 items-center gap-2 rounded-xl border border-gray-200 bg-white/60 px-3 py-2 text-xs font-semibold text-gray-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-gray-400 dark:hover:border-red-500/30 dark:hover:bg-red-500/10 dark:hover:text-red-400"
    >
      <Power className="h-3.5 w-3.5" />
      {isStopping ? 'Stopping…' : 'Stop engine'}
    </button>
  );
}
