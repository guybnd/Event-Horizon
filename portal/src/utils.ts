import type { CliFramework, CliCapabilities, Config } from './types';
import type { GroupStatus, GroupMemberSummary } from './api';
import type { WorkspaceInfo } from './api';
import type { Doc } from './types';

/**
 * Resolve the effective agent framework for the UI. Pass `config.defaultFramework` (FLUX-906) as
 * the second arg — that is the ENGINE-resolved `'auto'` value (`resolveDefaultFramework()`), already
 * concrete, so the portal no longer decides what `'auto'` means. The `'auto' -> 'claude'` floor
 * below is reached ONLY before /api/config has loaded (when `defaultFramework` is still undefined):
 * a defensive pre-load default, NOT a framework gate. Once config is in hand the engine's choice wins.
 */
export function resolveEffectiveAgent(target: string | undefined, defaultAgent: string | undefined): CliFramework {
  const framework = target || defaultAgent || 'auto';
  return (framework === 'auto' ? 'claude' : framework) as CliFramework;
}

/**
 * FLUX-906 (audit E.6): does `framework` support `capability`, per the engine's capability table
 * served on /api/config? This is the generic replacement for `framework === 'claude'` feature gates
 * across the portal — the UI asks "can this agent do X?" instead of "is this Claude?". Returns false
 * when the table hasn't loaded yet or the framework/flag is unknown (fail closed — hide the feature).
 */
export function frameworkSupports(
  config: Config | null | undefined,
  framework: CliFramework,
  capability: Exclude<keyof CliCapabilities, 'effort'>,
): boolean {
  const cap = config?.cliCapabilities?.[framework];
  return !!cap && cap[capability] === true;
}

/** `effort` is the one `CliCapabilities` flag shaped as `{ supported, flag? }` rather than a plain
 *  boolean, so it can't go through `frameworkSupports()` — use this instead. */
export function frameworkEffort(
  config: Config | null | undefined,
  framework: CliFramework,
): CliCapabilities['effort'] {
  return config?.cliCapabilities?.[framework]?.effort ?? { supported: false };
}

/**
 * FLUX-907 (split semantics): the frameworks EH can actually LAUNCH a session against — the runtime
 * adapter registry, served on `/api/config` as `runtimeFrameworks`. This is NARROWER than the skill
 * installer's framework list (cursor/cline/windsurf/antigravity/generic get skill files but no runtime).
 * The fallback mirrors the shipped registry and is reached only before `/api/config` loads — the engine
 * (`getRuntimeFrameworks()`) is the source of truth.
 */
export const DEFAULT_RUNTIME_FRAMEWORKS = ['claude', 'copilot', 'gemini'];
export function runtimeFrameworks(config: Config | null | undefined): string[] {
  return config?.runtimeFrameworks ?? DEFAULT_RUNTIME_FRAMEWORKS;
}
/** True when EH can launch a session against `framework` (vs install-only — "Skills only" in the UI). */
export function isRuntimeFramework(config: Config | null | undefined, framework: string): boolean {
  return runtimeFrameworks(config).includes(framework);
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

/** How the selected doc may be edited in the docs editor (FLUX-419). */
export interface DocEditability {
  /** The editor should be writable (save/title/delete enabled). */
  editable: boolean;
  /** Edits are routed through the group parent and fanned out to members (bound member). */
  viaParent: boolean;
}

/**
 * Decide whether the docs editor is writable for a doc, and whether its writes
 * route through the group parent. A genuinely read-only doc (`readOnly`, no
 * resolvable writer) is never editable. A bound member's group doc is editable
 * but routed (`viaParent`): the engine accepts the write and pushes it through
 * the parent via `submitGroupEdit`. Editing also requires the user to hold the
 * docs-edit permission (`canEditDocs`).
 */
export function resolveDocEditability(doc: Doc | null, canEditDocs: boolean): DocEditability {
  if (!doc || !canEditDocs) return { editable: false, viaParent: false };
  const viaParent = doc.viaParent === true;
  // `viaParent` docs surface with `readOnly: false` from the engine, but guard
  // explicitly so the routed-write path is editable even if that ever changes.
  const editable = viaParent || doc.readOnly !== true;
  return { editable, viaParent };
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

/** A workspace entry paired with its original index in the registry list. */
export interface WorkspaceListItem {
  ws: WorkspaceInfo;
  /** Index into the original `fetchWorkspaces()` array — rename/remove operate by index. */
  index: number;
}

/** One multi-repo group section: the group's name and its workspaces (parent first). */
export interface WorkspaceGroupSection {
  groupName: string;
  /** Stable group identity (the parent repo path). */
  parentPath: string;
  items: WorkspaceListItem[];
}

/** Grouped view of the workspace list (FLUX-415). */
export interface GroupedWorkspaces {
  groups: WorkspaceGroupSection[];
  ungrouped: WorkspaceListItem[];
}

/**
 * Partition the workspace list into multi-repo group sections + ungrouped
 * entries for nested rendering (FLUX-415). Groups are keyed by the parent repo
 * path (stable even if two groups share a display name); within a group the
 * parent renders first, then members, each preserving original registry order.
 * Every item keeps its original index so index-based rename/remove still work.
 */
export function groupWorkspaces(workspaces: WorkspaceInfo[]): GroupedWorkspaces {
  const byGroup = new Map<string, WorkspaceListItem[]>();
  const order: string[] = [];
  const ungrouped: WorkspaceListItem[] = [];

  workspaces.forEach((ws, index) => {
    const group = ws.group;
    if (group) {
      const key = group.parentPath;
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
        order.push(key);
      }
      byGroup.get(key)!.push({ ws, index });
    } else {
      ungrouped.push({ ws, index });
    }
  });

  const groups: WorkspaceGroupSection[] = order.map((key) => {
    const items = byGroup.get(key)!.slice().sort((a, b) => {
      const ra = a.ws.group?.role === 'parent' ? 0 : 1;
      const rb = b.ws.group?.role === 'parent' ? 0 : 1;
      return ra - rb;
    });
    const groupName = items.find((i) => i.ws.group)?.ws.group?.groupName ?? 'Group';
    return { groupName, parentPath: key, items };
  });

  return { groups, ungrouped };
}
