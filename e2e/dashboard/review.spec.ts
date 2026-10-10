import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { DASHBOARD_API_URL, SEED_PASSWORD } from '../settings.ts';

// BUILD_PLAN Phase 8 "Done when": a reviewer opens a seeded session and traces every point of
// the score to a violation and its evidence in a few clicks. Real API, Postgres and MinIO.

/** Opt-in screenshots for manual review: DASHBOARD_SCREENSHOTS=<dir>. */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.DASHBOARD_SCREENSHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function signIn(page: Page, email = 'reviewer@proctor.test'): Promise<void> {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('table', { name: 'Sessions ranked by risk' })).toBeVisible();
}

async function apiToken(email: string): Promise<string> {
  const res = await fetch(`${DASHBOARD_API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  return ((await res.json()) as { token: string }).token;
}

test('sessions are ranked by risk with band badges', async ({ page }) => {
  await signIn(page);
  const rows = page.getByRole('table', { name: 'Sessions ranked by risk' }).getByRole('row');
  await expect(rows).toHaveCount(5); // header + 4 demo sessions
  await expect(rows.nth(1)).toContainText('demo-candidate-2');
  await expect(rows.nth(1)).toContainText('High risk');
  await expect(rows.nth(2)).toContainText('demo-candidate-1');
  await expect(rows.nth(2)).toContainText('49.0');
  await expect(rows.nth(2)).toContainText('Medium risk');
  await expect(rows.nth(4)).toContainText('Low risk');

  await snap(page, 'sessions');
  await page.getByLabel('Risk band').selectOption('high');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('demo-candidate-2');
});

test('a reviewer traces the score to violations and evidence in a few clicks', async ({ page }) => {
  await signIn(page);
  let clicks = 0;
  const click = async (locator: ReturnType<Page['getByRole']>) => {
    clicks += 1;
    await locator.click();
  };

  // Click 1: open the session.
  await click(page.getByRole('link', { name: 'demo-candidate-1' }));
  await expect(page.getByTestId('risk-score')).toHaveText('49.0');
  await expect(page.getByText('Medium risk').first()).toBeVisible();

  // The category table matches the PRD sample: 50/60/25 at 40/40/20 = 49.0.
  const categories = page.getByRole('table', { name: 'Contribution by category' }).getByRole('row');
  await expect(categories.nth(1)).toContainText(/Browser\s*50\s*50\.0\s*40%\s*20\.0/);
  await expect(categories.nth(2)).toContainText(/Video\s*60\s*60\.0\s*40%\s*24\.0/);
  await expect(categories.nth(3)).toContainText(/Audio\s*25\s*25\.0\s*20%\s*5\.0/);

  // Every point comes from a listed violation: the per-violation points add up to each category.
  const flagged = page.getByRole('table', { name: 'Flagged moments' });
  const rows = flagged.getByRole('row');
  await expect(rows).toHaveCount(9); // header + 8 violations
  const perCategory: Record<string, number> = {};
  for (let i = 1; i < 9; i++) {
    const cells = rows.nth(i).getByRole('cell');
    const category = (await cells.nth(2).textContent()) ?? '';
    perCategory[category] = (perCategory[category] ?? 0) + Number(await cells.nth(6).textContent());
  }
  expect(perCategory.Browser).toBe(50);
  expect(perCategory.Video).toBe(60);
  expect(Math.round((perCategory.Audio ?? 0) * 100) / 100).toBe(25);

  // Click 2: a video violation shows its real frames (decoded from MinIO via signed URLs) and
  // its browser event window.
  await click(flagged.getByRole('button', { name: 'Phone in view' }).first());
  const evidence = page.getByRole('region', { name: 'Evidence' });
  await expect(evidence).toContainText('Points: 30 × 1.00 = 30');
  const frames = evidence.getByRole('img');
  await expect(frames).toHaveCount(2);
  for (const frame of await frames.all()) {
    await expect(frame).toHaveAttribute('src', /X-Amz-Signature=/);
    await expect
      .poll(() => frame.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(320);
  }
  await expect(evidence.getByText('Browser events from -30.0 s to +15.0 s')).toBeVisible();
  await snap(page, 'report-phone');

  // Click 3: a browser violation shows the event sequence (type + time only).
  await click(flagged.getByRole('button', { name: 'Switched tab or window' }).first());
  const events = evidence.getByRole('list', { name: 'Browser events' });
  await expect(events).toContainText('Exam tab hidden');
  await expect(events).toContainText('Exam tab visible again');

  // Click 4 (timeline): a speech moment has a playable clip.
  await click(page.getByRole('button', { name: /^Speech at/ }).first());
  const audio = evidence.getByLabel(/Audio clip at/);
  await expect(audio).toHaveAttribute('src', /X-Amz-Signature=/);
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState >= 1 && a.duration))
    .toBeCloseTo(3, 1);

  expect(clicks).toBeLessThanOrEqual(4);

  // Every view above was audit-logged by the API.
  const audit = (await (
    await fetch(`${DASHBOARD_API_URL}/v1/audit?limit=100`, {
      headers: { authorization: `Bearer ${await apiToken('admin@proctor.test')}` },
    })
  ).json()) as { action: string }[];
  expect(audit.filter((a) => a.action === 'evidence.view').length).toBeGreaterThanOrEqual(5);
  expect(audit.some((a) => a.action === 'report.view')).toBe(true);
});

test('exports the report as PDF and JSON', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'demo-candidate-1' }).click();
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  const pdfBytes = await readFile(await pdf.path());
  expect(pdfBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');

  const [json] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  const report = JSON.parse(await readFile(await json.path(), 'utf8')) as {
    risk: number;
    band: string;
    policySnapshot: unknown;
  };
  expect(report.risk).toBe(49);
  expect(report.band).toBe('medium');
  expect(report.policySnapshot).toBeTruthy();
});

test('an admin previews the score impact of a policy change', async ({ page }) => {
  await signIn(page, 'admin@proctor.test');
  await page.getByRole('link', { name: 'Policy' }).click();
  const preview = page.getByRole('region', { name: 'Preview score impact' });
  await preview.getByLabel('Sample session').selectOption({ label: 'demo-candidate-1 (49.0)' });
  await expect(page.getByTestId('preview-current')).toHaveText('49.0');

  await page.getByRole('spinbutton', { name: 'Browser', exact: true }).fill('20');
  await expect(page.getByTestId('weight-sum')).toContainText('Total 80%');
  await expect(page.getByRole('button', { name: 'Save new version' })).toBeDisabled();
  await page.getByRole('spinbutton', { name: 'Video', exact: true }).fill('60');
  // 0.2 x 50 + 0.6 x 60 + 0.2 x 25 = 51.0
  await expect(page.getByTestId('preview-new')).toHaveText('51.0');
  await snap(page, 'policy-preview');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByTestId('preview-new')).toHaveText('49.0');
});
