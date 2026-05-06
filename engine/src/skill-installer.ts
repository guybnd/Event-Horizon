import fs from 'node:fs';
import path from 'node:path';

type Framework = 'auto' | 'copilot' | 'gemini' | 'generic';

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : 'true';
    args.set(key, value);
  }

  return {
    target: args.get('target') || process.cwd(),
    framework: (args.get('framework') || 'auto') as Framework,
    dryRun: args.get('dry-run') === 'true',
  };
}

function detectFramework(targetDir: string, requested: Framework): Exclude<Framework, 'auto'> {
  if (requested !== 'auto') {
    return requested;
  }

  if (fs.existsSync(path.join(targetDir, '.github'))) {
    return 'copilot';
  }

  if (fs.existsSync(path.join(targetDir, '.gemini'))) {
    return 'gemini';
  }

  return 'generic';
}

function destinationFor(targetDir: string, framework: Exclude<Framework, 'auto'>) {
  switch (framework) {
    case 'copilot':
      return path.join(targetDir, '.github', 'skills', 'event-horizon', 'SKILL.md');
    case 'gemini':
      return path.join(targetDir, '.gemini', 'skills', 'event-horizon.md');
    case 'generic':
      return path.join(targetDir, '.event-horizon', 'skills', 'event-horizon.md');
  }
}

function main() {
  const { target, framework, dryRun } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..', '..');
  const sourcePath = path.join(repoRoot, '.flux', 'skills', 'event-horizon-agent.md');
  const targetDir = path.resolve(target);
  const resolvedFramework = detectFramework(targetDir, framework);
  const destinationPath = destinationFor(targetDir, resolvedFramework);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Skill source file not found: ${sourcePath}`);
  }

  if (dryRun) {
    console.log(JSON.stringify({ sourcePath, targetDir, framework: resolvedFramework, destinationPath }, null, 2));
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
  console.log(`Installed Event Horizon skill to ${destinationPath}`);
}

main();
