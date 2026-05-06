type Framework = 'auto' | 'copilot' | 'gemini' | 'generic';

const path = require('node:path') as typeof import('node:path');
const { getWorkflowInstallStatus, installWorkspaceWorkflow } = require('./workflow-installer') as typeof import('./workflow-installer');

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
  };
}

async function main() {
  const { target, framework, dryRun } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..', '..');
  const targetDir = path.resolve(target);

  if (dryRun) {
    const status = await getWorkflowInstallStatus({ sourceRoot: repoRoot, targetDir, framework });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const result = await installWorkspaceWorkflow({ sourceRoot: repoRoot, targetDir, framework });
  console.log(`Installed Event Horizon workflow to ${result.skillInstalledPath}`);
  if (result.instructionsInstalledPath) {
    console.log(`Patched Copilot instructions at ${result.instructionsInstalledPath}`);
  }
}

void main();
