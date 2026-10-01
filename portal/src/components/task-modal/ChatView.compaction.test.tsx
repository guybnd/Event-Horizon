// @vitest-environment jsdom
// FLUX-1746: a compaction boundary note (`kind: 'compaction'`) must render through its own
// CompactionChip, not fall through to the generic ContextUpdateChip — the two are visually
// distinct (⟲ orange vs ⟳ neutral) because "the session lost context here" is a materially
// different signal from a routine resume preamble.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatView } from './ChatView';
import { DockProvider } from '../DockProvider';
import type { TranscriptMessage } from '../../api';

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
// jsdom doesn't implement scrollTo — ChatView's auto-scroll-to-bottom effect calls it unconditionally.
window.HTMLElement.prototype.scrollTo = vi.fn();

afterEach(() => cleanup());

function renderChat(messages: TranscriptMessage[]) {
  return render(
    <DockProvider>
      <ChatView messages={messages} busy={false} error={null} onSend={vi.fn()} />
    </DockProvider>,
  );
}

describe('ChatView — compaction note row (FLUX-1746)', () => {
  it('renders a compaction note with its own chip, not the context-update fallthrough', () => {
    renderChat([
      { role: 'note', kind: 'compaction', text: '⟲ Context compacted (auto) — 140k tokens dropped in 12 s', ts: 'T1' },
      { role: 'note', kind: 'context-update', text: '```situational-update\nresumed\n```', ts: 'T2' },
    ]);

    expect(screen.getByText(/Context compacted \(auto\)/)).toBeTruthy();
    // The context-update chip is collapsed by default (click-to-expand) — its label is what's
    // visible, not its body text, so asserting the label is the right "this is the OTHER chip,
    // rendered distinctly" signal here.
    expect(screen.getByText('Context update')).toBeTruthy();
  });
});
