import type { CliFramework } from './types';
import type { GroupStatus, GroupMemberSummary } from './api';

/**
 * Resolves the effective agent framework to use, following the 'auto' -> 'claude' logic.
 */
export function resolveEffectiveAgent(target: string | undefined, defaultAgent: string | undefined): CliFramework {
  const framework = target || defaultAgent || 'auto';
  return (framework === 'auto' ? 'claude' : framework) as CliFramework;
}

export function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 1) return '…';
  const available = maxLen - 1;
  const startLen = Math.ceil(available / 2);
  const endLen = Math.floor(available / 2);
  if (endLen === 0) return str.slice(0, startLen) + '…';
  return str.slice(0, startLen) + '…' + str.slice(-endLen);
}

/** The unregistered targets of a configured group's Case-1 workspace registration. */
export interface GroupRegistrationGaps {
  /** The dedicated parent is configured but not a registered workspace. */
  parentMissing: boolean;
  /** Checked-out members that aren't registered (absent members can't be registered). */
  missingMembers: GroupMemberSummary[];
  /** True when there is at least one actionable gap to register. */
  hasGap: boolean;
}

/**
 * Compute which workspaces a configured group still needs registered so the
 * Case-1 member binding can resolve. Returns no gaps unless the group is
 * configured, registration state was computed (`registrationComplete` defined),
 * and it's incomplete. Only *present* members count — an absent member has
 * nothing to register until it's checked out.
 */
export function groupRegistrationGaps(status: GroupStatus | null): GroupRegistrationGaps {
  const none: GroupRegistrationGaps = { parentMissing: false, missingMembers: [], hasGap: false };
  if (!status || !status.configured || status.registrationComplete !== false) return none;
  const parentMissing = status.parentRegistered === false;
  const missingMembers = (status.members ?? []).filter((m) => m.pathExists && m.registered === false);
  return { parentMissing, missingMembers, hasGap: parentMissing || missingMembers.length > 0 };
}

/** The parent directory of a workspace path (handles both / and \ separators). */
export function parentDirOf(p: string): string | null {
  if (!p) return null;
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}

/**
 * Decide whether to nudge the user toward the group wizard. The nudge is
 * OPTIONAL: only when no group is configured, the active workspace's parent
 * folder holds at least two sibling git repos, and the user hasn't dismissed it.
 * Returns the count of sibling repos when a nudge is warranted, else null.
 */
export function multiRepoNudge(opts: {
  groupConfigured: boolean | undefined;
  siblingRepoCount: number;
  dismissed: boolean;
}): number | null {
  if (opts.dismissed) return null;
  if (opts.groupConfigured) return null;
  if (opts.siblingRepoCount < 2) return null;
  return opts.siblingRepoCount;
}
