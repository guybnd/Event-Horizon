import { describe, it, expect } from 'vitest';
import { parseAcceptanceCriteriaProgress } from './acceptanceCriteria';

describe('parseAcceptanceCriteriaProgress', () => {
  it('returns null when there is no Acceptance criteria section', () => {
    const body = '## Problem\nSomething.\n\n## Implementation plan\n- [ ] step one\n';
    expect(parseAcceptanceCriteriaProgress(body)).toBeNull();
  });

  it('returns null for a section with zero checkbox items', () => {
    const body = '## Acceptance criteria\nNo checkboxes here, just prose.\n\n## Next section\n';
    expect(parseAcceptanceCriteriaProgress(body)).toBeNull();
  });

  it('returns null for empty/undefined body', () => {
    expect(parseAcceptanceCriteriaProgress('')).toBeNull();
    expect(parseAcceptanceCriteriaProgress(undefined)).toBeNull();
    expect(parseAcceptanceCriteriaProgress(null)).toBeNull();
  });

  it('counts checked and unchecked top-level items', () => {
    const body = [
      '## Acceptance criteria',
      '- [x] first thing done',
      '- [ ] second thing pending',
      '- [X] third thing done (capital X)',
      '',
      '## Next section',
      '- [ ] not counted, different section',
    ].join('\n');
    expect(parseAcceptanceCriteriaProgress(body)).toEqual({ done: 2, total: 3 });
  });

  it('stops at the next heading of the same or higher level', () => {
    const body = [
      '## Acceptance criteria',
      '- [x] a',
      '## Implementation plan',
      '- [ ] b',
    ].join('\n');
    expect(parseAcceptanceCriteriaProgress(body)).toEqual({ done: 1, total: 1 });
  });

  it('keeps counting through a deeper nested heading', () => {
    const body = [
      '## Acceptance criteria',
      '- [x] a',
      '### A sub-heading',
      '- [ ] b',
      '## Next section',
      '- [ ] not counted',
    ].join('\n');
    expect(parseAcceptanceCriteriaProgress(body)).toEqual({ done: 1, total: 2 });
  });

  it('ignores indented (nested) sub-bullets', () => {
    const body = [
      '## Acceptance criteria',
      '- [ ] top-level item',
      '  - [x] nested detail, not counted',
      '- [x] another top-level item',
    ].join('\n');
    expect(parseAcceptanceCriteriaProgress(body)).toEqual({ done: 1, total: 2 });
  });

  it('never matches a blockquoted heading (e.g. a subtask quoting its parent)', () => {
    const body = [
      '> ## Acceptance criteria',
      '> - [x] quoted, not the ticket\'s own section',
      '',
      '## Problem',
      'No real AC section here.',
    ].join('\n');
    expect(parseAcceptanceCriteriaProgress(body)).toBeNull();
  });

  it('only recognizes the first Acceptance criteria heading', () => {
    const body = [
      '## Acceptance criteria',
      '- [x] real one',
      '## Acceptance criteria',
      '- [ ] duplicate heading, never entered as its own section',
    ].join('\n');
    expect(parseAcceptanceCriteriaProgress(body)).toEqual({ done: 1, total: 1 });
  });
});
