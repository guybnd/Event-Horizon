import { log } from './log.js';
import fs from 'fs/promises';
import { renameSync } from 'fs';
import { getConfigFile } from './workspace.js';

/**
 * Minimal shape of the raw config.json payload this loader touches directly before merging
 * it into `configCache` (which intentionally stays `any` — see the export below — out of
 * scope for this typing pass). Only the migrated array fields are narrowed; every other key
 * round-trips untyped through the index signature.
 */
interface LoadedConfig {
  columns?: unknown[];
  hiddenStatuses?: unknown[];
  users?: unknown[];
  tags?: unknown[];
  priorities?: unknown[];
  [key: string]: unknown;
}

/** Extract a human-readable message from a caught value of unknown shape. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow a caught value to a Node-style errno exception (has a `.code`). */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Minimal shape of a config tag entry (see the `tags` default above). */
interface ConfigTagEntry {
  name?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above: narrowing cascades widely (FLUX-1073)
export let configCache: any = {
  columns: [
    { name: 'Grooming', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
    { name: 'Todo', color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
    { name: 'In Progress', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
    { name: 'Ready', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
    { name: 'Done', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
    { name: 'Archived', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  ],
  hiddenStatuses: [
    { name: 'Backlog', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    { name: 'Released', color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' }
  ],
  projects: ['FLUX'],
  users: [],
  tags: [
    { name: 'bug', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
    { name: 'feature', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    { name: 'docs', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
  ],
  priorities: [
    { name: 'Critical', icon: 'AlertCircle', color: 'text-red-500' },
    { name: 'High', icon: 'ChevronUp', color: 'text-orange-500' },
    { name: 'Medium', icon: 'Equal', color: 'text-amber-500' },
    { name: 'Low', icon: 'ChevronDown', color: 'text-emerald-500' },
    { name: 'None', icon: 'Equal', color: 'text-gray-400' }
  ],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: true,
  boardCardOpenMode: 'chat',
  animationsEnabled: true,
  enableFireworks: true,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  archiveStatus: 'Archived',
  swimlanes: [
    { id: 'require-input', label: 'Require Input', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300', commentRequired: true },
    { id: 'open-pr', label: 'Open PRs', color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300', commentRequired: false },
    { id: 'changes-requested', label: 'Changes Requested', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300', commentRequired: false },
    // FLUX-986: set by the engine (not the agent) when a PR merge fails on a real git conflict —
    // never on auth/network failures (see isMergeConflict, branch-manager.ts). Drives the "Launch
    // Rebase Session" CTA in the portal; commentRequired is false because there's nothing for the
    // agent to say, only a state to flag.
    { id: 'merge-conflict', label: 'Merge Conflict', color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300', commentRequired: false },
  ],
  // Portal-side UX gate only (DocsScreen `canEditDocs`); NOT enforced
  // server-side by routes/docs.ts — see the trust-model note there (FLUX-418).
  docsEditPermissions: 'all',
  docsAllowedUsers: [],
  releaseSettings: {
    generateDistinctFiles: true,
    releaseNotesPath: 'release-notes'
  },
  defaultAgent: 'claude',
  // FLUX-521: default state of the per-launch "dedicated worktree" choice. Off by
  // default; a per-launch param (create_branch / POST /:id/branch `worktree`)
  // overrides it. When on, creating a ticket branch also spins up a git worktree
  // so the agent runs isolated (FLUX-516).
  worktreeByDefault: false,
  defaultWorkflowId: '',
  phaseDefaults: {
    grooming: { single: 'builtin-grooming-single', multi: 'builtin-grooming-multi' },
    implementation: { single: 'builtin-implementation-single', multi: 'builtin-implementation-multi' },
    review: { single: 'builtin-review-single', multi: 'builtin-review-multi' },
    finalize: { single: 'builtin-finalize-single', multi: 'builtin-finalize-multi' },
  },
  integrations: {
    claudeCode: {
      groomingModel: '',
      implementationModel: '',
      // FLUX-482: default model for DELEGATED subagents (delegate_to_agent / delegate_parallel)
      // when neither a per-call `model` param nor the persona's own `model` is set. Empty/undefined
      // = no override → fall back to the status-derived grooming/implementation model. Set a cheap
      // tier (e.g. 'sonnet') to make all un-overridden delegates cheap by default.
      delegateModel: '',
    },
    geminiCli: {
      groomingModel: '',
      implementationModel: '',
    },
    copilotCli: {
      groomingModel: '',
      implementationModel: '',
    }
  },
  syncSettings: {
    debounceMs: 30000,
    maxWaitMs: 300000,
  },
  // FLUX-1063: global defaults for the Furnace rate-limit cooldown. A burn session that dies from a
  // transient usage/rate limit (5-hour session limit / 429 / quota) is not parked — the ticket cools
  // down and auto-retries every `rateLimitRetryIntervalMs` up to `rateLimitMaxWaitMs`, then fails
  // outright. New batches inherit these as their per-batch defaults (overridable via furnace_update).
  furnaceSettings: {
    rateLimitRetryIntervalMs: 20 * 60 * 1000, // 20 min
    rateLimitMaxWaitMs: 5 * 60 * 60 * 1000,   // 5 h
    // FLUX-1175: the Smelter persona's authority mode — 'drafting' (default, manual: every
    // real burn-lifecycle action needs ask_user_question confirmation) vs 'operator' (autonomous:
    // full ignite/stop/resume/retry authority once asked to manage a burn). See
    // SMELTER_MODE_CONTRACTS in orchestration-personas.ts for the composed prompt text.
    smelterMode: 'drafting',
  },
  agentProgress: {
    enabled: true,
    inlineDelay: 2,
  },
  // FLUX-605: per-surface default permission mode (the user's "risk tolerance"). The
  // per-chat Perms picker inherits these when set to "Default"; an explicit per-chat
  // choice overrides. 'gated' = destructive ops route through human approval
  // (--permission-prompt-tool); 'skip' = --dangerously-skip-permissions. Orchestrator
  // defaults to gated (it has triage teeth + a human present); per-ticket sessions skip.
  permissions: {
    boardDefault: 'gated',
    ticketDefault: 'skip',
  },
  modules: [],
  terminalCommands: [
    { id: 'restart-dev', label: 'Restart dev server', command: 'npm run dev', runMode: 'current' },
    { id: 'run-tests', label: 'Run tests', command: 'npm test', runMode: 'new' },
    { id: 'git-status', label: 'Git status', command: 'git status', runMode: 'current' },
  ] as Array<{ id: string; label: string; command: string; runMode: 'current' | 'new' }>,
};

export async function loadConfig() {
  try {
    const data = await fs.readFile(getConfigFile(), 'utf-8');

    // A 0-byte / whitespace-only file is a truncated or interrupted write, not a
    // valid empty config. Treat it like corruption: preserve it, run on defaults,
    // and crucially do NOT let the migration block below overwrite it (FLUX-781).
    if (!data.trim()) {
      console.error(`\n[FLUX CONFIG ERROR] ${getConfigFile()}\n  config.json is empty (0 bytes) — likely a truncated/interrupted write.\n  The engine is running on in-memory DEFAULTS and will NOT overwrite your file. Restore it from git/backup and restart.\n`);
      return;
    }

    let loaded: LoadedConfig;
    try {
      loaded = JSON.parse(data);
    } catch (parseErr: unknown) {
      // Most plausible corruption is a synced-in unresolved git conflict marker
      // (FLUX-703) or a partial write. Surface it explicitly and — critically —
      // return WITHOUT saving, so the migration block can't clobber a recoverable
      // file with engine defaults (which would lose every column/project/tag/user).
      const hasConflictMarkers = /^<{7} /m.test(data) && /^>{7} /m.test(data);
      const detail = hasConflictMarkers
        ? 'contains unresolved git conflict markers (<<<<<<< / ======= / >>>>>>>) — a sync merge committed an unresolved conflict. Resolve the markers and save again.'
        : `is not valid JSON: ${errMessage(parseErr)}`;
      console.error(`\n[FLUX CONFIG ERROR] ${getConfigFile()}\n  config.json ${detail}\n  The engine is running on in-memory DEFAULTS and will NOT overwrite your file. Fix it and restart.\n`);
      return;
    }

    if (loaded.columns?.length && typeof loaded.columns[0] === 'string') loaded.columns = loaded.columns.map((s) => ({ name: s as string }));
    if (loaded.hiddenStatuses?.length && typeof loaded.hiddenStatuses[0] === 'string') loaded.hiddenStatuses = loaded.hiddenStatuses.map((s) => ({ name: s as string }));
    if (loaded.users?.length && typeof loaded.users[0] === 'string') loaded.users = loaded.users.map((s) => ({ name: s as string }));
    if (loaded.tags?.length && typeof loaded.tags[0] === 'string') {
      loaded.tags = loaded.tags.map((s) => ({
        name: s as string,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      }));
    }
    if (!loaded.priorities || !Array.isArray(loaded.priorities) || loaded.priorities.length === 0) {
      loaded.priorities = configCache.priorities;
    }
    if (loaded.priorities?.length && typeof loaded.priorities[0] === 'string') {
      loaded.priorities = loaded.priorities.map((name) => ({
        name: name as string,
        icon: 'Equal',
        color: 'text-gray-400'
      }));
    }

    configCache = { ...configCache, ...loaded };
    log.info('Loaded config');
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      // No file yet (fresh install) — write the defaults out. This is the ONLY
      // path that legitimately creates config.json from defaults.
      await saveConfig(configCache);
    } else {
      // Read failed for another reason (permissions, I/O). Preserve whatever is on
      // disk and run on defaults; do NOT save over a file we couldn't read (FLUX-781).
      console.error('[FLUX CONFIG ERROR] Failed to read config.json; running on in-memory defaults WITHOUT overwriting it:', errMessage(error));
      return;
    }
  }

  // FLUX-744: one-time migration of the board-open default. The default changed from 'full' to 'chat',
  // but existing boards eagerly persisted the OLD 'full' default (saveConfig writes the whole config),
  // so without this an updating user would keep opening cards in the modal. Flip a persisted 'full'
  // (or an absent value) to 'chat' exactly ONCE, recorded via `chatOpenDefaultMigrated` so a later
  // DELIBERATE 'full'/'popup' choice is preserved and never re-flipped. The PUT /api/config handler
  // merges over configCache, so this marker survives portal Settings saves (which don't echo it back).
  // FLUX-781: only reached after a successful load or a legitimate ENOENT create — every parse/read
  // failure above returns early, so this can never overwrite a corrupt-but-recoverable config.json.
  if (!configCache.chatOpenDefaultMigrated) {
    if (!configCache.boardCardOpenMode || configCache.boardCardOpenMode === 'full') {
      configCache.boardCardOpenMode = 'chat';
    }
    configCache.chatOpenDefaultMigrated = true;
    await saveConfig(configCache);
    log.info('[config] applied chat-open-default migration (boardCardOpenMode →', configCache.boardCardOpenMode + ')');
  }
}

/**
 * Persist config.json atomically (temp-file + rename), mirroring task-store.ts's
 * atomicWriteFile (FLUX-290) — config.json is the single highest-value file and was
 * the only one left on the unsafe plain-write path (FLUX-781). A crash or concurrent
 * read mid-write can no longer leave a truncated file that later fails to parse.
 * Inlined rather than importing atomicWriteFile to avoid a config<->task-store cycle.
 */
export async function saveConfig(newConfig: Record<string, unknown>) {
  configCache = newConfig;
  const target = getConfigFile();
  const content = JSON.stringify(configCache, null, 2);
  const tmpPath = target + '.tmp';
  await fs.writeFile(tmpPath, content, 'utf-8');
  try {
    renameSync(tmpPath, target);
  } catch {
    // rename can fail on some FS setups (cross-device, transient locks) — fall back.
    await fs.writeFile(target, content, 'utf-8');
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export async function autoRegisterUnknownTags(tags: string[]) {
  if (!tags || !Array.isArray(tags) || tags.length === 0) return;

  if (!configCache.tags) {
    configCache.tags = [];
  }

  const existingTagsLower = new Set(configCache.tags.map((t: ConfigTagEntry) => (t.name as string | undefined)?.toLowerCase() || ''));
  let configChanged = false;

  for (const tag of tags) {
    if (tag && typeof tag === 'string' && !existingTagsLower.has(tag.toLowerCase())) {
      configCache.tags.push({
        name: tag,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      });
      existingTagsLower.add(tag.toLowerCase());
      configChanged = true;
    }
  }

  if (configChanged) {
    await saveConfig(configCache);
  }
}
