import {
  HOST_URL,
  acceptAndCompleteSetup,
  expect,
  rulesData,
  startSession,
  test,
} from '../fixtures.ts';

// Phase 3 "Done when": the manual test page triggers each of the 5 browser violation types,
// and the log contains no URLs, page text or keystrokes.

const anomalyTypes = async (sw: Parameters<typeof rulesData>[0]) =>
  (await rulesData(sw)).anomalies.map((a) => a.type);

test('the rule test page triggers all five browser violation types; the log is type + time only', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const host = await context.newPage();
  await host.goto(`${HOST_URL}/?ext=${extensionId}&token=tok-fastidle`);
  await acceptAndCompleteSetup(await startSession(context, host));
  await expect(host.locator('#events')).toContainText('ready');
  await host.bringToFront();

  // 1. Fullscreen exit
  await host.click('#fs-enter');
  await expect.poll(() => host.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await host.click('#fs-exit');
  await expect.poll(() => anomalyTypes(serviceWorker)).toContain('fullscreen_exit');

  // 2. Copy / paste (typing first: keystrokes must not reach the log)
  await host.click('#notes');
  await host.keyboard.type(' typed-by-candidate');
  await host.keyboard.press('ControlOrMeta+A');
  await host.keyboard.press('ControlOrMeta+C');
  await host.keyboard.press('ControlOrMeta+V');
  await expect.poll(() => anomalyTypes(serviceWorker)).toContain('copy_paste');

  // 3. Tab switch / window blur
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await expect.poll(() => anomalyTypes(serviceWorker)).toContain('tab_switch_or_blur');
  await other.close();
  await host.bringToFront();

  // 4. Refresh attempt: refresh shortcut, then a completed reload. The session continues.
  await host.keyboard.press('F5');
  await host.reload();
  await expect(host.locator('#proctor-recording-indicator')).toBeVisible();
  await expect.poll(() => anomalyTypes(serviceWorker)).toContain('refresh_attempt');

  // 5. Inactivity: no input for longer than the policy threshold (3 s for tok-fastidle).
  await expect.poll(() => anomalyTypes(serviceWorker), { timeout: 15_000 }).toContain('inactivity');

  const { log, anomalies } = await rulesData(serviceWorker);
  expect(new Set(anomalies.map((a) => a.type))).toEqual(
    new Set([
      'fullscreen_exit',
      'tab_switch_or_blur',
      'copy_paste',
      'refresh_attempt',
      'inactivity',
    ]),
  );

  // Privacy: type + timestamp only, nothing from the page, the URL or the keyboard.
  expect(log.length).toBeGreaterThan(0);
  for (const entry of log) expect(Object.keys(entry).sort()).toEqual(['ts', 'type']);
  for (const a of anomalies) expect(Object.keys(a).sort()).toEqual(['confidence', 'ts', 'type']);
  const json = JSON.stringify({ log, anomalies });
  for (const leak of [
    'SECRET-ANSWER-42',
    'typed-by-candidate',
    'Question 7',
    'localhost',
    'http',
    'tok-fastidle',
    extensionId,
    'Control',
    'KeyA',
    'F5',
  ]) {
    expect(json).not.toContain(leak);
  }

  // Rolling log covers at least the last 60 s (here: everything since activation).
  const now = Date.now();
  expect(log.every((e) => now - e.ts <= 60_000 + 5_000)).toBe(true);
});
