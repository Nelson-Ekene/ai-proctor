// Stability loop: runs the full e2e suite N times (default 20), stopping at the first failure.
// Usage: pnpm --filter @proctor/e2e loop [N]   (build the SDK and extension first)
import { spawnSync } from 'node:child_process';

const runs = Number(process.argv[2] ?? 20);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let passed = 0;

for (let i = 1; i <= runs; i++) {
  const runId = `loop-${stamp}-${String(i).padStart(2, '0')}`;
  const started = Date.now();
  // No --reporter flag: it would replace the configured HTML/JSON reports. PW_QUIET switches the
  // console reporter to "dot" instead.
  const result = spawnSync('pnpm exec playwright test', {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, PW_RUN_ID: runId, PW_QUIET: '1' },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.status !== 0) {
    console.log(
      `\nRun ${String(i)}/${String(runs)} FAILED after ${seconds}s (artifacts: ${runId}).`,
    );
    console.log(`Passed ${String(passed)}/${String(runs)} before the failure.`);
    process.exit(1);
  }
  passed += 1;
  console.log(`\nRun ${String(i)}/${String(runs)} passed in ${seconds}s.`);
}
console.log(`\nAll ${String(passed)}/${String(runs)} runs passed.`);
