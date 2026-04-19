import { useState } from 'react';
import {
  Loader2,
  CheckCircle,
  AlertTriangle,
  FileText,
  GitBranch,
  FolderGit2,
  Plus,
  Trash2,
  Download,
  XCircle,
} from 'lucide-react';
import {
  planGroupSetup,
  applyGroupSetup,
  type GroupSetupPlan,
  type GroupSetupResult,
  type GroupMemberInput,
} from '../api';

interface GroupSetupPreviewProps {
  onComplete: () => void;
  onCancel: () => void;
  /** Existing group config to prefill when reconfiguring an already-configured parent (FLUX-413). */
  initial?: { name: string; members: MemberDraft[] };
}

interface MemberDraft {
  name: string;
  role: string;
  remote: string;
}

type Step = 'input' | 'plan' | 'result';

const emptyMember = (): MemberDraft => ({ name: '', role: '', remote: '' });

export function GroupSetupPreview({ onComplete, onCancel, initial }: GroupSetupPreviewProps) {
  const isReconfigure = initial != null;
  const [step, setStep] = useState<Step>('input');
  const [groupName, setGroupName] = useState(initial?.name ?? '');
  const [members, setMembers] = useState<MemberDraft[]>(
    initial && initial.members.length > 0 ? initial.members.map((m) => ({ ...m })) : [emptyMember()],
  );
  // Reconfiguring overwrites the existing group.json, which apply refuses without force.
  const [force, setForce] = useState(isReconfigure);
  const [allowLocal, setAllowLocal] = useState(false);

  const [plan, setPlan] = useState<GroupSetupPlan | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<GroupSetupResult | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateMember(i: number, patch: Partial<MemberDraft>) {
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function addMember() {
    setMembers((prev) => [...prev, emptyMember()]);
  }
  function removeMember(i: number) {
    setMembers((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }
  function toggleSkip(name: string) {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const cleanMembers = (): GroupMemberInput[] =>
    members
      .map((m) => ({ name: m.name.trim(), role: m.role.trim(), remote: m.remote.trim() }))
      .filter((m) => m.name || m.role || m.remote);

  const inputValid =
    groupName.trim().length > 0 &&
    cleanMembers().length > 0 &&
    cleanMembers().every((m) => m.name && m.role && m.remote);

  async function handlePreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await planGroupSetup({
        name: groupName.trim(),
        members: cleanMembers(),
        force,
        allowLocalRemotes: allowLocal,
      });
      setPlan(result);
      setSkipped(new Set());
      setStep('plan');
    } catch (err: any) {
      setError(err.message || 'Failed to compute plan');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const kept = cleanMembers().filter((m) => !skipped.has(m.name));
      const res = await applyGroupSetup({
        name: groupName.trim(),
        members: kept,
        force,
        allowLocalRemotes: allowLocal,
      });
      setResult(res);
      setStep('result');
    } catch (err: any) {
      setError(err.message || 'Failed to apply group setup');
    } finally {
      setBusy(false);
    }
  }

  // ─── Result step ───────────────────────────────────────────────────────────
  if (step === 'result' && result) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          <CheckCircle className="h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">Group “{result.groupName}” configured</p>
            <p className="mt-1 text-xs opacity-80">
              group.json {result.wroteConfig ? 'written' : 'unchanged'} · .gitignore{' '}
              {result.patchedGitignore ? 'patched' : 'unchanged'} · store{' '}
              {result.scaffoldedStore ? 'scaffolded' : 'unchanged'}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 divide-y divide-gray-100 dark:divide-white/5">
          {result.members.map((m) => (
            <div key={m.name} className="flex items-center gap-3 px-3 py-2">
              {m.ok ? (
                <CheckCircle className="h-4 w-4 shrink-0 text-emerald-500" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-amber-500" />
              )}
              <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate">{m.name}</span>
              <span className="text-xs text-gray-400">{m.action}</span>
              {m.error && <span className="text-xs text-amber-600 dark:text-amber-400 truncate max-w-[40%]">{m.error}</span>}
            </div>
          ))}
        </div>

        <button
          onClick={onComplete}
          className="flex h-11 items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
        >
          Done →
        </button>
      </div>
    );
  }

  // ─── Plan step ─────────────────────────────────────────────────────────────
  if (step === 'plan' && plan) {
    const hasOutbound = plan.members.some((m) => m.action === 'clone' && !skipped.has(m.name));
    return (
      <div className="flex flex-col gap-4">
        {plan.warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Files + branch */}
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <FileText className="h-4 w-4" />
            Files &amp; branch
          </h3>
          <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 divide-y divide-gray-100 dark:divide-white/5">
            {plan.files.map((f) => (
              <div key={f.path} className="flex items-center gap-3 px-3 py-2">
                <ActionBadge action={f.action} />
                <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate font-mono">{f.path}</span>
                {f.detail && <span className="text-xs text-gray-400 truncate max-w-[45%]">{f.detail}</span>}
              </div>
            ))}
            <div className="flex items-center gap-3 px-3 py-2">
              <GitBranch className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate font-mono">{plan.orphanBranch.name}</span>
              <ActionBadge action={plan.orphanBranch.action} />
            </div>
          </div>
          {plan.gitignore.length > 0 && (
            <p className="mt-1.5 text-xs text-gray-400">
              .gitignore additions: <span className="font-mono">{plan.gitignore.join(', ')}</span>
            </p>
          )}
        </div>

        {/* Members */}
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <FolderGit2 className="h-4 w-4" />
            Members
          </h3>
          <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 divide-y divide-gray-100 dark:divide-white/5">
            {plan.members.map((m) => {
              const isSkipped = skipped.has(m.name);
              return (
                <div key={m.name} className={`flex items-center gap-3 px-3 py-2 ${isSkipped ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={!isSkipped}
                    onChange={() => toggleSkip(m.name)}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    title="Include this member"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700 dark:text-gray-300 truncate">
                      {m.name} <span className="text-gray-400">({m.role})</span>
                    </p>
                    <p className="text-xs text-gray-400 truncate font-mono">{m.resolvedPath}</p>
                  </div>
                  <MemberActionBadge action={isSkipped ? 'skip' : m.action} />
                </div>
              );
            })}
          </div>
          {hasOutbound && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <Download className="h-3.5 w-3.5" />
              Some members would clone from a remote. This slice reports clones but does not run them automatically.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-2">
          <button
            onClick={handleApply}
            disabled={busy}
            className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Applying…
              </>
            ) : (
              'Apply group setup'
            )}
          </button>
          <button
            onClick={() => {
              setStep('input');
              setError(null);
            }}
            disabled={busy}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            ← Back to edit
          </button>
        </div>
      </div>
    );
  }

  // ─── Input step ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {isReconfigure
          ? 'Edit this group\u2019s name and members. The form is prefilled with the current group.json — nothing is written until you review the plan and confirm.'
          : 'Create a multi-repo group. Nothing is written until you review the plan and confirm — this mirrors the bootstrap import flow.'}
      </p>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Group name</label>
        <input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="acme-product"
          className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Members</label>
          <button
            type="button"
            onClick={addMember}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add member
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {members.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={m.name}
                onChange={(e) => updateMember(i, { name: e.target.value })}
                placeholder="name"
                className="h-9 w-1/4 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
              <input
                value={m.role}
                onChange={(e) => updateMember(i, { role: e.target.value })}
                placeholder="role"
                className="h-9 w-1/5 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
              <input
                value={m.remote}
                onChange={(e) => updateMember(i, { remote: e.target.value })}
                placeholder="git remote URL"
                className="h-9 flex-1 rounded-lg border border-gray-200 bg-white px-2 text-xs font-mono text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
              <button
                type="button"
                onClick={() => removeMember(i)}
                disabled={members.length === 1}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-gray-400"
                title="Remove member"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary" />
          Overwrite an existing group.json (force)
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={allowLocal} onChange={(e) => setAllowLocal(e.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary" />
          Allow local/file:// remotes (test harness)
        </label>
      </div>

      <div className="flex flex-col gap-2 pt-2">
        <button
          onClick={handlePreview}
          disabled={busy || !inputValid}
          className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Computing plan…
            </>
          ) : (
            'Preview plan'
          )}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ActionBadge({ action }: { action: 'create' | 'patch' | 'exists' }) {
  const styles: Record<string, string> = {
    create: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
    patch: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400',
    exists: 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400',
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[action]}`}>{action}</span>;
}

function MemberActionBadge({ action }: { action: 'register' | 'clone' | 'skip' }) {
  const styles: Record<string, string> = {
    register: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
    clone: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400',
    skip: 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400',
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[action]}`}>{action}</span>;
}
