import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { fetchTaskCliSession, stopTaskCliSession } from '../api';
import { runAgentAction } from '../agentActions';
import type { CliFramework, CliSessionSummary } from '../types';
import { useAppSelector } from '../store/useAppSelector';
import { resolveEffectiveAgent } from '../utils';

interface UseCliSessionOptions {
  isModalOpen: boolean;
  taskId: string | undefined;
  liveOutputRef: React.RefObject<HTMLPreElement | null>;
  onSessionChange?: () => void;
}

/** FLUX-1506: how long a failed ghost session's inline error stays visible before dissolving. */
const GHOST_DISSOLVE_MS = 2200;

export function useCliSession({ isModalOpen, taskId, liveOutputRef, onSessionChange }: UseCliSessionOptions) {
  const config = useAppSelector(s => s.config);
  const currentUser = useAppSelector(s => s.currentUser);
  const [cliSession, setCliSession] = useState<CliSessionSummary | null>(null);
  const [cliSessionBusy, setCliSessionBusy] = useState(false);
  const [cliSessionError, setCliSessionError] = useState('');

  const [selectedCliFramework, setSelectedCliFramework] = useState<CliFramework>(() =>
    resolveEffectiveAgent(undefined, config?.defaultFramework)
  );
  const [skipPermissions, setSkipPermissions] = useState(true);

  // Keep selected framework in sync with config if it hasn't been manually changed in this session.
  // FLUX-906: source the engine-resolved `defaultFramework` (concrete) rather than `defaultAgent`
  // (which may be the `'auto'` sentinel) — the engine owns 'auto' resolution now.
  useEffect(() => {
    if (config?.defaultFramework) {
      setSelectedCliFramework(resolveEffectiveAgent(undefined, config.defaultFramework));
    }
  }, [config?.defaultFramework]);

  const cliSessionRef = useRef<CliSessionSummary | null>(null);
  
  useEffect(() => {
    cliSessionRef.current = cliSession;
  }, [cliSession]);

  const sessionIsActive = Boolean(cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status));

  useEffect(() => {
    if (!isModalOpen || !taskId) return;
    void fetchTaskCliSession(taskId)
      .then((session) => startTransition(() => setCliSession(session)))
      .catch(() => {});
  }, [isModalOpen, taskId]);

  useEffect(() => {
    if (!isModalOpen || !taskId || !sessionIsActive) return;

    const SESSION_STALE_MS = 10 * 60 * 1000;
    const timer = window.setInterval(() => {
      const s = cliSessionRef.current;
      const lastActivityAt = s?.lastOutputAt ?? s?.startedAt;
      if (lastActivityAt && Date.now() - new Date(lastActivityAt).getTime() > SESSION_STALE_MS) {
        window.clearInterval(timer);
        return;
      }
      void fetchTaskCliSession(taskId)
        .then((session) => startTransition(() => setCliSession(session)))
        .catch(() => {});
    }, 2500);

    return () => window.clearInterval(timer);
  }, [isModalOpen, taskId, sessionIsActive]);

  useEffect(() => {
    if (liveOutputRef.current) {
      liveOutputRef.current.scrollTop = liveOutputRef.current.scrollHeight;
    }
  }, [cliSession?.liveOutput, liveOutputRef]);

  const launchSession = useCallback(async (effortOverride?: string) => {
    if (!taskId) return;
    setCliSessionBusy(true);
    setCliSessionError('');
    // FLUX-1506: ghost session — render a "Starting…" pill in the panel the instant the button is
    // clicked (LaunchAgentSplitButton's own `busy` spinner covers the button; this covers the panel's
    // status pill / stop button so the whole panel reads as launching, not just the button). Real
    // data replaces it on success; on failure it flips to the 'failed' status the panel already knows
    // how to render, then dissolves back to empty a beat later.
    const ghostId = `ghost-${taskId}-${Date.now()}`;
    setCliSession({
      id: ghostId,
      taskId,
      framework: selectedCliFramework,
      status: 'pending',
      command: '',
      args: [],
      startedAt: new Date().toISOString(),
      label: 'Agent',
    });
    try {
      const session = await runAgentAction({
        taskId,
        framework: selectedCliFramework,
        action: { kind: 'launch' },
        currentUser,
        skipPermissions,
        effortOverride,
      });
      setCliSession(session);
      onSessionChange?.();
    } catch (error: unknown) {
      setCliSessionError(error instanceof Error ? error.message : 'Failed to start CLI session.');
      setCliSession((current) => current?.id === ghostId ? { ...current, status: 'failed' } : current);
      window.setTimeout(() => {
        setCliSession((current) => current?.id === ghostId ? null : current);
      }, GHOST_DISSOLVE_MS);
    } finally {
      setCliSessionBusy(false);
    }
  }, [taskId, selectedCliFramework, skipPermissions, currentUser, onSessionChange]);

  const stopSession = useCallback(async (sessionId?: string) => {
    if (!taskId) return;
    setCliSessionBusy(true);
    setCliSessionError('');
    try {
      const session = await stopTaskCliSession(taskId, sessionId ? { sessionId } : undefined);
      setCliSession(session);
      onSessionChange?.();
    } catch (error: unknown) {
      setCliSessionError(error instanceof Error ? error.message : 'Failed to stop CLI session.');
    } finally {
      setCliSessionBusy(false);
    }
  }, [taskId, onSessionChange]);

  const stopGroup = useCallback(async (groupId?: string) => {
    if (!taskId) return;
    setCliSessionBusy(true);
    setCliSessionError('');
    try {
      const session = await stopTaskCliSession(taskId, groupId ? { groupId } : { stopAll: true });
      setCliSession(session);
      onSessionChange?.();
    } catch (error: unknown) {
      setCliSessionError(error instanceof Error ? error.message : 'Failed to stop CLI sessions.');
    } finally {
      setCliSessionBusy(false);
    }
  }, [taskId, onSessionChange]);

  return {
    cliSession, setCliSession,
    cliSessionBusy, setCliSessionBusy,
    cliSessionError, setCliSessionError,
    selectedCliFramework, setSelectedCliFramework,
    skipPermissions, setSkipPermissions,
    sessionIsActive,
    launchSession,
    stopSession,
    stopGroup,
  };
}
