// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmProvider, useConfirm } from './useConfirm';

afterEach(cleanup);

function Harness() {
  const confirm = useConfirm();
  const [result, setResult] = useState('none');
  const ask = async () => {
    const ok = await confirm({ title: 'Delete this?', body: 'This cannot be undone.', tone: 'danger' });
    setResult(ok ? 'confirmed' : 'cancelled');
  };
  return (
    <div>
      <button onClick={ask}>Ask</button>
      <span>{result}</span>
    </div>
  );
}

function renderHarness() {
  return render(
    <ConfirmProvider>
      <Harness />
    </ConfirmProvider>,
  );
}

describe('useConfirm', () => {
  it('resolves true when the confirm button is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Ask'));
    expect(await screen.findByText('Delete this?')).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm'));
    await screen.findByText('confirmed');
  });

  it('resolves false when Cancel is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByText('Delete this?');
    fireEvent.click(screen.getByText('Cancel'));
    await screen.findByText('cancelled');
  });

  it('resolves false on Escape', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByText('Delete this?');
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByText('cancelled');
  });

  it('resolves false on backdrop click', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByText('Delete this?');
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.click(backdrop);
    await screen.findByText('cancelled');
  });

  it('throws when used outside a ConfirmProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/ConfirmProvider/);
    consoleError.mockRestore();
  });
});
