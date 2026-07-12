// Deterministic pre-gate plan lint (FLUX-1379) — a pure, dependency-free module (mirrors
// `gate-policy.ts`'s style) that catches mechanical plan defects a script can verify for free,
// before the plan-review gate ever spawns an LLM session. Two buckets:
//   bounces — refuse the Grooming -> Todo move outright, complete list in ONE reply, zero tokens.
//   warns   — never block; injected into the LLM review's focus so the smart pass still sees them
//             (today's `ARTIFACT_CHECK` is explicitly advisory, so a dumb linter must not be
//             stricter than the human-in-the-loop judgment it stands in for).
//
// Rule table (see the ticket body for the full decision writeup):
//   B1 — missing a leading `> **TL;DR**` blockquote once the body is substantial (~400+ chars).
//   B2 — M+ effort with no `## Acceptance criteria` heading containing at least one GFM checkbox.
//   B3 — M+ effort with an essentially empty body (~under 300 chars) — nothing to review yet.
//   B4 — L/XL effort with no `## Recommended Tests` / `## Test plan` heading.
//   B5 — effort not set at all — `depthForEffort`/`planGateSkipSmall` both key off it, so this
//        linter can't judge B2-B4's applicability without it.
//   W1 — M+ effort with no published artifact revision — flag, not a blocker (mirrors gate-runner's
//        `ARTIFACT_CHECK`, itself advisory: "UI-shaped" is a judgment call a linter can't make).

const TLDR_BODY_LENGTH_THRESHOLD = 400;
const EMPTY_BODY_LENGTH_THRESHOLD = 300;
const TLDR_LOOKAHEAD_CHARS = 600;

export type PlanLintCode = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'W1';

export interface LintFinding {
  code: PlanLintCode;
  message: string;
}

export interface PlanLintInput {
  body: string;
  effort: string | null | undefined;
  hasArtifact: boolean;
}

export interface PlanLintResult {
  bounces: LintFinding[];
  warns: LintFinding[];
}

function isEffortUnset(effort: string | null | undefined): boolean {
  return effort == null || effort.trim().length === 0;
}

function isSmallEffort(effort: string | null | undefined): boolean {
  return effort === 'XS' || effort === 'S';
}

function isLargeEffort(effort: string | null | undefined): boolean {
  return effort === 'L' || effort === 'XL';
}

/** M+ for lint purposes: any SET effort that isn't XS/S — mirrors `depthForEffort`'s
 *  standard/thorough bucket (which also treats 'None' and unrecognized values as "not small"). */
function isMPlusEffort(effort: string | null | undefined): boolean {
  return !isEffortUnset(effort) && !isSmallEffort(effort);
}

/** Lenient, case-insensitive: any line starting with `>` that mentions "TL;DR" within the first
 *  `TLDR_LOOKAHEAD_CHARS` of the body — tolerates bold markers, extra whitespace, and doesn't
 *  require the blockquote to be the literal first character (a heading above it is fine). */
function hasLeadingTldr(body: string): boolean {
  return /^\s*>.*tl;dr/im.test(body.slice(0, TLDR_LOOKAHEAD_CHARS));
}

function acceptanceCriteriaSection(body: string): string | null {
  const heading = /^#{2,3}[ \t]*acceptance criteria[ \t]*$/im.exec(body);
  if (!heading) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const nextHeading = /^#{1,3}[ \t]+\S/m.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function hasAcceptanceCriteriaChecklist(body: string): boolean {
  const section = acceptanceCriteriaSection(body);
  return section != null && /^[ \t]*[-*][ \t]*\[[ xX]\]/m.test(section);
}

function hasTestsHeading(body: string): boolean {
  return /^#{2,3}[ \t]*(recommended tests|test plan)[ \t]*$/im.test(body);
}

export function planLint(input: PlanLintInput): PlanLintResult {
  const { body, effort, hasArtifact } = input;
  const trimmedLength = body.trim().length;
  const bounces: LintFinding[] = [];
  const warns: LintFinding[] = [];

  if (trimmedLength > TLDR_BODY_LENGTH_THRESHOLD && !hasLeadingTldr(body)) {
    bounces.push({
      code: 'B1',
      message: 'Missing a leading `> **TL;DR**` blockquote — required once the plan body is substantial (FLUX-953).',
    });
  }

  if (isEffortUnset(effort)) {
    bounces.push({
      code: 'B5',
      message: 'Effort is not set — the review depth and the XS/S auto-skip both key off it. Set an effort estimate and retry.',
    });
  } else {
    if (isMPlusEffort(effort)) {
      if (trimmedLength < EMPTY_BODY_LENGTH_THRESHOLD) {
        bounces.push({
          code: 'B3',
          message: `Body is essentially empty (${trimmedLength} chars) for a ${effort} ticket — there is nothing substantive to review yet.`,
        });
      }
      if (!hasAcceptanceCriteriaChecklist(body)) {
        bounces.push({
          code: 'B2',
          message: 'Missing a `## Acceptance criteria` heading with at least one GFM checkbox — required for M+ effort (FLUX-1148).',
        });
      }
      if (!hasArtifact) {
        warns.push({
          code: 'W1',
          message: 'No published artifact revision on an M+ plan. Flag only — whether this plan is UI/UX-shaped enough to need one is a judgment call this linter cannot make.',
        });
      }
    }
    if (isLargeEffort(effort) && !hasTestsHeading(body)) {
      bounces.push({
        code: 'B4',
        message: 'Missing a `## Recommended Tests` / `## Test plan` heading — required for L/XL effort (FLUX-1273).',
      });
    }
  }

  return { bounces, warns };
}

export function formatLintFindings(findings: LintFinding[]): string {
  return findings.map((f) => `- **${f.code}**: ${f.message}`).join('\n');
}
