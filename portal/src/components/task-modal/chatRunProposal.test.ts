import { describe, it, expect } from 'vitest';
import type { TranscriptMessage } from '../../api';
import { parseRunProposal, stripRunMarker } from './chatRunProposal';

const msg = (role: TranscriptMessage['role'], text: string): TranscriptMessage => ({ role, text, ts: '' });

describe('parseRunProposal', () => {
  it('returns a proposal when the latest assistant turn carries a valid marker', () => {
    const p = parseRunProposal([
      msg('user', "let's do a review"),
      msg('assistant', 'I can run a review with three specialists.\n<!-- eh-run intent="review" label="Run review (3 agents)" -->'),
    ]);
    expect(p).toEqual({ intent: 'review', label: 'Run review (3 agents)', confirm: expect.stringContaining('review') });
  });

  it('falls back to the default label when the marker omits one', () => {
    const p = parseRunProposal([msg('assistant', '<!-- eh-run intent="groom" -->')]);
    expect(p?.intent).toBe('groom');
    expect(p?.label).toBe('Run grooming');
  });

  it('ignores an unknown / missing intent (never invents a run)', () => {
    expect(parseRunProposal([msg('assistant', '<!-- eh-run intent="delete-everything" -->')])).toBeNull();
    expect(parseRunProposal([msg('assistant', '<!-- eh-run label="oops" -->')])).toBeNull();
  });

  it('is superseded once the user replies (declining / moving on does nothing)', () => {
    const p = parseRunProposal([
      msg('assistant', 'Proposal.\n<!-- eh-run intent="review" -->'),
      msg('user', 'actually, never mind'),
    ]);
    expect(p).toBeNull();
  });

  it('looks past trailing tool/note rows to the proposing assistant turn', () => {
    const p = parseRunProposal([
      msg('assistant', 'Here is the plan.\n<!-- eh-run intent="implement" -->'),
      msg('tool', 'add_note'),
      msg('note', 'context update'),
    ]);
    expect(p?.intent).toBe('implement');
  });

  it('returns null when the latest assistant turn has no marker (stale earlier markers never re-offer)', () => {
    const p = parseRunProposal([
      msg('assistant', 'Old proposal.\n<!-- eh-run intent="review" -->'),
      msg('user', 'go'),
      msg('assistant', 'Done — the run finished.'),
    ]);
    expect(p).toBeNull();
  });

  it('tolerates attribute order and extra whitespace', () => {
    const p = parseRunProposal([msg('assistant', '<!--   eh-run   label="Split it up"   intent="split"  -->')]);
    expect(p).toEqual({ intent: 'split', label: 'Split it up', confirm: expect.any(String) });
  });
});

describe('stripRunMarker', () => {
  it('removes the marker and tidies trailing whitespace for verbatim surfaces', () => {
    expect(stripRunMarker('Let me run a review.\n<!-- eh-run intent="review" -->')).toBe('Let me run a review.');
  });
  it('is a no-op when there is no marker', () => {
    expect(stripRunMarker('just a normal message')).toBe('just a normal message');
  });
});
