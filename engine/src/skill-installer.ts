import { log } from './log.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkflowInstallStatus, installWorkspaceWorkflow } from './workflow-installer.js';

type Framework = 'auto' | 'copilot' | 'antigravity' | 'gemini' | 'cursor' | 'cline' | 'windsurf' | 'claude' | 'generic';

const __dir = (() => {
  // @ts-ignore — __dirname exists in CJS bundles
  if (typeof __dirname === 'string' && path.isAbsolute(__dirname)) return __dirname;
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch {}
  return path.join(process.cwd(), 'src');
})();

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const nextToken = argv[index + 1];
    const value = nextToken && !nextToken.startsWith('--') ? nextToken : 'true';
    args.set(key, value);
  }

  return {
    target: args.get('target') || process.cwd(),
    framework: (args.get('framework') || 'auto') as Framework,
    dryRun: args.get('dry-run') === 'true',
    force: args.get('force') === 'true',
  };
}

async function main() {
  const { target, framework, dryRun, force } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dir, '..', '..');
  const targetDir = path.resolve(target);

  if (dryRun) {
    const status = await getWorkflowInstallStatus({ sourceRoot: repoRoot, targetDir, framework });
    log.info(JSON.stringify(status, null, 2));
    return;
  }

  const result = await installWorkspaceWorkflow({ sourceRoot: repoRoot, targetDir, framework, force });
  log.info(`Installed Event Horizon workflow to ${result.skillInstalledPath}`);
  if (result.instructionsInstalledPath) {
    log.info(`Patched Copilot instructions at ${result.instructionsInstalledPath}`);
  }
}

void main();
