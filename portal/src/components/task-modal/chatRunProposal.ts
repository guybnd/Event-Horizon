// FLUX-805: parse a "suggest a supervisor run" proposal the chat agent emits when it recognizes an
// orchestratable intent ("let's do a review / groom / implement / split this up"). Instead of silently
// launching a fleet, the agent ends its turn with an invisible marker (an HTML comment — react-markdown
// runs without rehype-raw, so it never renders in the transcript) that the chat turns into a one-click
// confirm chip. Clicking it sends a confirmation message back to the agent, which then fires the existing
// delegation path (delegate_parallel). The click is the cost guard — nothing launches without it.
//
// Kept component-free (like chatQuickReplies.ts) so the chat-context component file stays Fast-Refresh-clean.

import type { TranscriptMessage } from '../../api';

export type RunIntent = 'review' | 'groom' | 'implement' | 'split';

interface IntentSpec {
  /** Fallback button label when the marker omits one. */
  defaultLabel: string;
  /** The message the confirm chip sends back to the agent — its cue to actually launch the fleet. */
  confirm: string;
}

/** The orchestratable intents a chat proposal can carry, with their default chip label + confirm cue.
 *  The portal owns only the button text and the confirmation message; the agent picks the concrete fleet
 *  (via list_available_agents) when it launches, so adding a specialist never means touching this map. */
const RUN_INTENTS: Record<RunIntent, IntentSpec> = {
  review: { defaultLabel: 'Run review', confirm: 'Yes — launch the review run you proposed now.' },
  groom: { defaultLabel: 'Run grooming', confirm: 'Yes — launch the grooming run you proposed now.' },
  implement: { defaultLabel: 'Run implementation', confirm: 'Yes — launch the implementation run you proposed now.' },
  split: { defaultLabel: 'Split into subtasks', confirm: 'Yes — split this into subtasks as you proposed now.' },
};

export interface RunProposal {
  intent: RunIntent;
  /** Text rendered on the confirm chip (e.g. "Run review (3 agents)"). */
  label: string;
  /** Message sent via the normal chat composer when the chip is clicked. */
  confirm: string;
}

// The marker the agent emits, e.g. `<!-- eh-run intent="review" label="Run review (3 agents)" -->`.
// Tolerant of surrounding whitespace; attribute order is irrelevant.
const MARKER_RE = /<!--\s*eh-run\b([^>]*?)-->/i;

function attr(body: string, name: 'intent' | 'label'): string | undefined {
  const m = body.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1]!.trim() : undefined;
}

/** Remove the run marker from a string for surfaces that show agent text verbatim (NOT through
 *  react-markdown, which already drops it) — e.g. the empty-chat "where this left off" context card.
 *  Keeps the marker from ever flashing as a raw `<!-- eh-run … -->` comment. No-op when absent. */
export function stripRunMarker(text: string): string {
  return text.replace(MARKER_RE, '').replace(/[ \t]+\n/g, '\n').trim();
}

function matchMarker(text: string): RunProposal | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const body = m[1] ?? '';
  const intent = (attr(body, 'intent') ?? '').toLowerCase() as RunIntent;
  const spec = RUN_INTENTS[intent];
  if (!spec) return null; // unknown / missing intent → ignore (conservative: never invent a run)
  const label = attr(body, 'label') || spec.defaultLabel;
  return { intent, label, confirm: spec.confirm };
}

/**
 * Find the live run proposal in a chat transcript, or null. A proposal is "live" only while it is the
 * agent's most recent word: we walk from the tail and
 *  - return null the moment we hit a `user` message (the user has replied/moved on → proposal superseded;
 *    this is also what makes it dismissible — typing anything clears the chip),
 *  - otherwise the first `assistant` turn from the tail decides (its marker, or null if it has none),
 *  - skipping `tool`/`note` rows so a trailing `add_comment`/context note after the proposal doesn't hide it.
 * Because we only ever look at the latest assistant turn, a stale marker from an earlier turn never
 * re-offers a run the user already actioned.
 */
export function parseRunProposal(messages: TranscriptMessage[]): RunProposal | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return null;
    if (m.role === 'assistant') return matchMarker(m.text ?? '');
    // tool / note rows: keep walking back toward the proposing assistant turn.
  }
  return null;
}
