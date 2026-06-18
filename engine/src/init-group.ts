#!/usr/bin/env node
/**
 * Event Horizon — init-group command
 * Creates (or previews) a multi-repo group from a parent repo.
 *
 * Usage:
 *   npm run init-group -w engine -- [--target <path>] [--name <group>] \
 *       [--member name:role:remote ...] [--apply] [--force] [--allow-local]
 *
 * Without --apply this prints the plan only (a dry run). With --apply it
 * performs the writes via applyGroupSetup. Members are given as
 * `name:role:remote` triples; the remote may contain colons (e.g. scp-like
 * git@host:path), so only the first two colons are treated as separators.
 */

import path from 'path';
import { planGroupSetup, applyGroupSetup, type GroupSetupInput } from './group-setup.js';
import type { GroupMember } from './group.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    const next = i !== -1 ? args[i + 1] : undefined;
    return next ? next : null;
  };
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const next = args[i + 1];
      if (args[i] === flag && next) out.push(next);
    }
    return out;
  };
  return {
    target: get('--target') ? path.resolve(get('--target')!) : process.cwd(),
    name: get('--name'),
    members: getAll('--member'),
    apply: args.includes('--apply'),
    force: args.includes('--force'),
    allowLocal: args.includes('--allow-local'),
  };
}

/** Parse `name:role:remote`, splitting on only the first two colons. */
function parseMember(spec: string): GroupMember {
  const first = spec.indexOf(':');
  const second = first === -1 ? -1 : spec.indexOf(':', first + 1);
  if (first === -1 || second === -1) {
    throw new Error(`Invalid --member '${spec}'. Expected name:role:remote`);
  }
  const name = spec.slice(0, first).trim();
  const role = spec.slice(first + 1, second).trim();
  const remote = spec.slice(second + 1).trim();
  if (!name || !role || !remote) {
    throw new Error(`Invalid --member '${spec}'. name, role, and remote are all required`);
  }
  return { name, role, remote };
}

function printPlan(plan: Awaited<ReturnType<typeof planGroupSetup>>) {
  console.log(`\nGroup setup plan for '${plan.groupName}'`);
  console.log(`  parent: ${plan.parentRoot}`);
  console.log(`  already configured: ${plan.alreadyConfigured ? 'yes' : 'no'}`);
  console.log('\n  Files:');
  for (const f of plan.files) console.log(`    [${f.action}] ${f.path}${f.detail ? ` — ${f.detail}` : ''}`);
  if (plan.gitignore.length > 0) console.log(`\n  .gitignore additions: ${plan.gitignore.join(', ')}`);
  console.log(`\n  Orphan docs branch: [${plan.orphanBranch.action}] ${plan.orphanBranch.name}`);
  console.log('\n  Members:');
  for (const m of plan.members) {
    console.log(`    [${m.action}] ${m.name} (${m.role}) → ${m.resolvedPath}${m.detail ? ` — ${m.detail}` : ''}`);
  }
  if (plan.warnings.length > 0) {
    console.log('\n  Warnings:');
    for (const w of plan.warnings) console.log(`    ! ${w}`);
  }
}

async function main() {
  const opts = parseArgs();

  if (!opts.name) {
    console.error('Error: --name <group> is required.');
    process.exit(1);
  }
  if (opts.members.length === 0) {
    console.error('Error: at least one --member name:role:remote is required.');
    process.exit(1);
  }

  let members: GroupMember[];
  try {
    members = opts.members.map(parseMember);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
    return;
  }

  const input: GroupSetupInput = {
    parentRoot: opts.target,
    groupName: opts.name,
    members,
    force: opts.force,
    allowLocalRemotes: opts.allowLocal,
  };

  try {
    if (!opts.apply) {
      const plan = await planGroupSetup(input);
      printPlan(plan);
      console.log('\nDry run — pass --apply to perform these actions.\n');
      return;
    }

    const result = await applyGroupSetup(input);
    console.log(`\n✓ Group '${result.groupName}' configured at ${result.parentRoot}`);
    console.log(`  group.json written: ${result.wroteConfig}`);
    console.log(`  .gitignore patched: ${result.patchedGitignore}`);
    console.log(`  store scaffolded:   ${result.scaffoldedStore}`);
    console.log('  Members:');
    for (const m of result.members) {
      console.log(`    ${m.ok ? '✓' : '✗'} ${m.name} (${m.action})${m.error ? ` — ${m.error}` : ''}`);
    }
    console.log('');
  } catch (err: any) {
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
  }
}

main();
