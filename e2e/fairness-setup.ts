import { execSync } from 'node:child_process';
import { prepareFaceFixtures } from './face-fixtures.ts';
import { prepareVideoFixtures } from './video-fixtures.ts';
import { REPO } from './stack.ts';

/** Builds the diagnostics variant of the extension (build-diagnostics/) and the fixtures. */
export default async function setup(): Promise<void> {
  await prepareVideoFixtures();
  await prepareFaceFixtures();
  execSync('pnpm --filter @proctor/extension build:diagnostics', {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, PROCTOR_DIAGNOSTICS: '1', PROCTOR_BUILD_DIR: 'build-diagnostics' },
  });
}
