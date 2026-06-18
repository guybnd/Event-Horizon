import { useState, useEffect, useCallback } from 'react';
import {
  Loader2,
  CheckCircle,
  AlertTriangle,
  FolderGit2,
  FolderSearch,
  ListChecks,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import {
  discoverGroupRegistry,
  discoverGroupFolder,
  createGroupParent,
  pickWorkspaceFolder,
  type DiscoveredRepo,
  type MemberRegistration,
} from '../api';

interface GroupWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'source' | 'select' | 'configure' | 'result';
type Source = 'registry' | 'folder';

/** A discovered repo plus the user's selection + role assignment. */
interface RepoChoice extends DiscoveredRepo {
  selected: boolean;
  role: string;
}

const slugify = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Group onboarding/migration wizard (FLUX-407). Guides a user from "a folder of
 * repos" (or the repos EH already knows) to a Case-1 group: pick the members,
 * create a dedicated parent, and register everything.
 *
 * Group mode is OPTIONAL — this wizard only runs when explicitly opened and can
 * be cancelled at every step without side effects until the final create.
 */
export function GroupWizard({ onComplete, onCancel }: GroupWizardProps) {
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<Source>('registry');

  const [folderPath, setFolderPath] = useState('');
  const [choices, setChoices] = useState<RepoChoice[]>([]);
  const [groupName, setGroupName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [parentTouched, setParentTouched] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdParent, setCreatedParent] = useState<string | null>(null);
  const [memberResults, setMemberResults] = useState<MemberRegistration[]>([]);

  // Default the parent path next to the discovered repos once a group name is
  // set, until the user edits it explicitly.
  useEffect(() => {
    if (parentTouched || !groupName.trim()) return;
    const sel = choices.find((c) => c.selected);
    if (!sel) return;
    const parentDir = sel.path.replace(/[\\/][^\\/]+$/, '');
    const sep = sel.path.includes('\\') ? '\\' : '/';
    setParentPath(`${parentDir}${sep}${slugify(groupName)}`);
  }, [groupName, choices, parentTouched]);

  const toChoices = (repos: DiscoveredRepo[]): RepoChoice[] =>
    repos.map((r) => ({ ...r, selected: false, role: '' }));

  const loadRegistry = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const repos = await discoverGroupRegistry();
      setChoices(toChoices(repos));
      setStep('select');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read workspace registry');
    } finally {
      setBusy(false);
    }
  }, []);

  const loadFolder = useCallback(async () => {
    if (!folderPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await discoverGroupFolder(folderPath.trim());
      setChoices(toChoices(result.repos));
      setStep('select');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan folder');
    } finally {
      setBusy(false);
    }
  }, [folderPath]);

  async function browseFolder(setter: (v: string) => void, markTouched?: boolean) {
    const picked = await pickWorkspaceFolder();
    if (picked) {
      setter(picked);
      if (markTouched) setParentTouched(true);
    }
  }

  function toggleSelected(path: string) {
    setChoices((prev) => prev.map((c) => (c.path === path ? { ...c, selected: !c.selected } : c)));
  }
  function setRole(path: string, role: string) {
    setChoices((prev) => prev.map((c) => (c.path === path ? { ...c, role } : c)));
  }

  const selected = choices.filter((c) => c.selected);
  const selectedParents = selected.filter((c) => c.isGroupParent);
  const membersMissingRemote = selected.filter((c) => !c.remote);
  const membersMissingRole = selected.filter((c) => !c.role.trim());

  const selectValid =
    selected.length > 0 &&
    selectedParents.length === 0 && // a member can't already be a group parent
    membersMissingRemote.length === 0;

  const configureValid =
    selectValid &&
    groupName.trim().length > 0 &&
    parentPath.trim().length > 0 &&
    membersMissingRole.length === 0;

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const members = selected.map((c) => ({
        name: c.name,
        role: c.role.trim(),
        remote: c.remote as string,
        path: c.path,
      }));
      const created = await createGroupParent({
        parentPath: parentPath.trim(),
        name: groupName.trim(),
        members,
      });
      // create-parent registers the parent AND every member it has a local path
      // for, and pins those paths in group.local.json — so the group is fully
      // linked here, not just the parent. Surface the per-member outcome.
      setMemberResults(created.memberRegistrations ?? []);
      setCreatedParent(created.parentRoot);
      setStep('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setBusy(false);
    }
  }

  // ─── Result step ─────────────────────────────────────────────────────────
  if (step === 'result') {
    const registeredCount = memberResults.filter((m) => m.registered).length;
    const gaps = memberResults.filter((m) => !m.registered);
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
          <CheckCircle className="w-5 h-5" />
          <h4 className="text-base font-semibold">Group created</h4>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          The dedicated parent <span className="font-mono">{createdParent}</span> now hosts the group
          “{groupName.trim()}” with {selected.length} member{selected.length === 1 ? '' : 's'}. Each member’s
          shared knowledge base will surface under its <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">Product/</code> tree.
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Registered the parent and <span className="font-semibold">{registeredCount}</span> of{' '}
          {memberResults.length} member{memberResults.length === 1 ? '' : 's'} as Event Horizon workspaces —
          the group is linked, no extra consent step needed.
        </p>
        {gaps.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Some members weren’t registered automatically:</div>
              <ul className="mt-1 list-disc pl-4">
                {gaps.map((m) => (
                  <li key={m.name}>
                    <span className="font-medium">{m.name}</span> — {m.reason ?? 'unknown reason'}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div className="rounded-lg border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
          {selected.map((m) => {
            const result = memberResults.find((r) => r.name === m.name);
            return (
              <div key={m.path} className="flex items-center gap-2 px-3 py-2 text-sm">
                <FolderGit2 className="w-4 h-4 text-gray-400" />
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-gray-400">{m.role.trim()}</span>
                {result && (
                  <span
                    className={`text-[11px] ${result.registered ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}
                  >
                    {result.registered ? 'registered' : 'not registered'}
                  </span>
                )}
                <span className="ml-auto font-mono text-[11px] text-gray-400 truncate">{m.path}</span>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onComplete}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs font-medium text-gray-400">
        <span className={step === 'source' ? 'text-primary' : ''}>1. Source</span>
        <ArrowRight className="w-3 h-3" />
        <span className={step === 'select' ? 'text-primary' : ''}>2. Select repos</span>
        <ArrowRight className="w-3 h-3" />
        <span className={step === 'configure' ? 'text-primary' : ''}>3. Name & create</span>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-300/60 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-900/20 dark:text-red-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Step 1: source */}
      {step === 'source' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Build a product group from several repositories. Pick where to find them — this is entirely
            optional and changes nothing until you confirm at the end.
          </p>
          <button
            onClick={() => setSource('registry')}
            className={`w-full flex items-start gap-3 rounded-xl border p-4 text-left ${
              source === 'registry' ? 'border-primary/50 bg-primary/5' : 'border-gray-200 dark:border-white/10'
            }`}
          >
            <ListChecks className="w-5 h-5 mt-0.5 text-primary" />
            <div>
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">Repos Event Horizon already knows</div>
              <div className="text-xs text-gray-500">Start from your registered workspaces.</div>
            </div>
          </button>
          <button
            onClick={() => setSource('folder')}
            className={`w-full flex items-start gap-3 rounded-xl border p-4 text-left ${
              source === 'folder' ? 'border-primary/50 bg-primary/5' : 'border-gray-200 dark:border-white/10'
            }`}
          >
            <FolderSearch className="w-5 h-5 mt-0.5 text-primary" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">Scan a folder of repos</div>
              <div className="text-xs text-gray-500 mb-2">Point at a folder that contains your repositories.</div>
              {source === 'folder' && (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
                    placeholder="/path/to/repos"
                    className="min-w-0 flex-1 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1.5 text-xs font-mono outline-none focus:border-primary"
                  />
                  <button
                    onClick={() => browseFolder(setFolderPath)}
                    className="rounded border border-gray-200 dark:border-white/10 px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    Browse…
                  </button>
                </div>
              )}
            </div>
          </button>
          <div className="flex justify-between pt-1">
            <button onClick={onCancel} className="text-sm text-gray-500 hover:underline">Cancel</button>
            <button
              onClick={() => (source === 'registry' ? loadRegistry() : loadFolder())}
              disabled={busy || (source === 'folder' && !folderPath.trim())}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              Discover repos
            </button>
          </div>
        </div>
      )}

      {/* Step 2: select repos + roles */}
      {step === 'select' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Select the repos that form this product and give each a role. Unselected repos stay standalone.
          </p>
          {choices.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No git repositories found.</p>
          ) : (
            <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
              {choices.map((c) => (
                <div
                  key={c.path}
                  className={`rounded-lg border px-3 py-2.5 ${
                    c.selected ? 'border-primary/40 bg-primary/5' : 'border-gray-200 dark:border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={c.selected}
                      disabled={c.isGroupParent}
                      onChange={() => toggleSelected(c.path)}
                      className="shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{c.name}</span>
                        {c.registered && <span className="text-[10px] font-bold uppercase text-green-600">Registered</span>}
                        {c.isGroupParent && <span className="text-[10px] font-bold uppercase text-amber-600">Already a group parent</span>}
                        {!c.remote && !c.isGroupParent && <span className="text-[10px] font-bold uppercase text-red-500">No origin remote</span>}
                      </div>
                      <p className="text-[11px] font-mono text-gray-400 truncate">{c.remote ?? c.path}</p>
                    </div>
                    {c.selected && !c.isGroupParent && (
                      <input
                        value={c.role}
                        onChange={(e) => setRole(c.path, e.target.value)}
                        placeholder="role (e.g. api)"
                        className="w-32 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 text-xs outline-none focus:border-primary"
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {membersMissingRemote.length > 0 && (
            <p className="text-xs text-red-500">
              {membersMissingRemote.length} selected repo{membersMissingRemote.length === 1 ? ' has' : 's have'} no origin remote and can’t be a member.
            </p>
          )}
          <div className="flex justify-between pt-1">
            <button onClick={() => setStep('source')} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:underline">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <button
              onClick={() => setStep('configure')}
              disabled={!selectValid}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              Next <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: name group + parent path + create */}
      {step === 'configure' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Name the group and choose where to create its <span className="font-semibold">dedicated parent</span> repo —
            a brand-new repo (not one of your members) that holds the shared knowledge base.
          </p>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Group name</label>
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="My Product"
              className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Dedicated parent folder (created if missing)</label>
            <div className="flex items-center gap-2">
              <input
                value={parentPath}
                onChange={(e) => { setParentPath(e.target.value); setParentTouched(true); }}
                placeholder="/path/to/my-product-group"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-xs font-mono outline-none focus:border-primary"
              />
              <button
                onClick={() => browseFolder(setParentPath, true)}
                className="rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2 text-xs font-medium hover:bg-gray-50 dark:hover:bg-white/5"
              >
                Browse…
              </button>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              A new git repo is initialized here with <code className="font-mono">group.json</code> and the canonical store. It must not already be one of your member repos.
            </p>
          </div>
          <div className="rounded-lg bg-gray-50 dark:bg-white/5 p-3 text-xs text-gray-500">
            <div className="font-semibold text-gray-600 dark:text-gray-300 mb-1">{selected.length} member{selected.length === 1 ? '' : 's'}</div>
            <ul className="space-y-0.5">
              {selected.map((m) => (
                <li key={m.path} className="flex items-center gap-2">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{m.name}</span>
                  <span>{m.role.trim() || <span className="text-red-500">needs a role</span>}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-between pt-1">
            <button onClick={() => setStep('select')} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:underline">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <button
              onClick={handleCreate}
              disabled={!configureValid || busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderGit2 className="w-4 h-4" />}
              Create group
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
