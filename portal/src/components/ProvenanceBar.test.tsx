// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProvenanceBar } from './ProvenanceBar';

describe('ProvenanceBar (FLUX-1748)', () => {
  it('unknown renders no aria-valuenow and the dashed unknown class', () => {
    render(<ProvenanceBar provenance="unknown" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.className).toContain('eh-provenance-bar--unknown');
  });

  it('exact at 0% renders a solid empty track distinct from unknown', () => {
    render(<ProvenanceBar provenance="exact" percent={0} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.className).not.toContain('eh-provenance-bar--unknown');
    expect(bar.getAttribute('data-provenance')).toBe('exact');
  });

  it('floor with percentFloor renders "at least 41%"', () => {
    render(<ProvenanceBar provenance="floor" percentFloor={41} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuetext')).toBe('at least 41%');
    expect(bar.className).not.toContain('eh-provenance-bar--unknown');
  });

  it('floor with percentFloor absent renders like unknown: no aria-valuenow, dashed class', () => {
    render(<ProvenanceBar provenance="floor" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.hasAttribute('aria-valuetext')).toBe(false);
    expect(bar.className).toContain('eh-provenance-bar--unknown');
  });

  it('exact gauge at 195/200 (a percent-less request gauge, derived via barPercent) renders a non-zero fill', () => {
    render(<ProvenanceBar provenance="exact" percent={97.5} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('97.5');
    const fill = bar.querySelector('.eh-provenance-bar__fill') as HTMLElement;
    expect(fill.style.width).toBe('97.5%');
  });
});
