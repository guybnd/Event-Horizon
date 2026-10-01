// @vitest-environment jsdom
// FLUX-1706: the task-chat CLI picker threads a per-conversation `framework` override into
// `useChatSession` — it must change ONLY how a fresh session is started, never retarget an
// existing resumable one, and switching must never touch the durable transcript (chat history is
// retained across a CLI switch). These tests drive `send()`/`stop()` directly against a mocked
// transport to lock in that contract.
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useChatSession, type UseChatSession } from './useChatSession';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { CliSessionSummary } from '../types';

const {
  fetchTaskCliSessionMock,
  fetchTaskTranscriptMock,
  startTaskCliSessionExMock,
  sendTaskCliInputMock,
  stopTaskCliSessionMock,
  clearTaskTranscriptMock,
} = vi.hoisted(() => ({
  fetchTaskCliSessionMock: vi.fn(),
  fetchTaskTranscriptMock: vi.fn(),
  startTaskCliSessionExMock: vi.fn(),
  sendTaskCliInputMock: vi.fn(),
  stopTaskCliSessionMock: vi.fn(),
  clearTaskTranscriptMock: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTaskCliSession: fetchTaskCliSessionMock,
    fetchTaskTranscript: fetchTaskTranscriptMock,
    startTaskCliSessionEx: startTaskCliSessionExMock,
    sendTaskCliInput: sendTaskCliInputMock,
    stopTaskCliSession: stopTaskCliSessionMock,
    clearTaskTranscript: clearTaskTranscriptMock,
  };
});

function session(overrides: Partial<CliSessionSummary> = {}): CliSessionSummary {
  return {
    id: 'sess-1',
    taskId: 'FLUX-1706',
    framework: 'gemini',
    status: 'completed',
    command: 'claude',
    args: [],
    startedAt: new Date(0).toISOString(),
    label: 'Claude Code',
    resumable: true,
    ...overrides,
  } as CliSessionSummary;
}

const noopActions = new Proxy({} as AppActions, {
  get: () => vi.fn(() => () => {}),
});

const capturedRef: { current: UseChatSession | null } = { current: null };
function Harness({ conversationId, framework }: { conversationId: string; framework?: string }) {
  const chat = useChatSession(conversationId, true, false, false, undefined, framework);
  useEffect(() => { capturedRef.current = chat; });
  return null;
}

function renderHarness(conversationId: string, framework?: string) {
  return render(
    <AppActionsContext.Provider value={noopActions}>
      <Harness conversationId={conversationId} framework={framework} />
    </AppActionsContext.Provider>,
  );
}

describe('useChatSession framework override (FLUX-1706)', () => {
  beforeEach(() => {
    fetchTaskTranscriptMock.mockResolvedValue([]);
    stopTaskCliSessionMock.mockResolvedValue(session());
    sendTaskCliInputMock.mockResolvedValue(undefined);
    startTaskCliSessionExMock.mockResolvedValue(session());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('resumes the existing session when no override is set', async () => {
    fetchTaskCliSessionMock.mockResolvedValue(session({ framework: 'gemini', resumable: true }));
    renderHarness('FLUX-1706-a');

    await act(async () => { await capturedRef.current!.send('hello'); });

    expect(sendTaskCliInputMock).toHaveBeenCalled();
    expect(startTaskCliSessionExMock).not.toHaveBeenCalled();
  });

  it('starts a FRESH session under the override instead of resuming a differently-framed session', async () => {
    fetchTaskCliSessionMock.mockResolvedValue(session({ framework: 'gemini', resumable: true }));
    renderHarness('FLUX-1706-b', 'codex');

    await act(async () => { await capturedRef.current!.send('hello'); });

    expect(startTaskCliSessionExMock).toHaveBeenCalledWith('FLUX-1706-b', expect.objectContaining({ framework: 'codex' }));
    expect(sendTaskCliInputMock).not.toHaveBeenCalled();
  });

  it('resumes normally when the override already matches the resumable session', async () => {
    fetchTaskCliSessionMock.mockResolvedValue(session({ framework: 'codex', resumable: true }));
    renderHarness('FLUX-1706-c', 'codex');

    await act(async () => { await capturedRef.current!.send('hello'); });

    expect(sendTaskCliInputMock).toHaveBeenCalled();
    expect(startTaskCliSessionExMock).not.toHaveBeenCalled();
  });

  it('never clears the durable transcript on stop — chat history survives a switch', async () => {
    fetchTaskCliSessionMock.mockResolvedValue(session({ framework: 'gemini', resumable: true }));
    renderHarness('FLUX-1706-d');

    await act(async () => { await capturedRef.current!.stop(); });

    expect(stopTaskCliSessionMock).toHaveBeenCalledWith('FLUX-1706-d');
    expect(clearTaskTranscriptMock).not.toHaveBeenCalled();
  });
});
