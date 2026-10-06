import {
  HOST_URL,
  acceptAndCompleteSetup,
  badgeText,
  expect,
  mockState,
  offscreenCount,
  startSession,
  test,
} from '../fixtures.ts';

// Phase 2 "Done when": a mock host page can start a session; declining consent means nothing
// starts; the indicator shows during capture.

const INDICATOR = '#proctor-recording-indicator';

test('host page starts a session; after consent and setup, capture runs with a visible indicator', async ({
  context,
  host,
  serviceWorker,
}) => {
  const consent = await startSession(context, host);
  await expect(host.locator('#events')).toContainText('started:sess-demo');
  expect((await mockState()).sessionFetches).toEqual(['sess-demo']);

  // Nothing runs while the notice is open.
  expect(await offscreenCount(serviceWorker)).toBe(0);
  expect(await badgeText(serviceWorker)).toBe('');

  const warnings = await acceptAndCompleteSetup(consent);
  expect(warnings.filter((w) => w.includes('face model unavailable'))).toEqual([]);

  await expect(host.locator('#events')).toContainText('ready');
  await expect(host.locator(INDICATOR)).toContainText('Camera and microphone on');
  expect(await badgeText(serviceWorker)).toBe('ON');
  expect(await offscreenCount(serviceWorker)).toBe(1);

  const { consents } = await mockState();
  expect(consents).toMatchObject([
    { sessionId: 'sess-demo', decision: 'accepted', noticeVersion: 'consent-notice-v1' },
  ]);
  expect(consents[0]?.ts).toBeGreaterThan(0);
});

test('declining consent starts nothing', async ({ context, host, serviceWorker }) => {
  const consent = await startSession(context, host);
  const closed = consent.waitForEvent('close');
  await consent.click('#decline');
  await closed;

  await expect(host.locator('#events')).toContainText('consent_declined');
  // Give any (incorrect) delayed start a chance to happen before asserting it did not.
  await host.waitForTimeout(1500);
  expect(await offscreenCount(serviceWorker)).toBe(0);
  expect(await badgeText(serviceWorker)).toBe('');
  await expect(host.locator(INDICATOR)).toHaveCount(0);
  await expect(host.locator('#events')).not.toContainText('ready');
  expect(context.pages().some((p) => p.url().includes('setup.html'))).toBe(false);
  expect((await mockState()).consents.map((c) => c.decision)).toEqual(['declined']);
});

test('closing the consent tab counts as declining', async ({ context, host, serviceWorker }) => {
  const consent = await startSession(context, host);
  await consent.close();
  await expect(host.locator('#events')).toContainText('consent_declined');
  expect(await offscreenCount(serviceWorker)).toBe(0);
});

test('agree stays disabled until the candidate confirms they read the notice', async ({
  context,
  host,
}) => {
  const consent = await startSession(context, host);
  await expect(consent.locator('#agree')).toBeDisabled();
  await expect(consent.locator('main')).toContainText('kept for 30 days');
  await consent.check('#agree-checkbox');
  await expect(consent.locator('#agree')).toBeEnabled();
});

test('ending the session turns the camera, microphone and indicator off', async ({
  context,
  host,
  serviceWorker,
}) => {
  await acceptAndCompleteSetup(await startSession(context, host));
  await expect(host.locator(INDICATOR)).toBeVisible();

  await host.click('#end');
  await expect(host.locator('#events')).toContainText('ended');
  await expect(host.locator(INDICATOR)).toHaveCount(0);
  expect(await badgeText(serviceWorker)).toBe('');
  await expect.poll(() => offscreenCount(serviceWorker)).toBe(0);
  expect((await mockState()).ends.map((e) => e.sessionId)).toEqual(['sess-demo']);
});

test('closing the exam tab ends capture', async ({ context, host, serviceWorker }) => {
  await acceptAndCompleteSetup(await startSession(context, host));
  await expect.poll(() => offscreenCount(serviceWorker)).toBe(1);
  await host.close();
  await expect.poll(() => offscreenCount(serviceWorker)).toBe(0);
  await expect.poll(() => badgeText(serviceWorker)).toBe('');
});

test('the indicator survives a reload of the exam page', async ({ context, host }) => {
  await acceptAndCompleteSetup(await startSession(context, host));
  await expect(host.locator(INDICATOR)).toBeVisible();
  await host.reload();
  await expect(host.locator(INDICATOR)).toBeVisible();
});

test('an API host that is not allow-listed is refused before anything opens', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`${HOST_URL}/?ext=${extensionId}&api=https://evil.example`);
  await page.click('#start');
  await expect(page.locator('#events')).toContainText('error:api_not_allowed');
  expect(context.pages().some((p) => p.url().includes('consent.html'))).toBe(false);
  expect((await mockState()).sessionFetches).toEqual([]);
});

test('an invalid session token is reported to the host page', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${HOST_URL}/?ext=${extensionId}&token=bad`);
  await page.click('#start');
  await expect(page.locator('#events')).toContainText('error:session_fetch_failed');
});
