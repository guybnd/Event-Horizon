import { describe, it, expect } from 'vitest';
import { finalMessageNeedsUser } from './final-message-heuristic.js';

describe('finalMessageNeedsUser (FLUX-570/777/945 session-end backstop)', () => {
  it('FLUX-941 regression: a trailing question surfaces even when the message also "looks done"', () => {
    // The exact failure shape: the agent summarized that it closed the ticket to Done (merged PR,
    // implementation link) AND then asked a real question at the very end. The FLUX-777 looksDone
    // guard previously suppressed this, silently dropping the question.
    const fm =
      'Closing to Done manually — finish_ticket was blocked by its empty-branch guard. ' +
      'The work has landed: PR #209 merged; implementation link already points at it. ' +
      'One real gap surfaced. Want me to file a small follow-up ticket for that, or leave it?';
    expect(finalMessageNeedsUser(fm, null)).toBe(true);
  });

  it('plain trailing question surfaces', () => {
    expect(finalMessageNeedsUser('Which option do you prefer?', null)).toBe(true);
    expect(finalMessageNeedsUser('Should I proceed with option B?', undefined)).toBe(true);
  });

  it('does NOT re-surface when already routed to the require-input swimlane', () => {
    expect(finalMessageNeedsUser('Want me to file a follow-up, or leave it?', 'require-input')).toBe(false);
  });

  it('does NOT flag a Ready hand-off whose explanation happens to contain "which" (FLUX-1739 benchmark finding)', () => {
    const fm = 'Ticket BENCH-46 is now **Ready**. \n\nRoot cause: the fallback recomputed the base with a live merge-base, which drifts to the branch tip once a PR merges. The held-out test now passes.';
    expect(finalMessageNeedsUser(fm, null)).toBe(false);
  });

  it('does NOT flag a recorded review verdict whose write-up happens to say "which" (FLUX-1798, EHGAUNTL-2)', () => {
    const fm = '**APPROVED** — EHGAUNTL-2 recorded as `reviewState: approved` at Ready.\n\nThe implementer deviated from the groomed plan (which wrongly claimed the button was already wired).';
    expect(finalMessageNeedsUser(fm, null)).toBe(false);
    expect(finalMessageNeedsUser('CHANGES NEEDED — 1 Major. Which file? see the note.', null)).toBe(false);
  });

  it('a verdict that ENDS with a real question still surfaces', () => {
    expect(finalMessageNeedsUser('**APPROVED**. Want me to file the Minor as a follow-up?', null)).toBe(true);
  });

  it('does NOT flag a pure completion summary (FLUX-777 false-positive guard preserved)', () => {
    const done =
      'Done — implemented, validated, and moved to Done. Implementation link: PR #209 (merged). ' +
      'No further action needed; proceed to the next ticket when ready.';
    expect(finalMessageNeedsUser(done, null)).toBe(false);
  });

  it('does NOT flag a message with no input-shaped phrasing', () => {
    expect(finalMessageNeedsUser('Shipped. All 664 tests pass.', null)).toBe(false);
    expect(finalMessageNeedsUser('', null)).toBe(false);
    expect(finalMessageNeedsUser(null, null)).toBe(false);
  });

  it('surfaces an input-shaped, not-done message even without a trailing question', () => {
    // "let me know" / "confirm" mid-message, work not finished → still needs the user.
    expect(finalMessageNeedsUser('Blocked on a decision — let me know which path to take and I will continue.', null)).toBe(true);
  });

  it('a question mid-summary (not trailing) still respects the looksDone guard', () => {
    // No trailing question; the "?" is mid-text inside a completion summary → stays suppressed.
    const fm = 'Resolved the merge conflict (the index.css selectors?) and moved the ticket to Done. Implementation link set.';
    expect(finalMessageNeedsUser(fm, null)).toBe(false);
  });

  it('tolerates trailing markdown/whitespace after the question mark', () => {
    expect(finalMessageNeedsUser('All merged. Want me to also file the follow-up?**\n', null)).toBe(true);
    expect(finalMessageNeedsUser('Done and shipped. Anything else you want changed?  ', null)).toBe(true);
  });
});
