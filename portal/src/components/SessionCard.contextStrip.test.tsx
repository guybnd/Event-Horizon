// @vitest-environment jsdom
// FLUX-1748: context is per-session and never summable across a group (`tokenData` is a sum of
// tokens across members) — a solo card gets exactly one ContextStrip beside its token badge; a
// group card gets one per member inside the breakdown and NONE beside the summed token badge.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionCard } from './SessionCard';
import type { CliSessionSummary } from '../types';
import type { SessionGroup } from '../orchestration';

function session(overrides: Partial<CliSessionSummary>): CliSessionSummary {
  return {
    id: 's1',
    taskId: 'FLUX-1',
    framework: 'codex',
    status: 'running',
    command: 'claude',
    args: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    label: 'agent',
    ...overrides,
  } as CliSessionSummary;
}

const noop = () => {};

describe('SessionCard context strips (FLUX-1748)', () => {
  it('renders exactly one ContextStrip for a solo session', () => {
    render(
      <SessionCard
        task={{ id: 'FLUX-1', title: 'Test' }}
        now={Date.now()}
        config={null}
        session={session({ lastTurnContextTokens: 100_000, contextWindow: 200_000 })}
        onOpen={noop}
        onStop={noop}
      />,
    );
    expect(screen.getAllByTestId('context-strip')).toHaveLength(1);
  });

  it('renders one ContextStrip per member (never one for the aggregate) on a pipeline (relay) group', () => {
    const group: SessionGroup = {
      groupId: 'g1',
      groupType: 'relay',
      sessions: [
        session({ id: 's1', label: 'a', lastTurnContextTokens: 50_000, contextWindow: 200_000 }),
        session({ id: 's2', label: 'b', status: 'completed', lastTurnContextTokens: 120_000, contextWindow: 200_000 }),
      ],
      isMulti: true,
    };
    render(
      <SessionCard
        task={{ id: 'FLUX-1', title: 'Test' }}
        now={Date.now()}
        config={null}
        group={group}
        onOpen={noop}
        onStop={noop}
      />,
    );
    expect(screen.getAllByTestId('context-strip')).toHaveLength(2);
  });

  it('renders one ContextStrip per member on a swarm (headless scatter-gather, the topology fallback) group', () => {
    const group: SessionGroup = {
      groupId: 'g2',
      groupType: 'scatter-gather',
      groupVariant: 'headless',
      sessions: [
        session({ id: 's1', label: 'a', lastTurnContextTokens: 50_000, contextWindow: 200_000 }),
        session({ id: 's2', label: 'b', lastTurnContextTokens: 60_000, contextWindow: 200_000 }),
        session({ id: 's3', label: 'c', lastTurnContextTokens: 70_000, contextWindow: 200_000 }),
      ],
      isMulti: true,
    };
    render(
      <SessionCard
        task={{ id: 'FLUX-1', title: 'Test' }}
        now={Date.now()}
        config={null}
        group={group}
        onOpen={noop}
        onStop={noop}
      />,
    );
    expect(screen.getAllByTestId('context-strip')).toHaveLength(3);
  });
});
