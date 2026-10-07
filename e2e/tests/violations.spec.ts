import {
  expect,
  mergedViolations,
  offscreenCount,
  rulesData,
  startActiveSession,
  storedStatus,
  test,
} from '../fixtures.ts';

// Exact-count checks on how real browser actions turn into violations.

test('a tab switch yields exactly one violation', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const host = await startActiveSession(context, extensionId);

  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await expect
    .poll(async () => (await rulesData(serviceWorker)).anomalies.map((a) => a.type))
    .toContain('tab_switch_or_blur');
  await host.bringToFront();
  await other.close();
  // Let every signal of the round trip arrive (content script + chrome.tabs + chrome.windows).
  await host.waitForTimeout(1500);

  const data = await rulesData(serviceWorker);
  expect(data.anomalies.filter((a) => a.type === 'tab_switch_or_blur')).toHaveLength(1);
  const tabSwitches = mergedViolations(data).filter((v) => v.type === 'tab_switch_or_blur');
  expect(tabSwitches).toHaveLength(1);
  expect(tabSwitches[0]?.count).toBe(1);
});

test('a keyboard refresh yields one merged violation with count 2', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const host = await startActiveSession(context, extensionId);

  // Mark the document so we can tell whether the key press itself reloaded the page.
  await host.evaluate(() => {
    (window as unknown as { __beforeRefresh?: boolean }).__beforeRefresh = true;
  });
  await host.keyboard.press('F5');
  await host.waitForTimeout(1000);
  const reloadedByKey = await host
    .evaluate(() => (window as unknown as { __beforeRefresh?: boolean }).__beforeRefresh !== true)
    .catch(() => true);
  // Automated key input may not trigger the browser's reload shortcut; complete the refresh the
  // way the browser would.
  if (!reloadedByKey) await host.reload();
  test.info().annotations.push({
    type: 'refresh',
    description: reloadedByKey ? 'F5 reloaded the page' : 'F5 detected; reload completed by test',
  });
  await expect(host.locator('#proctor-recording-indicator')).toBeVisible();

  await expect
    .poll(
      async () =>
        (await rulesData(serviceWorker)).anomalies.filter((a) => a.type === 'refresh_attempt')
          .length,
    )
    .toBe(2);
  const refreshes = mergedViolations(await rulesData(serviceWorker)).filter(
    (v) => v.type === 'refresh_attempt',
  );
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]?.count).toBe(2);
  expect(await storedStatus(serviceWorker)).toBe('active');
});

test('a normal tab close does not create a refresh violation', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const host = await startActiveSession(context, extensionId);
  await host.click('#notes'); // some ordinary activity first
  await host.close();
  await expect.poll(() => storedStatus(serviceWorker)).toBe('ended');
  await expect.poll(() => offscreenCount(serviceWorker)).toBe(0);

  const data = await rulesData(serviceWorker);
  expect(data.anomalies.map((a) => a.type)).not.toContain('refresh_attempt');
  expect(data.log.map((e) => e.type)).not.toContain('refresh_attempt');
  expect(mergedViolations(data).some((v) => v.type === 'refresh_attempt')).toBe(false);
});
