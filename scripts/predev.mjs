import { createInterface } from 'readline';

async function main() {
  let running = false;
  try {
    const res = await fetch('http://localhost:3067/api/health');
    running = res.ok;
  } catch {
    return;
  }

  if (!running) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('Engine already running on :3067. Shut it down? [Y/n] ', resolve);
  });
  rl.close();

  if (answer && answer.toLowerCase() !== 'y') {
    console.log('Aborted.');
    process.exit(1);
  }

  await fetch('http://localhost:3067/api/shutdown', { method: 'POST' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
}

main();
