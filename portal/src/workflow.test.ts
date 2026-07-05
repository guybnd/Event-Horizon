import { describe, it, expect } from 'vitest';
import { normalizeStatus, UNKNOWN_STATUS } from './workflow';

describe('normalizeStatus', () => {
  it('returns the status unchanged when it is a non-empty string', () => {
    expect(normalizeStatus('In Progress')).toBe('In Progress');
  });

  it('buckets undefined into UNKNOWN_STATUS', () => {
    expect(normalizeStatus(undefined)).toBe(UNKNOWN_STATUS);
  });

  it('buckets null into UNKNOWN_STATUS', () => {
    expect(normalizeStatus(null)).toBe(UNKNOWN_STATUS);
  });

  it('buckets an empty string into UNKNOWN_STATUS', () => {
    expect(normalizeStatus('')).toBe(UNKNOWN_STATUS);
  });

  it('buckets a whitespace-only string into UNKNOWN_STATUS', () => {
    expect(normalizeStatus('   ')).toBe(UNKNOWN_STATUS);
  });

  it('buckets a non-string value into UNKNOWN_STATUS', () => {
    expect(normalizeStatus(42)).toBe(UNKNOWN_STATUS);
  });
});
