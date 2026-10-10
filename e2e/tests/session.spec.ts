import {
  HOST_URL,
  acceptAndCompleteSetup,
  badgeText,
  expect,
  failNextConsents,
  mockState,
  offscreenCount,
  startSession,
  storedStatus,
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

  const { warnings } = await acceptAndCompleteSetup(consent);
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

test('closing the exam tab ends the session and turns media off', async ({
  context,
  host,
  serviceWorker,
}) => {
  await acceptAndCompleteSetup(await startSession(context, host));
  await expect.poll(() => offscreenCount(serviceWorker)).toBe(1);
  await host.close();
  await expect.poll(() => storedStatus(serviceWorker)).toBe('ended');
  await expect.poll(() => offscreenCount(serviceWorker)).toBe(0);
  await expect.poll(() => badgeText(serviceWorker)).toBe('');
  // The end record is uploaded after local teardown (badge, media), so wait for it to arrive
  // instead of reading the mock once (that race failed run 2 of the stability loop).
  await expect
    .poll(async () => (await mockState()).ends.map((e) => e.sessionId))
    .toEqual(['sess-demo']);
});

test('a page refresh does NOT end the session; capture and the indicator continue', async ({
  context,
  host,
  serviceWorker,
}) => {
  await acceptAndCompleteSetup(await startSession(context, host));
  await expect(host.locator(INDICATOR)).toBeVisible();

  await host.reload();
  await expect(host.locator(INDICATOR)).toBeVisible();
  // Let any (incorrect) tab-close handling run before asserting it did not.
  await host.waitForTimeout(1000);
  expect(await storedStatus(serviceWorker)).toBe('active');
  expect(await offscreenCount(serviceWorker)).toBe(1);
  expect(await badgeText(serviceWorker)).toBe('ON');
  expect((await mockState()).ends).toEqual([]);
});

test('accept fails cleanly when the server is unreachable, and retry proceeds', async ({
  context,
  host,
  serviceWorker,
}) => {
  const consent = await startSession(context, host);
  await failNextConsents(1);
  await consent.check('#agree-checkbox');
  await consent.click('#agree');

  await expect(consent.locator('#error')).toBeVisible();
  await expect(consent.locator('#error')).toContainText(
    "Couldn't reach the server, please try again.",
  );
  await expect(consent.locator('#retry')).toBeEnabled();
  expect(await storedStatus(serviceWorker)).toBe('awaiting_consent');
  expect(await offscreenCount(serviceWorker)).toBe(0);
  expect(consent.url()).toContain('consent.html');

  await consent.click('#retry');
  await consent.waitForURL(/setup\.html/);
  expect(await storedStatus(serviceWorker)).toBe('setup');
  expect((await mockState()).consents.map((c) => c.decision)).toEqual(['accepted']);
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
