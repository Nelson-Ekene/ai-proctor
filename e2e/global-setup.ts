import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps artifacts of every failing run; prunes passing runs beyond the most recent few so
// timestamped folders do not pile up (e.g. after a 20x stability loop).
const KEEP_PASSING_RUNS = 5;
const here = dirname(fileURLToPath(import.meta.url));

async function failed(reportDir: string): Promise<boolean> {
  try {
    const json = JSON.parse(await readFile(join(reportDir, 'results.json'), 'utf8')) as {
      stats?: { unexpected?: number; flaky?: number };
    };
    return (json.stats?.unexpected ?? 0) > 0 || (json.stats?.flaky ?? 0) > 0;
  } catch {
    return true; // no summary (crashed or interrupted run): keep it
  }
}

export default async function globalSetup(): Promise<void> {
  const reports = join(here, 'playwright-report');
  const results = join(here, 'test-results');
  let runs: { name: string; mtime: number }[];
  try {
    const names = await readdir(reports);
    runs = await Promise.all(
      names.map(async (name) => ({ name, mtime: (await stat(join(reports, name))).mtimeMs })),
    );
  } catch {
    return; // nothing yet
  }
  const passing: string[] = [];
  for (const run of runs.sort((a, b) => b.mtime - a.mtime)) {
    if (!(await failed(join(reports, run.name)))) passing.push(run.name);
  }
  for (const name of passing.slice(KEEP_PASSING_RUNS)) {
    await rm(join(reports, name), { recursive: true, force: true });
    await rm(join(results, name), { recursive: true, force: true });
  }
}
