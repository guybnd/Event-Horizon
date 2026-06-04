import { describe, it, expect } from 'vitest';
import { truncateMiddle } from './utils';

describe('truncateMiddle', () => {
  it('returns the string unchanged when shorter than maxLen', () => {
    expect(truncateMiddle('short', 10)).toBe('short');
  });

  it('returns the string unchanged when exactly maxLen', () => {
    expect(truncateMiddle('abcdefg', 7)).toBe('abcdefg');
  });

  it('truncates in the middle with ellipsis when exceeding maxLen', () => {
    expect(truncateMiddle('abcdefghij', 7)).toBe('abc…hij');
  });

  it('handles even split correctly', () => {
    expect(truncateMiddle('abcdefgh', 5)).toBe('ab…gh');
  });

  it('handles maxLen of 1 (edge: only ellipsis fits)', () => {
    expect(truncateMiddle('abcdef', 1)).toBe('…');
  });

  it('returns empty string for empty input', () => {
    expect(truncateMiddle('', 5)).toBe('');
  });

  it('handles maxLen larger than string length', () => {
    expect(truncateMiddle('ab', 5)).toBe('ab');
  });

  it('handles single-character strings', () => {
    expect(truncateMiddle('a', 5)).toBe('a');
  });

  it('handles maxLen of 3 (minimum useful: 1 char + ellipsis + 1 char)', () => {
    expect(truncateMiddle('abcdefgh', 3)).toBe('a…h');
  });

  it('uses the unicode ellipsis character (…), not three dots', () => {
    const result = truncateMiddle('abcdefghij', 7);
    expect(result).toContain('…');
    expect(result).not.toContain('...');
  });

  it('result length never exceeds maxLen', () => {
    const inputs = ['abcdefghijklmnop', 'hello world this is long', '12345678901234567890'];
    for (const input of inputs) {
      for (let maxLen = 1; maxLen < input.length; maxLen++) {
        const result = truncateMiddle(input, maxLen);
        expect(result.length).toBeLessThanOrEqual(maxLen);
      }
    }
  });

  it('preserves start and end characters of the original string', () => {
    const result = truncateMiddle('abcdefghij', 7);
    expect(result.startsWith('abc')).toBe(true);
    expect(result.endsWith('hij')).toBe(true);
  });
});
