import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { fetchTaskCliSession, startTaskCliSession, stopTaskCliSession } from '../api';
import type { CliFramework, CliSessionSummary } from '../types';
import { useApp } from '../AppContext';
import { resolveEffectiveAgent } from '../utils';

interface UseCliSessionOptions {
  isModalOpen: boolean;
  taskId: string | undefined;
  liveOutputRef: React.RefObject<HTMLPreElement | null>;
  onSessionChange?: () => void;
}

export function useCliSession({ isModalOpen, taskId, liveOutputRef, onSessionChange }: UseCliSessionOptions) {
  const { config } = useApp();
  const [cliSession, setCliSession] = useState<CliSessionSummary | null>(null);
  const [cliSessionBusy, setCliSessionBusy] = useState(false);
  const [cliSessionError, setCliSessionError] = useState('');

  const [selectedCliFramework, setSelectedCliFramework] = useState<CliFramework>(() => 
    resolveEffectiveAgent(undefined, config?.defaultAgent)
  );
  const [skipPermissions, setSkipPermissions] = useState(true);

  // Keep selected framework in sync with config if it hasn't been manually changed in this session
  useEffect(() => {
    if (config?.defaultAgent) {
      setSelectedCliFramework(resolveEffectiveAgent(undefined, config.defaultAgent));
    }
  }, [config?.defaultAgent]);

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
    try {
      const session = await startTaskCliSession(taskId, selectedCliFramework, undefined, skipPermissions, effortOverride);
      setCliSession(session);
      onSessionChange?.();
    } catch (error: unknown) {
      setCliSessionError(error instanceof Error ? error.message : 'Failed to start CLI session.');
    } finally {
      setCliSessionBusy(false);
    }
  }, [taskId, selectedCliFramework, skipPermissions, onSessionChange]);

  const stopSession = useCallback(async () => {
    if (!taskId) return;
    setCliSessionBusy(true);
    setCliSessionError('');
    try {
      const session = await stopTaskCliSession(taskId);
      setCliSession(session);
      onSessionChange?.();
    } catch (error: unknown) {
      setCliSessionError(error instanceof Error ? error.message : 'Failed to stop CLI session.');
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
  };
}
