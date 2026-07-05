import { describe, it, expect } from 'vitest';
import { appendEngineEvents } from './coalesceEngineEvents';
import type { EngineEvent } from '../store/appStore';

function ev(id: number): EngineEvent {
  return { id, type: 'test', data: null, timestamp: id };
}

describe('appendEngineEvents', () => {
  it('returns the same prev reference when there is nothing pending', () => {
    const prev = [ev(1)];
    expect(appendEngineEvents(prev, [], 10)).toBe(prev);
  });

  it('appends pending entries after existing ones, preserving order', () => {
    const prev = [ev(1), ev(2)];
    const pending = [ev(3), ev(4)];
    expect(appendEngineEvents(prev, pending, 10)).toEqual([ev(1), ev(2), ev(3), ev(4)]);
  });

  it('caps the result to the most recent `max` entries', () => {
    const prev = [ev(1), ev(2), ev(3)];
    const pending = [ev(4), ev(5)];
    expect(appendEngineEvents(prev, pending, 3)).toEqual([ev(3), ev(4), ev(5)]);
  });

  it('caps correctly even when pending alone exceeds max', () => {
    const prev: EngineEvent[] = [];
    const pending = [ev(1), ev(2), ev(3), ev(4)];
    expect(appendEngineEvents(prev, pending, 2)).toEqual([ev(3), ev(4)]);
  });
});
